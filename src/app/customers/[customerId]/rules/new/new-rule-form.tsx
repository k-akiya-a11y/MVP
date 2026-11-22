"use client";

import Link from "next/link";
import { useState } from "react";
import { CREATE_UNKNOWN_MESSAGE, draftToCreateInput } from "@/lib/rules/candidate-schema";
import type { CreateRuleResult } from "@/lib/rules/candidate-submit";
import type { MasterOption } from "@/lib/rules/editor-load";
import { createRuleFromCandidateAction } from "./actions";

type Props = {
  customerId: string;
  /** URL で固定された依頼ID。再読み込みしても変わらず、DB 側で同じIDの2回目の保存を拒否する */
  requestId: string;
  candidate: {
    partnerKey: string;
    direction: "income" | "expense";
    accountItemId: number;
    count: number;
    dateRange: { from: string; to: string };
  };
  accountName: string;
  taxOptions: MasterOption[];
};

const DIRECTION_LABEL = { income: "入金", expense: "出金" } as const;

/** 指定しない項目と、その意味（保存前に人が確認する） */
const UNSPECIFIED: { label: string; meaning: string }[] = [
  { label: "金額の条件", meaning: "未指定: 金額の下限・上限がないため、どんな金額の取引にも一致します。" },
  { label: "口座", meaning: "未指定: 口座を問わず、すべての口座の取引に一致します。" },
  { label: "摘要の語句", meaning: "未指定: 摘要の内容では絞り込みません。" },
  { label: "有効期間", meaning: "未指定: 開始日・終了日がなく、期間では区切られません。" },
  { label: "補助科目（取引先・品目・部門・メモタグ）", meaning: "未指定: 仕訳候補に補助科目の ID は入りません。" },
  { label: "摘要の雛形", meaning: "未指定: 仕訳候補の摘要は雛形から作られません。" },
];

/**
 * 候補から新しいルールを「提案中」で保存する。保存は明示的なボタン1つだけ。税区分と優先順位は人が入力するまで空欄で、
 * 既定値を入れない。保存済み・結果不明・競合のあとは、この画面から再送できないようにする。
 */
export function NewRuleForm({ customerId, requestId, candidate, accountName, taxOptions }: Props) {
  const [taxCode, setTaxCode] = useState("");
  const [priority, setPriority] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const rulesHref = `/customers/${customerId}/rules`;

  async function save() {
    if (!confirmed || busy || locked) return;
    const built = draftToCreateInput(
      {
        customerId,
        requestId,
        partnerKey: candidate.partnerKey,
        direction: candidate.direction,
        accountItemId: candidate.accountItemId,
      },
      { taxCode, priority },
    );
    if (!built.ok) {
      setNotice({ tone: "error", text: built.message });
      return;
    }
    setBusy(true);
    try {
      // 送信は1回だけ。例外でも自動では再送しない
      const result: CreateRuleResult = await createRuleFromCandidateAction(built.input);
      if (result.ok || result.outcome === "unknown" || result.code === "conflict") setLocked(true);
      if (result.ok) setConfirmed(false);
      setNotice({ tone: result.ok ? "ok" : "error", text: result.message });
    } catch {
      setLocked(true);
      setNotice({ tone: "error", text: CREATE_UNKNOWN_MESSAGE });
    } finally {
      setBusy(false);
    }
  }

  const disabled = !confirmed || busy || locked;

  return (
    <form
      onSubmit={(e) => {
        // ボタン以外（Enter キーなど）からは保存しない
        e.preventDefault();
      }}
    >
      <fieldset>
        <legend>候補（過去仕訳から。変更できません）</legend>
        <dl>
          <dt>取引先キー（完全一致）</dt>
          <dd>{candidate.partnerKey}</dd>
          <dt>入出金の向き</dt>
          <dd>{DIRECTION_LABEL[candidate.direction]}</dd>
          <dt>勘定科目</dt>
          <dd>
            {accountName}（科目ID {candidate.accountItemId}）
          </dd>
          <dt>根拠</dt>
          <dd>
            過去仕訳 {candidate.count} 件（{candidate.dateRange.from === candidate.dateRange.to ? candidate.dateRange.from : `${candidate.dateRange.from} 〜 ${candidate.dateRange.to}`}）
          </dd>
        </dl>
        {candidate.count === 1 && (
          <p className="error">根拠は1件の過去仕訳だけです。1件だけでは、この取引先の科目が安定しているとは言えません。</p>
        )}
      </fieldset>

      <fieldset disabled={busy || locked}>
        <legend>人が決める項目（空欄のままでは保存できません）</legend>
        <label>
          税区分
          <select
            value={taxCode}
            onChange={(e) => {
              setConfirmed(false);
              setTaxCode(e.target.value);
            }}
          >
            <option value="">選んでください</option>
            {taxOptions.map((t) => (
              <option key={t.id} value={String(t.id)}>
                {t.name}（ID {t.id}）
              </option>
            ))}
          </select>
        </label>
        <label>
          優先順位（整数。小さいほど優先されます）
          <input
            type="text"
            inputMode="numeric"
            value={priority}
            onChange={(e) => {
              setConfirmed(false);
              setPriority(e.target.value);
            }}
          />
        </label>
        {taxOptions.length === 0 && <p className="error">選べる税区分が現在のマスタにないため、保存できません。</p>}
      </fieldset>

      <fieldset>
        <legend>指定しない項目</legend>
        <ul>
          {UNSPECIFIED.map((u) => (
            <li key={u.label}>
              {u.label}: {u.meaning}
            </li>
          ))}
        </ul>
        <p className="note">
          上記は保存したあとで、既存のルール編集画面から新しい版として追加・変更できます。今回は、取引先キーと入出金の向きだけを条件にしたルールが作られます。
        </p>
      </fieldset>

      <ul className="note">
        <li>保存されるのは「提案中」のルール（版1）です。有効にはならず、仕訳候補の照合にはまだ使われません。有効にするには、既存のルール編集画面で人が操作します。</li>
        <li>
          既存のルールと同じ内容かどうかは確認していません。同じ条件のルールがすでにあっても、重複は防がれません。保存の前に{" "}
          <Link href={rulesHref}>既存の顧客ルールの一覧</Link>で確認してください。
        </li>
        <li>同じ画面（同じ依頼ID）から保存できるのは1回だけです。再読み込みしても、2回目は保存されません。</li>
      </ul>

      <p>
        <label>
          <input type="checkbox" checked={confirmed} disabled={busy || locked} onChange={(e) => setConfirmed(e.target.checked)} />
          上の内容と、指定しない項目の意味、保存後の状態（提案中）を確認しました
        </label>
      </p>
      <p>
        <button type="button" disabled={disabled} onClick={() => void save()}>
          提案中として新しいルールを保存
        </button>
      </p>

      {notice && (
        <p className={notice.tone === "error" ? "error" : "note"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      )}
      {locked && (
        <p className="note">
          この画面からは再送できません。ルールID（依頼ID）: {requestId}。<Link href={rulesHref}>顧客ルールの一覧</Link>で確認してください。
        </p>
      )}
    </form>
  );
}
