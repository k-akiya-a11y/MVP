"use client";

import { useState } from "react";
import type { SuspectedDuplicate } from "@/lib/review/queue";
import { resolveDuplicateAction } from "./actions";

const yen = (n: number) => n.toLocaleString("ja-JP");

/**
 * 重複の疑いがある明細（取込済みの明細と区別できなかった行）。取込のときに自動で捨てず、ここで人が決める。
 * 「別の取引」は担当者もできる（仕訳候補の作成に進むだけで、確定には承認が要る）。
 * 「重複として除外」は取引を帳簿から外す判断なので承認者（管理者）だけ。
 */
export function DuplicatesPanel({
  customerId,
  canApprove,
  items,
}: {
  customerId: string;
  canApprove: boolean;
  items: SuspectedDuplicate[];
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (items.length === 0) return null;

  async function resolve(id: string, resolution: "distinct" | "duplicate") {
    setBusy(true);
    setMessage(null);
    try {
      const result = await resolveDuplicateAction(customerId, { bankTransactionId: id, resolution, reason: null });
      if (!result.ok) setMessage(result.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>重複の疑い（{items.length}）</h2>
      <p className="note">
        取込済みの明細と日付・金額・摘要が同じで、残高がないため同じ取引か区別できなかった明細です。通帳やカードの利用明細で確かめてください。
      </p>
      {message && <p className="error">{message}</p>}
      <table className="list">
        <thead>
          <tr>
            <th>日付</th>
            <th className="num">金額</th>
            <th>摘要</th>
            <th>口座</th>
            <th>取込済みの明細</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td>{d.date}</td>
              <td className={`num ${d.direction}`}>
                {d.direction === "income" ? "+" : "-"}
                {yen(d.amount)}
              </td>
              <td>{d.description}</td>
              <td>{d.walletName}</td>
              <td>
                {d.original.date} {yen(d.original.amount)}円「{d.original.description}」
              </td>
              <td>
                <button type="button" disabled={busy} onClick={() => void resolve(d.id, "distinct")}>
                  別の取引として扱う
                </button>{" "}
                {canApprove && (
                  <button type="button" disabled={busy} onClick={() => void resolve(d.id, "duplicate")}>
                    重複として除外
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
