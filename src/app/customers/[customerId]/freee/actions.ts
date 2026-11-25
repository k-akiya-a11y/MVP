"use server";

import { revalidatePath } from "next/cache";
import { currentAdminId, todayJst } from "@/lib/freee/admin";
import { freeeOAuthConfigFromEnv } from "@/lib/freee/oauth";
import { runFreeeSync } from "@/lib/freee/run";
import { createServiceClient, createUserClient } from "@/lib/supabase/server";

export type SyncNowResult = { ok: true; masters: string; pastEntries: string } | { ok: false; error: string };

/** 管理者の「今すぐ同期」。マスタと過去仕訳を freee から読む（書込はしない）。結果の詳細は同期の記録に残る */
export async function syncFreeeNow(customerId: string): Promise<SyncNowResult> {
  const client = await createUserClient();
  const adminId = await currentAdminId(client);
  if (!adminId) return { ok: false, error: "freee の同期は管理者だけが行えます" };
  const { data: customer } = await client.from("customers").select("id").eq("id", customerId).maybeSingle();
  if (!customer) return { ok: false, error: "顧客が見つかりません" };
  let oauth;
  try {
    oauth = freeeOAuthConfigFromEnv();
  } catch {
    return { ok: false, error: "freee の設定（FREEE_CLIENT_ID など）がありません" };
  }
  try {
    const r = await runFreeeSync(customerId, { service: createServiceClient(), oauth, today: todayJst() }, adminId);
    revalidatePath(`/customers/${customerId}/freee`);
    return { ok: true, masters: r.results.masters.status, pastEntries: r.results.past_entries.status };
  } catch {
    return { ok: false, error: "同期を記録できませんでした。時間をおいてやり直してください" };
  }
}
