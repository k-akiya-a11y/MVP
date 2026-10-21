"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ImportCounts } from "@/lib/statements/import";

type Props = {
  customerId: string;
  wallets: { id: string; name: string }[];
  formats: { id: string; label: string }[];
};

/** 明細 CSV のアップロード。取り込んだ明細は次の判定（定期処理）で仕訳候補になる */
export function UploadForm({ customerId, wallets, formats }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/statements`, {
        method: "POST",
        body: new FormData(event.currentTarget),
      });
      const body = (await res.json()) as
        | ({ ok: true } & ImportCounts)
        | { ok: false; errors: { line: number; message: string }[]; failureRecordId: string | null }
        | { error: string };
      if ("error" in body) setMessage(body.error);
      else if (body.ok) setMessage(importSummary(body));
      else
        setMessage(
          `取り込めませんでした（明細は1件も登録していません${body.failureRecordId ? "。失敗として記録しました" : ""}）: ` +
            body.errors.slice(0, 5).map((e) => `${e.line}行目 ${e.message}`).join(" / "),
        );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="upload" onSubmit={onSubmit}>
      <strong>明細CSVの取込</strong>
      <select name="walletId" required aria-label="口座">
        {wallets.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <select name="formatId" required aria-label="CSVの形式">
        {formats.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <input type="file" name="file" accept=".csv,text/csv" required />
      <button type="submit" disabled={busy}>
        取り込む
      </button>
      {message && <span className="note">{message}</span>}
    </form>
  );
}

const yen = (n: number) => n.toLocaleString("ja-JP");

/** 取込結果の件数と金額。読めた行 = 登録 + 読み飛ばし + 重複の疑い で照合できるように並べる */
function importSummary(c: ImportCounts): string {
  const lines = [
    `読めた行 ${c.insertedCount + c.skippedDuplicateCount + c.suspectedDuplicateCount}件（入金 ${yen(c.incomeTotal)}円・出金 ${yen(c.expenseTotal)}円）`,
    `登録 ${c.insertedCount}件 ${yen(c.insertedAmountTotal)}円`,
    `取込済みのため読み飛ばし ${c.skippedDuplicateCount}件 ${yen(c.skippedAmountTotal)}円`,
  ];
  if (c.suspectedDuplicateCount) {
    lines.push(`重複の疑い ${c.suspectedDuplicateCount}件 ${yen(c.suspectedAmountTotal)}円（「重複の疑い」で確認してください）`);
  }
  if (c.ignoredCount) lines.push(`金額0のため取引にしなかった行 ${c.ignoredCount}件`);
  return lines.join(" ／ ");
}
