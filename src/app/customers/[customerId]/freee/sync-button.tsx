"use client";

import { useState, useTransition } from "react";
import { syncFreeeNow, type SyncNowResult } from "./actions";

const LABEL: Record<string, string> = { completed: "完了", failed: "失敗" };

/** 管理者の「今すぐ同期」。押している間は二重に送らない */
export function SyncButton({ customerId }: { customerId: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<SyncNowResult | null>(null);
  return (
    <p>
      <button type="button" disabled={pending} onClick={() => start(async () => setResult(await syncFreeeNow(customerId)))}>
        {pending ? "同期中…" : "今すぐ同期する（マスタ → 過去仕訳。読み取りだけ）"}
      </button>{" "}
      {result &&
        (result.ok ? (
          <span>
            マスタ: {LABEL[result.masters] ?? result.masters}、過去仕訳: {LABEL[result.pastEntries] ?? result.pastEntries}（詳細は下の記録）
          </span>
        ) : (
          <span className="error">{result.error}</span>
        ))}
    </p>
  );
}
