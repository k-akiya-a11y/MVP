import Link from "next/link";
import { z } from "zod";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** 担当顧客の一覧と、確認待ちの件数 */
export default async function HomePage() {
  const client = await createUserClient();
  const [customersRes, pendingRes] = await Promise.all([
    client.from("customers").select("id, name").order("name"),
    client.from("bank_transactions").select("customer_id, status").in("status", ["new", "proposed", "on_hold"]),
  ]);
  const customers = z.array(z.object({ id: z.string(), name: z.string() })).parse(customersRes.data ?? []);
  const pending = z.array(z.object({ customer_id: z.string(), status: z.string() })).parse(pendingRes.data ?? []);
  const count = (customerId: string, status: string) =>
    pending.filter((p) => p.customer_id === customerId && p.status === status).length;

  return (
    <main>
      <h1>結乃社 AI経理</h1>
      <table>
        <thead>
          <tr>
            <th>顧客</th>
            <th className="num">確認待ち</th>
            <th className="num">保留</th>
            <th className="num">未判定</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/customers/${c.id}`}>{c.name}</Link>
              </td>
              <td className="num">{count(c.id, "proposed")}</td>
              <td className="num">{count(c.id, "on_hold")}</td>
              <td className="num">{count(c.id, "new")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {customers.length === 0 && <p>担当している顧客がありません。</p>}
    </main>
  );
}
