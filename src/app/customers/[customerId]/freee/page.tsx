import Link from "next/link";
import { notFound } from "next/navigation";
import { loadFreeePage, type FreeePageData } from "@/lib/freee/page-load";
import { createUserClient } from "@/lib/supabase/server";
import { SyncButton } from "./sync-button";

export const dynamic = "force-dynamic";
// 「今すぐ同期」（server action）は freee を何度も呼ぶため長めに取る
export const maxDuration = 300;

const RESULT_MESSAGE: Record<string, string> = {
  connected: "freee と接続しました。",
  denied: "freee の認可が取り消されたため、接続しませんでした。",
  not_admin: "freee との接続は管理者だけが行えます。",
  not_found: "顧客が見つかりません。",
  no_company_id: "この顧客には freee の事業所 ID が登録されていないため、接続できません。",
  not_configured: "freee のアプリの設定（FREEE_CLIENT_ID など）がないため、接続できません。",
  company_mismatch: "認可した freee の事業所が、この顧客の事業所と一致しないため、接続しませんでした。",
  failed: "freee との接続に失敗しました。時間をおいて最初からやり直してください。",
};
const STATUS_LABEL: Record<string, string> = { active: "接続中", needs_reauth: "再認可が必要" };
const RUN_STATUS: Record<string, string> = { running: "実行中", completed: "完了", failed: "失敗" };
const KIND: Record<string, string> = { masters: "マスタ", past_entries: "過去仕訳" };

export default async function FreeePage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { customerId } = await params;
  const { result } = await searchParams;
  let data: FreeePageData | null = null;
  let failure = false;
  try {
    data = await loadFreeePage(await createUserClient(), customerId);
  } catch {
    // 例外の中身は画面に出さない
    failure = true;
  }
  if (!failure && !data) notFound();
  const message = result ? RESULT_MESSAGE[result] : undefined;

  return (
    <main>
      <p>
        <Link href={`/customers/${customerId}`}>← 承認画面に戻る</Link>
      </p>
      <h1>{data ? `${data.customer.name}：freee 連携` : "freee 連携"}</h1>
      <p className="note">
        freee からマスタ（勘定科目・取引先・品目・部門・メモタグ・税区分）と過去仕訳（取引）を読み取るだけです。freee
        への登録・変更・削除はしません。接続と同期は管理者だけが行えます。
      </p>
      {message && <p className={result === "connected" ? "" : "error"}>{message}</p>}
      {failure || !data ? (
        <p className="error">freee 連携の状態を読み込めなかったため表示できません。時間をおいて再読み込みしてください。</p>
      ) : (
        <>
          <h2>接続</h2>
          <ul>
            <li>freee の事業所 ID: {data.customer.freeeCompanyId ?? "未登録"}</li>
            <li>
              状態:{" "}
              {data.connection
                ? `${STATUS_LABEL[data.connection.status] ?? data.connection.status}（接続日時 ${data.connection.connectedAt}）`
                : "未接続"}
            </li>
          </ul>
          {data.isAdmin && data.customer.freeeCompanyId !== null && (
            <p>
              <a href={`/api/auth/freee/start?customerId=${customerId}`}>{data.connection ? "freee と接続し直す" : "freee と接続する"}</a>
              （freee の画面で、この顧客の事業所を選んで許可してください）
            </p>
          )}
          {data.isAdmin && data.connection?.status === "active" && <SyncButton customerId={customerId} />}

          <h2>同期の状態</h2>
          <ul>
            <li>マスタの最終同期: {data.state?.mastersSyncedAt ?? "未同期"}</li>
            <li>
              過去仕訳: {data.state?.pastEntriesFrom ? `${data.state.pastEntriesFrom} の月から` : "未取込"}
              {data.state?.pastEntriesNextMonth && !data.state.pastEntriesCompletedAt && `（次は ${data.state.pastEntriesNextMonth} の月）`}
              {data.state?.pastEntriesCompletedAt && "（初回の取込は完了。以降は直近の月を読み直します）"}
            </li>
          </ul>

          <h2>同期の記録（新しい順、最大20件）</h2>
          {data.runs.length === 0 ? (
            <p>まだ同期していません。</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>開始</th>
                  <th>種類</th>
                  <th>結果</th>
                  <th className="num">freee の呼出し</th>
                  <th>件数</th>
                  <th>失敗の理由</th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.startedAt}</td>
                    <td>{KIND[r.kind] ?? r.kind}</td>
                    <td>{RUN_STATUS[r.status] ?? r.status}</td>
                    <td className="num">{r.apiCalls}</td>
                    <td>
                      <code>{JSON.stringify(r.counts)}</code>
                    </td>
                    <td>{r.error ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
