"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { submitStatementUpload, UPLOAD_UNKNOWN_MESSAGE, type UploadOutcome } from "@/lib/statements/upload-result";

type Props = {
  customerId: string;
  wallets: { id: string; name: string }[];
  formats: { id: string; label: string }[];
};

const REFRESH_FAILED_NOTE = " ※画面の一覧の更新に失敗しました。ページを再読み込みして最新の状態を確認してください。";
const LOCKED_NOTE =
  "この画面からは再送できません。ページを再読み込みして、取込の記録と取り込んだ明細の一覧を確認してください。";

/** 明細 CSV のアップロード。取り込んだ明細は次の判定（定期処理）で仕訳候補になる */
export function UploadForm({ customerId, wallets, formats }: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 結果不明のあとは、ページを再読み込みするまで再送させない（state だけだと再描画まで効かないので ref も持つ）
  const [locked, setLocked] = useState(false);
  const submitting = useRef(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // state は再描画されるまで反映されない。同じ描画の間に届く2回目以降は、この ref で同期的に止める
    if (submitting.current) return;
    submitting.current = true;
    let outcome: UploadOutcome;
    try {
      // 無効なコントロールは FormData に入らないので、無効化を描画する前（setBusy より前）に内容を取得する
      const body = new FormData(event.currentTarget);
      setBusy(true);
      setMessage(null);
      // 送信は1回だけ。通信や応答の異常でも自動では再送せず、結果不明として確認を促す
      outcome = await submitStatementUpload(fetch, `/api/customers/${customerId}/statements`, body);
    } catch {
      // フォーム読取などの想定外の例外。登録済みかもしれないので結果不明として扱う
      outcome = { kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE };
    }
    let text = outcome.message;
    if (outcome.kind === "unknown") {
      // submitting は戻さない。再読み込み（再マウント）以外では解除しない
      setLocked(true);
    } else {
      submitting.current = false;
    }
    try {
      router.refresh();
    } catch {
      // 一覧の更新に失敗しただけ。取込の結果の判定は変えず、unknown の固定も解かない
      if (outcome.kind !== "unknown") text += REFRESH_FAILED_NOTE;
    }
    setMessage(text);
    setBusy(false);
  }

  const disabled = busy || locked;

  return (
    <form className="upload" onSubmit={onSubmit}>
      <strong>明細CSVの取込</strong>
      {/* 先頭の口座が選ばれたままにならないよう、口座と形式は毎回選んでもらう */}
      <select name="walletId" required aria-label="口座" defaultValue="" disabled={disabled}>
        <option value="" disabled>
          口座を選ぶ
        </option>
        {wallets.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      <select name="formatId" required aria-label="CSVの形式" defaultValue="" disabled={disabled}>
        <option value="" disabled>
          CSVの形式を選ぶ
        </option>
        {formats.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <input type="file" name="file" accept=".csv,text/csv" required disabled={disabled} />
      <button type="submit" disabled={disabled}>
        取り込む
      </button>
      {message && <span className="note">{message}</span>}
      {locked && <span className="note">{LOCKED_NOTE}</span>}
      <Link href={`/customers/${customerId}/imports`}>取込の記録を見る</Link>
      {" / "}
      <Link href={`/customers/${customerId}/statements`}>取り込んだ明細の一覧を見る</Link>
    </form>
  );
}
