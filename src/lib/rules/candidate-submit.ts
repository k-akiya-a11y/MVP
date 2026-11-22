import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { findMasterProblems } from "../ai/validate";
import { loadPastQuality } from "../retrieval/past-quality-load";
import { CREATE_UNKNOWN_MESSAGE, createRuleFromCandidateSchema } from "./candidate-schema";
import { readAvailableMasters } from "./editor-load";
import { formatEditorIssues, UUID } from "./editor-schema";

/** 保存の結果。not_saved は「この操作では保存していない」ことが確かな場合だけ。確かでない場合は unknown */
export type CreateRuleResult =
  | { ok: true; ruleId: string; message: string }
  | {
      ok: false;
      outcome: "not_saved";
      code: "invalid" | "unauthenticated" | "not_found" | "stale" | "master" | "conflict" | "denied" | "rejected" | "unavailable";
      message: string;
    }
  | { ok: false; outcome: "unknown"; code: "unknown"; message: string };

const notSaved = (code: Extract<CreateRuleResult, { outcome: "not_saved" }>["code"], message: string): CreateRuleResult => ({
  ok: false,
  outcome: "not_saved",
  code,
  message,
});
const unknown = (): CreateRuleResult => ({ ok: false, outcome: "unknown", code: "unknown", message: CREATE_UNKNOWN_MESSAGE });

/** 読込の段階（保存前）の失敗。利用者には固定文だけを見せる */
const UNAVAILABLE_MESSAGE = "保存の準備に必要な情報を読み込めなかったため、保存していません。時間をおいてもう一度お試しください。";

/** DB が文を実行して拒否したことが確かなエラー（関数ごと巻き戻る）。この場合は保存されていない */
const isDefiniteRejection = (code: unknown) =>
  typeof code === "string" && (/^(22|23)[0-9A-Z]{3}$/.test(code) || code === "P0001");

/**
 * 過去仕訳の候補から、新しい顧客ルールを「提案中」の版1として作る。書込は RPC create_rule_from_past_candidate の
 * 1回だけで、親（journal_rules）と版1（journal_rule_versions）は DB 側の1つのトランザクションで入る。
 *
 * - 入力は strict。作成者・状態・作成元・版・有効フラグ・その他の条件や処理は受け付けない（DB 関数が決める）。
 * - ログインは auth.getUser() で確認する。顧客・過去仕訳・マスタは担当者の権限（RLS）で読み直し、
 *   候補（取引先キー・向き・科目）が最新の過去仕訳の「科目が1種類だけ」の候補と一致すること、
 *   科目・税区分が有効なマスタにあることを、既存の読込・検証（loadPastQuality / findMasterProblems）で確認する。
 *   DB 関数も同じ確認を保存と同じトランザクションでやり直す。
 * - 依頼ID（ルールID）は画面が固定して渡す。同じIDの2回目は主キー重複（23505）で拒否され、何も上書きしない。
 *   自動の再試行はしない。既存の同じ条件のルールとの重複は確認しない（人が一覧で確認する）。
 * - 通信の失敗や応答の欠落など、保存されたか確かでないときは unknown を返す。
 */
export async function createRuleFromCandidate(client: SupabaseClient, rawInput: unknown): Promise<CreateRuleResult> {
  const parsed = createRuleFromCandidateSchema.safeParse(rawInput);
  if (!parsed.success) return notSaved("invalid", formatEditorIssues(parsed.error));
  const input = parsed.data;

  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return notSaved("unauthenticated", "ログインが確認できないため、保存していません。ログインし直してください。");
    z.string().regex(UUID).parse(data.user.id);
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  // ここまでは書込をしていない。読込の失敗はすべて「保存していない」と言える
  try {
    const quality = await loadPastQuality(client, input.customerId);
    if (!quality) return notSaved("not_found", "顧客が見つからないか、この顧客を扱う権限がないため、保存していません。");
    const stillCandidate = quality.report.stableAccountCandidates.some(
      (c) => c.partnerKey === input.partnerKey && c.direction === input.direction && c.accountItemId === input.accountItemId,
    );
    if (!stillCandidate) {
      return notSaved(
        "stale",
        "この候補は、最新の過去仕訳と一致しなくなっているため（科目が複数に分かれた、取引先キーが見つからない等）、保存していません。過去仕訳の画面で確認し直してください。",
      );
    }

    const masters = await readAvailableMasters(client, input.customerId);
    const problems = findMasterProblems(
      { accountItemId: input.accountItemId, taxCode: input.taxCode, partnerId: null, itemId: null, sectionId: null, tagIds: [] },
      masters,
    );
    if (problems.length > 0) {
      return notSaved("master", `勘定科目と税区分は現在の有効なマスタにある必要があります: ${problems.join("、")}。保存していません。`);
    }
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  let result;
  try {
    // 送るのはこの7つだけ。作成者・状態・作成元・版は DB 関数が決める
    result = await client.rpc("create_rule_from_past_candidate", {
      p_customer_id: input.customerId,
      p_rule_id: input.requestId,
      p_partner_key: input.partnerKey,
      p_direction: input.direction,
      p_account_item_id: input.accountItemId,
      p_tax_code: input.taxCode,
      p_priority: input.priority,
    });
  } catch {
    return unknown();
  }
  if (result.error) {
    const code: unknown = result.error.code;
    if (code === "23505") {
      return notSaved(
        "conflict",
        "この依頼IDは、すでにルールの作成に使われているため、今回の操作では保存していません（既存のルールは上書きしていません）。顧客ルールの一覧で、このIDのルールがあるか確認してください。",
      );
    }
    if (code === "42501") return notSaved("denied", "このルールを保存する権限がないため、保存していません。");
    if (isDefiniteRejection(code)) {
      return notSaved("rejected", "データベースが内容を受け付けなかったため、保存していません（過去仕訳やマスタが保存の直前に変わった可能性があります）。画面を開き直して確認してください。");
    }
    return unknown();
  }

  // 戻り値が自分の渡した依頼IDと一致することを確かめる。違えば保存されたか確かでない
  const returned = z.string().regex(UUID).safeParse(result.data);
  if (!returned.success || returned.data.toLowerCase() !== input.requestId.toLowerCase()) return unknown();

  return {
    ok: true,
    ruleId: input.requestId,
    message:
      "新しいルールを「提案中」の版1として保存しました。まだ有効ではなく、仕訳候補の照合には使われません。保存時点で過去仕訳が候補と一致していたことを確認しただけで、その後も変わらないことを示すものではありません。",
  };
}
