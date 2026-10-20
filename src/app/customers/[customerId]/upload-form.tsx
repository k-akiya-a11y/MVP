"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
        | { ok: true; insertedCount: number; skippedDuplicateCount: number }
        | { ok: false; errors: { line: number; message: string }[] }
        | { error: string };
      if ("error" in body) setMessage(body.error);
      else if (body.ok) setMessage(`${body.insertedCount}件を取り込みました（取込済みのため読み飛ばし ${body.skippedDuplicateCount}件）`);
      else setMessage(`取り込めませんでした: ${body.errors.slice(0, 5).map((e) => `${e.line}行目 ${e.message}`).join(" / ")}`);
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
