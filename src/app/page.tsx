import Link from "next/link";
import { z } from "zod";
import { createUserClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { PENDING_STATUSES, loadPendingCounts, type PendingCounts } from "@/lib/review/counts";

export const dynamic = "force-dynamic";

/**
 * 担当顧客の一覧と、確認待ちの件数。件数は DB で数える（pending_transaction_counts）ので、
 * 明細が 1,000 件を超えても欠けない。読めなかったときは 0 件とも「顧客なし」とも見せず、固定文言で読めなかったと表示する。
 */
export default async function HomePage() {
  let customers: { id: string; name: string }[];
  let counts: PendingCounts;
  try {
    const client = await createUserClient();
    const [customerRows, loaded] = await Promise.all([
      fetchAll("顧客", (from, to) => client.from("customers").select("id, name").order("name").order("id").range(from, to)),
      loadPendingCounts(client),
    ]);
    customers = z.array(z.object({ id: z.string(), name: z.string() })).parse(customerRows);
    counts = loaded;
  } catch {
    // 例外の中身は画面に出さない。一覧・件数・リンクも出さず、0 件や「顧客なし」と見せない
    return (
      <main>
        <h1>結乃社 AI経理</h1>
        <p className="error">
          顧客一覧または確認待ち件数を読み込めなかったため表示できません。担当顧客や確認待ちがないことを意味しません。時間をおいて再読み込みしてください。
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>結乃社 AI経理</h1>
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
                  {counts.get(c.id, s)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {customers.length === 0 && <p>担当している顧客がありません。</p>}
    </main>
  );
}
