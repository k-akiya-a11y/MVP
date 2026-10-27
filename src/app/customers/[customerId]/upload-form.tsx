"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { submitStatementUpload, UPLOAD_UNKNOWN_MESSAGE } from "@/lib/statements/upload-result";

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
      // 送信は1回だけ。通信や応答の異常でも自動では再送せず、結果不明として確認を促す
      const outcome = await submitStatementUpload(
        fetch,
        `/api/customers/${customerId}/statements`,
        new FormData(event.currentTarget),
      );
      setMessage(outcome.message);
      router.refresh();
    } catch {
      // フォーム読取などの想定外の例外。登録済みかもしれないので結果不明として扱う
      setMessage(UPLOAD_UNKNOWN_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="upload" onSubmit={onSubmit}>
      <strong>明細CSVの取込</strong>
      {/* 先頭の口座が選ばれたままにならないよう、口座と形式は毎回選んでもらう */}
      <select name="walletId" required aria-label="口座" defaultValue="">
        <option value="" disabled>
          口座を選ぶ
        </option>
        {wallets.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <select name="formatId" required aria-label="CSVの形式" defaultValue="">
        <option value="" disabled>
          CSVの形式を選ぶ
        </option>
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
