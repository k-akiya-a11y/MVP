import Link from "next/link";
import { z } from "zod";
import { createUserClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { PENDING_STATUSES, loadPendingCounts, type PendingCounts, type PendingStatus } from "@/lib/review/counts";

export const dynamic = "force-dynamic";

/**
 * 担当顧客の一覧と、確認待ちの件数。件数は DB で数える（pending_transaction_counts）ので、
 * 明細が 1,000 件を超えても欠けない。読めなかったときは 0 件と見せず、読めなかったと表示する。
 */
export default async function HomePage() {
  const client = await createUserClient();
  let customers: { id: string; name: string }[] = [];
  let counts: PendingCounts | null = null;
  let loadError: string | null = null;
  try {
    const [customerRows, loaded] = await Promise.all([
      fetchAll("顧客", (from, to) => client.from("customers").select("id, name").order("name").order("id").range(from, to)),
      loadPendingCounts(client),
    ]);
    customers = z.array(z.object({ id: z.string(), name: z.string() })).parse(customerRows);
    counts = loaded;
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }
  const count = (customerId: string, status: PendingStatus) => (counts ? counts.get(customerId, status) : "—");

  return (
    <main>
      <h1>結乃社 AI経理</h1>
      {loadError && <p className="error">一覧または件数を読み込めませんでした。画面を再読み込みしてください（{loadError}）</p>}
      <table>
        <thead>
          <tr>
            <th>顧客</th>
            <th className="num">確認待ち</th>
            <th className="num">保留</th>
            <th className="num">重複の疑い</th>
            <th className="num">未判定</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/customers/${c.id}`}>{c.name}</Link>
              </td>
              {PENDING_STATUSES.map((s) => (
                <td key={s} className="num">
                  {count(c.id, s)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!loadError && customers.length === 0 && <p>担当している顧客がありません。</p>}
    </main>
  );
}
