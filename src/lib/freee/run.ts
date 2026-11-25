import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { fetchAll } from "../supabase/fetch-all";
import { FreeeCallBudgetExceeded, FreeeUnauthorizedError, freeeReadApi, type CallCounter, type FetchLike } from "./api";
import { refreshAccessToken, type FreeeOAuthConfig } from "./oauth";
import { syncFreeeMasters, syncFreeePastEntries, type FreeeSyncStore, type MasterRow, type PastEntryRow } from "./sync";
import { supabaseFreeeTokenStore } from "./token-store";
import { getFreeeAccessToken, type FreeeTokenStore } from "./tokens";

/**
 * freee の読み取り同期を1顧客分実行する（管理者の「今すぐ同期」と、CRON_SECRET で守った API から呼ぶ）。
 * - マスタ → 過去仕訳の順。どちらも実行記録（freee_sync_runs）を1行ずつ残し、失敗しても理由を残す
 * - freee の呼出し回数に上限を置く（設計書3章: 1日3,000回。初回の過去仕訳取込は数日に分ける）。上限に達したら、
 *   書き終えた月までで止め、次回はその続きから取り込む（失敗にはしない）
 * - アクセストークンが 401 になったら、1回だけ更新し直して続ける
 * freee への書込はしない。
 */

/** 1回の実行で freee を呼んでよい回数（1日の上限 3,000 回より十分小さくする） */
export const DEFAULT_CALL_LIMIT = 300;

export function supabaseFreeeSyncStore(service: SupabaseClient): FreeeSyncStore {
  return {
    async syncMasters(customerId, rows: MasterRow[]) {
      const { data, error } = await service.rpc("sync_freee_masters", { p_customer_id: customerId, p_rows: rows });
      if (error) throw new Error(`マスタの写しの更新に失敗しました（${error.message}）`);
      const r = z.array(z.object({ upserted: z.number().int(), made_unavailable: z.number().int() })).length(1).parse(data)[0]!;
      return { upserted: r.upserted, madeUnavailable: r.made_unavailable };
    },
    async loadPastEntryState(customerId) {
      const { data, error } = await service
        .from("freee_sync_state")
        .select("masters_synced_at, past_entries_from, past_entries_until, past_entries_next_month, past_entries_completed_at")
        .eq("customer_id", customerId)
        .maybeSingle();
      if (error) throw new Error(`同期の状態を読めませんでした（${error.message}）`);
      const s = z
        .object({
          masters_synced_at: z.string().nullable(),
          past_entries_from: z.string().nullable(),
          past_entries_until: z.string().nullable(),
          past_entries_next_month: z.string().nullable(),
          past_entries_completed_at: z.string().nullable(),
        })
        .nullable()
        .parse(data);
      return {
        mastersSyncedAt: s?.masters_synced_at ?? null,
        from: s?.past_entries_from ?? null,
        until: s?.past_entries_until ?? null,
        nextMonth: s?.past_entries_next_month ?? null,
        completed: Boolean(s?.past_entries_completed_at),
      };
    },
    async loadPartnerNames(customerId) {
      const rows = await fetchAll("取引先", (from, to) =>
        service
          .from("freee_masters")
          .select("freee_id, name")
          .eq("customer_id", customerId)
          .eq("kind", "partner")
          .order("freee_id")
          .range(from, to),
      );
      const parsed = z
        .array(z.object({ freee_id: z.union([z.number(), z.string().regex(/^\d+$/)]).transform(Number), name: z.string() }))
        .parse(rows);
      return new Map(parsed.map((r) => [r.freee_id, r.name]));
    },
    async applyPastEntries(customerId, rows: PastEntryRow[], progress) {
      const { data, error } = await service.rpc("apply_freee_past_entries", {
        p_customer_id: customerId,
        p_rows: rows,
        p_from: progress.from,
        p_until: progress.until,
        p_next_month: progress.nextMonth,
        p_completed: progress.completed,
      });
      if (error) throw new Error(`過去仕訳の書込に失敗しました（${error.message}）`);
      return z.number().int().parse(data);
    },
  };
}

type RunKind = "masters" | "past_entries";

async function startRun(service: SupabaseClient, customerId: string, kind: RunKind, startedBy: string | null) {
  const { data, error } = await service
    .from("freee_sync_runs")
    .insert({ customer_id: customerId, kind, status: "running", started_by: startedBy })
    .select("id")
    .single();
  if (error) throw new Error(`同期の実行記録を作れませんでした（${error.message}）`);
  return z.object({ id: z.string() }).parse(data).id;
}

async function finishRun(
  service: SupabaseClient,
  runId: string,
  result: { status: "completed" | "failed"; counts: Record<string, unknown>; apiCalls: number; error?: string },
) {
  const { error } = await service
    .from("freee_sync_runs")
    .update({
      status: result.status,
      counts: result.counts,
      api_calls: result.apiCalls,
      error: result.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", runId);
  if (error) throw new Error(`同期の実行記録を更新できませんでした（${error.message}）`);
}

/** 同期の実行記録（freee_sync_runs）。テストでは差し替える */
export type FreeeSyncRunLog = {
  start(customerId: string, kind: RunKind, startedBy: string | null): Promise<string>;
  finish(runId: string, result: { status: "completed" | "failed"; counts: Record<string, unknown>; apiCalls: number; error?: string }): Promise<void>;
};

export function supabaseFreeeSyncRunLog(service: SupabaseClient): FreeeSyncRunLog {
  return { start: (c, k, b) => startRun(service, c, k, b), finish: (id, r) => finishRun(service, id, r) };
}

export type FreeeSyncDeps = {
  service: SupabaseClient;
  runLog?: FreeeSyncRunLog;
  oauth: FreeeOAuthConfig;
  fetch?: FetchLike;
  tokenStore?: FreeeTokenStore;
  syncStore?: FreeeSyncStore;
  today: string;
  callLimit?: number;
};

export async function runFreeeSync(customerId: string, deps: FreeeSyncDeps, startedBy: string | null = null) {
  const counter: CallCounter = { calls: 0, limit: deps.callLimit ?? DEFAULT_CALL_LIMIT };
  const api = freeeReadApi({ fetch: deps.fetch, counter });
  const tokenStore = deps.tokenStore ?? supabaseFreeeTokenStore(deps.service);
  const syncStore = deps.syncStore ?? supabaseFreeeSyncStore(deps.service);
  const runLog = deps.runLog ?? supabaseFreeeSyncRunLog(deps.service);
  const tokenDeps = { store: tokenStore, refresh: (rt: string) => refreshAccessToken(rt, deps.oauth, { fetch: deps.fetch }) };

  /** 401 なら1回だけトークンを更新し直してやり直す */
  async function withToken<T>(fn: (token: string, companyId: number) => Promise<T>): Promise<T> {
    const t = await getFreeeAccessToken(customerId, tokenDeps);
    try {
      return await fn(t.accessToken, t.companyId);
    } catch (error) {
      if (!(error instanceof FreeeUnauthorizedError)) throw error;
      const again = await getFreeeAccessToken(customerId, tokenDeps, { force: true });
      return fn(again.accessToken, again.companyId);
    }
  }

  const results: Record<RunKind, { status: "completed" | "failed"; counts: Record<string, unknown>; error?: string }> = {
    masters: { status: "failed", counts: {}, error: "未実行" },
    past_entries: { status: "failed", counts: {}, error: "未実行" },
  };

  for (const kind of ["masters", "past_entries"] as const) {
    if (kind === "past_entries" && results.masters.status !== "completed") {
      results.past_entries = { status: "failed", counts: {}, error: "マスタの同期が終わらなかったため、過去仕訳は取り込みませんでした" };
      const runId = await runLog.start(customerId, kind, startedBy);
      await runLog.finish(runId, { ...results.past_entries, apiCalls: 0 });
      break;
    }
    const runId = await runLog.start(customerId, kind, startedBy);
    const before = counter.calls;
    try {
      const counts =
        kind === "masters"
          ? await withToken((token, companyId) =>
              syncFreeeMasters({ customerId, companyId, accessToken: token, api, store: syncStore }),
            )
          : await withToken((token, companyId) =>
              syncFreeePastEntries({ customerId, companyId, accessToken: token, api, store: syncStore, today: deps.today }),
            );
      results[kind] = { status: "completed", counts };
    } catch (error) {
      if (kind === "past_entries" && error instanceof FreeeCallBudgetExceeded) {
        // 書き終えた月までは保存済み。続きは次回（失敗ではない）
        results[kind] = { status: "completed", counts: { stopped_by_call_limit: true } };
      } else {
        results[kind] = { status: "failed", counts: {}, error: error instanceof Error ? error.message : String(error) };
      }
    }
    await runLog.finish(runId, { ...results[kind], apiCalls: counter.calls - before });
  }
  return { results, apiCalls: counter.calls };
}
