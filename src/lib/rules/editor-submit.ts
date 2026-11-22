import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { findMasterProblems } from "../ai/validate";
import {
  readAvailableMasters,
  readVisibleCustomer,
  readWallets,
  RULE_VERSION_COLUMNS,
  ruleVersionRowSchema,
  toEditorRule,
  type RuleVersionRow,
} from "./editor-load";
import { formatEditorIssues, RULE_STATUS_LABEL, ruleEditorSubmitSchema, UUID, type RuleEditorInput, type RuleStatus } from "./editor-schema";

/** 保存の結果。notSaved は「この操作では保存していない」ことが確かな場合だけ。確かでない場合は unknown */
export type RuleSubmitResult =
  | { ok: true; ruleId: string; version: number; status: RuleStatus; message: string }
  | {
      ok: false;
      outcome: "not_saved";
      code: "invalid" | "unauthenticated" | "not_found" | "stale" | "conflict" | "master" | "wallet" | "denied" | "rejected" | "unavailable";
      message: string;
    }
  | { ok: false; outcome: "unknown"; code: "unknown"; message: string };

export const UNKNOWN_OUTCOME_MESSAGE =
  "保存できたかどうかを確認できませんでした。保存されていない、とは言い切れません。自動では再送しません。ページを再読み込みして、ルールの版が増えているか確認してから、必要な場合だけもう一度操作してください。";

const notSaved = (code: Extract<RuleSubmitResult, { outcome: "not_saved" }>["code"], message: string): RuleSubmitResult => ({
  ok: false,
  outcome: "not_saved",
  code,
  message,
});
const unknown = (): RuleSubmitResult => ({ ok: false, outcome: "unknown", code: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });

/** 読込の段階（保存前）の失敗。利用者には固定文だけを見せる */
const UNAVAILABLE_MESSAGE = "保存の準備に必要な情報を読み込めなかったため、保存していません。時間をおいてもう一度お試しください。";

/** DB が行を拒否したことが確かなエラー（文を実行して失敗した）。この場合は保存されていない */
const isDefiniteRejection = (code: unknown) =>
  typeof code === "string" && (/^(22|23)[0-9A-Z]{3}$/.test(code) || code === "P0001");

/**
 * 既存ルールの新しい版を1つ追加する（journal_rule_versions への INSERT だけ。親・既存の版は更新も削除もしない）。
 *
 * - 権限: ログインした担当者の権限（RLS）で動く。顧客・親ルール・現在の版は、その権限で見える行だけを使い、
 *   すべて customer_id を明示して絞り、返った行の顧客も照合する。作成者は auth.getUser() の結果で決め、
 *   作成元は常に staff（担当者の入力）、版番号は expectedVersion + 1。入力に含まれたこれらの値は受け付けない。
 * - 競合: 現在の版が expectedVersion と違えば保存しない。同時に同じ版を入れた場合は主キーが片方を拒否する（23505）。
 *   どちらも自動では再試行しない。
 * - 有効にするときだけ、最新の有効なマスタで処理内容を検証する（無効化は、古い科目が無効でも止めない）。
 * - 通信の失敗や応答の欠落など、保存されたか確かでないときは unknown を返す。
 */
export async function submitRuleVersion(client: SupabaseClient, rawInput: unknown): Promise<RuleSubmitResult> {
  const parsed = ruleEditorSubmitSchema.safeParse(rawInput);
  if (!parsed.success) return notSaved("invalid", formatEditorIssues(parsed.error));
  const input = parsed.data;

  let userId: string;
  try {
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return notSaved("unauthenticated", "ログインが確認できないため、保存していません。ログインし直してください。");
    userId = z.string().regex(UUID).parse(data.user.id);
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  // ここまでは書込をしていない。読込の失敗はすべて「保存していない」と言える
  let current: RuleVersionRow;
  try {
    const customer = await readVisibleCustomer(client, input.customerId);
    if (!customer) return notSaved("not_found", "顧客が見つからないか、この顧客を扱う権限がないため、保存していません。");

    const parent = await client
      .from("journal_rules")
      .select("id, customer_id")
      .eq("id", input.ruleId)
      .eq("customer_id", input.customerId)
      .maybeSingle();
    if (parent.error) throw new Error("parent read failed");
    const parentRow = z.object({ id: z.string(), customer_id: z.string() }).nullable().parse(parent.data);
    if (!parentRow) return notSaved("not_found", "ルールが見つからないか、この顧客のルールではないため、保存していません。");
    if (parentRow.id !== input.ruleId || parentRow.customer_id !== input.customerId) throw new Error("parent mismatch");

    const versions = await client
      .from("journal_rule_versions")
      .select(RULE_VERSION_COLUMNS)
      .eq("rule_id", input.ruleId)
      .eq("customer_id", input.customerId)
      .order("version", { ascending: false })
      .limit(1);
    if (versions.error) throw new Error("version read failed");
    const rows = z.array(ruleVersionRowSchema).parse(versions.data);
    const latest = rows[0];
    if (!latest) throw new Error("no version");
    if (latest.rule_id !== input.ruleId || latest.customer_id !== input.customerId) throw new Error("version mismatch");
    current = latest;
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  if (current.version !== input.expectedVersion) {
    return notSaved(
      "stale",
      `このルールは編集を始めたあとに更新されています（編集元: 版${input.expectedVersion}、現在: 版${current.version}）。保存していません。最新を読み込み直して、変更内容を確認してからやり直してください。`,
    );
  }

  try {
    // 口座は無効化のときも自分の顧客のものだけ（外部キーでも拒否されるが、結果を分かりやすく返すため先に確認する）
    if (input.cond.walletId !== null) {
      const wallets = await readWallets(client, input.customerId);
      if (!wallets.some((w) => w.id === input.cond.walletId)) {
        return notSaved("wallet", "指定された口座がこの顧客にないため、保存していません。");
      }
    }

    if (input.status === "active") {
      const masters = await readAvailableMasters(client, input.customerId);
      const problems = findMasterProblems(
        {
          accountItemId: input.action.accountItemId,
          taxCode: input.action.taxCode,
          partnerId: input.action.partnerId,
          itemId: input.action.itemId,
          sectionId: input.action.sectionId,
          tagIds: input.action.tagIds,
        },
        masters,
      );
      if (problems.length > 0) {
        return notSaved("master", `有効にするには、処理内容がすべて現在のマスタにある必要があります: ${problems.join("、")}。保存していません。`);
      }
    }
  } catch {
    return notSaved("unavailable", UNAVAILABLE_MESSAGE);
  }

  const nextVersion = input.expectedVersion + 1;
  const row = buildInsertRow(input, nextVersion, userId);

  let result;
  try {
    result = await client.from("journal_rule_versions").insert(row).select(RULE_VERSION_COLUMNS).single();
  } catch {
    return unknown();
  }
  if (result.error) {
    const code: unknown = result.error.code;
    if (code === "23505") {
      return notSaved("conflict", "同じ版が別の操作で先に保存されたため、保存していません。最新を読み込み直して、変更内容を確認してからやり直してください。");
    }
    if (code === "42501") return notSaved("denied", "このルールを保存する権限がないため、保存していません。");
    if (isDefiniteRejection(code)) return notSaved("rejected", "データベースが入力を受け付けなかったため、保存していません。入力内容を確認してください。");
    return unknown();
  }

  // 戻り値の識別と来歴（規則・顧客・版・状態・作成元・作成者）が自分の書いた内容と一致することを確かめる（条件・処理の各列までは比べない）。違えば保存されたか確かでない
  const saved = ruleVersionRowSchema.safeParse(result.data);
  if (
    !saved.success ||
    saved.data.rule_id !== input.ruleId ||
    saved.data.customer_id !== input.customerId ||
    saved.data.version !== nextVersion ||
    saved.data.status !== input.status ||
    saved.data.source !== "staff" ||
    saved.data.created_by !== userId
  ) {
    return unknown();
  }
  const status = toEditorRule(saved.data).status;
  return {
    ok: true,
    ruleId: input.ruleId,
    version: nextVersion,
    status,
    message: `版${nextVersion}を「${RULE_STATUS_LABEL[status]}」として保存しました。以前の版は残っています。`,
  };
}

function buildInsertRow(input: RuleEditorInput, version: number, userId: string) {
  return {
    rule_id: input.ruleId,
    version,
    customer_id: input.customerId,
    priority: input.priority,
    status: input.status,
    source: "staff" as const,
    cond_partner_key: input.cond.partnerKey,
    cond_description_keyword: input.cond.descriptionKeyword,
    cond_amount_min: input.cond.amountMin,
    cond_amount_max: input.cond.amountMax,
    cond_wallet_id: input.cond.walletId,
    cond_direction: input.cond.direction,
    account_item_id: input.action.accountItemId,
    tax_code: input.action.taxCode,
    partner_id: input.action.partnerId,
    item_id: input.action.itemId,
    section_id: input.action.sectionId,
    tag_ids: input.action.tagIds,
    description_template: input.action.descriptionTemplate,
    valid_from: input.validFrom,
    valid_to: input.validTo,
    created_by: userId,
  };
}
