import type { SupabaseClient } from "@supabase/supabase-js";
import { loadPastQuality } from "../retrieval/past-quality-load";
import type { StableAccountCandidate } from "../retrieval/past-quality";
import { readAvailableMasters, type MasterOption } from "./editor-load";
import type { CandidateQuery } from "./candidate-schema";

/** 読込の失敗を利用者に見せる固定文。SDK・検証エラーの中身は含めない */
export const CANDIDATE_LOAD_FAILED_MESSAGE =
  "候補の元になる過去仕訳やマスタを読み込めなかったため、表示できません。時間をおいて再読み込みしてください。";

export class CandidateLoadError extends Error {
  constructor() {
    super(CANDIDATE_LOAD_FAILED_MESSAGE);
    this.name = "CandidateLoadError";
  }
}

export type CandidateSource =
  | {
      kind: "ready";
      customer: { id: string; name: string };
      candidate: StableAccountCandidate;
      account: MasterOption;
      /** 有効な税区分だけ（人が選ぶ。既定値は持たない） */
      taxOptions: MasterOption[];
    }
  | {
      kind: "blocked";
      customer: { id: string; name: string };
      /** missing: 指定の候補が最新の過去仕訳にない・変わった（科目が複数になった、キーが消えた等）。account_unavailable: 科目が有効なマスタにない */
      reason: "candidate_missing" | "account_unavailable";
    };

/**
 * 新規ルール画面の元データ（読取専用）。ログインした担当者の権限（RLS）で過去仕訳を読み直し、
 * URL の候補（取引先キー・向き・科目）が「いま」の候補と完全に一致するときだけ ready にする。
 * 顧客が見えないときは null。読込の失敗は CandidateLoadError（固定文）にして投げる。
 */
export async function loadCandidateSource(
  client: SupabaseClient,
  customerId: string,
  query: Pick<CandidateQuery, "key" | "direction" | "accountId">,
): Promise<CandidateSource | null> {
  try {
    const quality = await loadPastQuality(client, customerId);
    if (!quality) return null;

    const candidate = quality.report.stableAccountCandidates.find(
      (c) => c.partnerKey === query.key && c.direction === query.direction && c.accountItemId === query.accountId,
    );
    if (!candidate) return { kind: "blocked", customer: quality.customer, reason: "candidate_missing" };

    const masters = await readAvailableMasters(client, customerId);
    const account = masters.find((m) => m.kind === "account_item" && m.id === candidate.accountItemId);
    if (!account) return { kind: "blocked", customer: quality.customer, reason: "account_unavailable" };

    const taxOptions = masters.filter((m) => m.kind === "tax").map((m) => ({ id: m.id, name: m.name }));
    return {
      kind: "ready",
      customer: quality.customer,
      candidate,
      account: { id: account.id, name: account.name },
      taxOptions,
    };
  } catch {
    // 中身（SDK・検証エラー・インフラの情報）は利用者にもログにも出さない
    throw new CandidateLoadError();
  }
}
