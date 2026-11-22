"use client";

import { useRef, useState } from "react";
import type { SuspectedDuplicate } from "@/lib/review/queue";
import { resolveDuplicateAction } from "./actions";

type Guard = "idle" | "pending" | "unknown";

const UNKNOWN_MESSAGE =
  "操作の結果を確認できませんでした。この明細の判断はすでに記録されている可能性があります。画面を再読み込みして、取引の状態と履歴を確認してから、必要な場合だけもう一度操作してください。";

/** 明示的な `ok: true`（任意の error は無視する）か `ok: false` + 文字列の error だけを既知の結果として受け取る。それ以外は null（結果不明） */
function knownResult(r: unknown): { error: string | null } | null {
  if (typeof r !== "object" || r === null) return null;
  const v = r as { ok?: unknown; error?: unknown };
  if (v.ok === true) return { error: null };
  if (v.ok === false && typeof v.error === "string") return { error: v.error };
  return null;
}

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
  // 同期ガード（全行・両方の判断で共有）。idle のときだけ送れる。unknown は再マウントまで解除しない。
  // ref は再描画を待たずに確認・更新できる。state は表示（ボタンの無効化）用。
  // フックは 0 件の早期 return より前に置き、0 件を経由してもガードが消えないようにする。
  const guardRef = useRef<Guard>("idle");
  const [guard, setGuard] = useState<Guard>("idle");
  const [message, setMessage] = useState<string | null>(null);
  // 古いハンドラでも最新の権限で判定する
  const canApproveRef = useRef(canApprove);
  canApproveRef.current = canApprove;
  if (items.length === 0) return null;

  async function resolve(id: string, resolution: "distinct" | "duplicate") {
    // 承認者でなければ送らない。ガードは掴まず、案内も出さない
    if (resolution === "duplicate" && !canApproveRef.current) return;
    if (guardRef.current !== "idle") return;
    guardRef.current = "pending";
    setGuard("pending");
    setMessage(null);
    let next: Guard = "unknown";
    try {
      const result: unknown = await resolveDuplicateAction(customerId, { bankTransactionId: id, resolution, reason: null });
      const known = knownResult(result);
      if (known) {
        next = "idle";
        setMessage(known.error);
      } else {
        setMessage(UNKNOWN_MESSAGE);
      }
    } catch {
      // 結果を受け取れなかった。判断はすでに記録されている可能性があるので、成否を断定しない（例外の文言は出さない）
      setMessage(UNKNOWN_MESSAGE);
    } finally {
      // 結果不明（unknown）は解除しない。既知の結果（成功・拒否）のときだけ idle に戻す
      guardRef.current = next;
      setGuard(next);
    }
  }
  const busy = guard !== "idle";

  return (
    <section>
      <h2>重複の疑い（{items.length}）</h2>
      <p className="note">
        取込済みの明細と日付・金額・摘要が同じで、取り込んだデータだけでは同じ取引だと確定できなかった明細です（残高がない場合や、残高が同じでも一部だけ重なっている場合を含みます）。残高が同じでも別の取引とは限りません。元の通帳やカードの利用明細で確かめてください。
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
