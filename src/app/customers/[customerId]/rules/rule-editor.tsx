"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { draftToInput, toDraft, type RuleDraft } from "@/lib/rules/editor-draft";
import type { EditorRule, MasterOption, WalletOption } from "@/lib/rules/editor-load";
import { RULE_STATUS_LABEL, type RuleStatus } from "@/lib/rules/editor-schema";
import type { RuleSubmitResult } from "@/lib/rules/editor-submit";
import { saveRuleVersionAction } from "./actions";

type Masters = {
  account_item: MasterOption[];
  tax: MasterOption[];
  partner: MasterOption[];
  item: MasterOption[];
  section: MasterOption[];
  tag: MasterOption[];
};

type Props = { customerId: string; rules: EditorRule[]; masters: Masters; wallets: WalletOption[] };

type Notice = { tone: "ok" | "error"; text: string; needsReload: boolean };

const DIRECTION_LABEL = { income: "入金", expense: "出金" } as const;

const nameOf = (options: MasterOption[], id: number | null) => {
  if (id === null) return "なし";
  const o = options.find((m) => m.id === id);
  return o ? `${o.name}（ID ${id}）` : `ID ${id}（現在のマスタにありません）`;
};

function describeConditions(rule: EditorRule, wallets: WalletOption[]): string {
  const c = rule.cond;
  const parts: string[] = [];
  if (c.partnerKey !== null) parts.push(`取引先キー「${c.partnerKey}」`);
  if (c.descriptionKeyword !== null) parts.push(`摘要に「${c.descriptionKeyword}」`);
  if (c.amountMin !== null) parts.push(`${c.amountMin}円以上`);
  if (c.amountMax !== null) parts.push(`${c.amountMax}円未満`);
  if (c.walletId !== null) parts.push(`口座 ${wallets.find((w) => w.id === c.walletId)?.name ?? "（この顧客の口座にありません）"}`);
  if (c.direction !== null) parts.push(DIRECTION_LABEL[c.direction]);
  return parts.join(" かつ ");
}

/** 既存ルールの一覧と、選んだルールの編集。保存は明示的なボタンだけで、選択や表示では何も保存・有効化しない */
export function RuleEditor({ customerId, rules, masters, wallets }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reloads, setReloads] = useState(0);
  const selected = rules.find((r) => r.ruleId === selectedId) ?? null;

  if (rules.length === 0) {
    return <p>保存されているルールはありません。このページでは新しいルールの作成はできません。</p>;
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>ルールID</th>
            <th>状態</th>
            <th className="num">版</th>
            <th className="num">優先順位</th>
            <th>条件</th>
            <th>処理（勘定科目 / 税区分）</th>
            <th>有効期間</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.ruleId}>
              <td>
                <code>{r.ruleId}</code>
              </td>
              <td>{RULE_STATUS_LABEL[r.status]}</td>
              <td className="num">{r.version}</td>
              <td className="num">{r.priority}</td>
              <td>{describeConditions(r, wallets)}</td>
              <td>
                {nameOf(masters.account_item, r.action.accountItemId)} / {nameOf(masters.tax, r.action.taxCode)}
              </td>
              <td>
                {r.validFrom ?? "指定なし"} 〜 {r.validTo ?? "指定なし"}
              </td>
              <td>
                <button
                  type="button"
                  aria-pressed={r.ruleId === selectedId}
                  onClick={() => {
                    setSelectedId(r.ruleId);
                    setNotice(null);
                  }}
                >
                  編集する
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {notice && (
        <p className={notice.tone === "error" ? "error" : "note"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
          {notice.needsReload && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  // 利用者の操作でだけ読み直す。編集中の入力は破棄され、保存されている最新の版から作り直す
                  setReloads((n) => n + 1);
                  setNotice(null);
                  router.refresh();
                }}
              >
                最新の状態を読み込む
              </button>
            </>
          )}
        </p>
      )}

      {selected && (
        // 版が変わったら（保存後・他の人の更新後）保存されている最新の版から作り直す
        <RuleForm
          key={`${selected.ruleId}:${selected.version}:${reloads}`}
          customerId={customerId}
          rule={selected}
          masters={masters}
          wallets={wallets}
          onResult={(result) => {
            setNotice({ tone: result.ok ? "ok" : "error", text: result.message, needsReload: !result.ok && (result.outcome === "unknown" || result.code === "stale" || result.code === "conflict") });
            if (result.ok) router.refresh();
          }}
        />
      )}
    </>
  );
}

type FormProps = {
  customerId: string;
  rule: EditorRule;
  masters: Masters;
  wallets: WalletOption[];
  onResult: (result: RuleSubmitResult) => void;
};

function RuleForm({ customerId, rule, masters, wallets, onResult }: FormProps) {
  const [draft, setDraft] = useState<RuleDraft>(() => toDraft(rule));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // 保存済み・結果不明・競合のあとは、最新を読み込み直すまで同じ画面から再送できないようにする
  const [locked, setLocked] = useState(false);

  // 内容を変えたら確認は取り消す（確認は現在の内容に対するもの）
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => {
    setConfirmed(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  async function save(status: RuleStatus) {
    if (!confirmed || busy || locked) return;
    setBusy(true);
    try {
      // 送信は1回だけ。例外でも自動では再送しない
      const result = await saveRuleVersionAction(
        draftToInput({ customerId, ruleId: rule.ruleId, expectedVersion: rule.version, status, draft }),
      );
      if (result.ok || result.outcome === "unknown" || result.code === "stale" || result.code === "conflict") setLocked(true);
      if (result.ok) setConfirmed(false);
      onResult(result);
    } catch {
      setLocked(true);
      onResult({
        ok: false,
        outcome: "unknown",
        code: "unknown",
        message: "保存できたかどうかを確認できませんでした。保存されていない、とは言い切れません。自動では再送しません。ページを再読み込みして、ルールの版が増えているか確認してください。",
      });
    } finally {
      setBusy(false);
    }
  }

  const disabled = !confirmed || busy || locked;

  const select = (label: string, key: "accountItemId" | "taxCode" | "partnerId" | "itemId" | "sectionId", options: MasterOption[], optional: boolean) => {
    const value = draft[key];
    const known = options.some((o) => String(o.id) === value);
    return (
      <label>
        {label}
        <select value={value} onChange={(e) => set(key, e.target.value)}>
          {optional ? <option value="">なし</option> : value === "" && <option value="">選んでください</option>}
          {/* 保存されている値がマスタにないときも、そのまま選べるようにして値を勝手に変えない */}
          {value !== "" && !known && <option value={value}>ID {value}（現在のマスタにありません）</option>}
          {options.map((o) => (
            <option key={o.id} value={String(o.id)}>
              {o.name}（ID {o.id}）
            </option>
          ))}
        </select>
      </label>
    );
  };

  const tagIdsKnown = new Set(masters.tag.map((t) => String(t.id)));
  const tagChoices = [
    ...masters.tag.map((t) => ({ value: String(t.id), label: `${t.name}（ID ${t.id}）` })),
    ...draft.tagIds.filter((t) => !tagIdsKnown.has(t)).map((t) => ({ value: t, label: `ID ${t}（現在のマスタにありません）` })),
  ];

  return (
    <form
      onSubmit={(e) => {
        // ボタン以外（Enter キーなど）からは保存しない
        e.preventDefault();
      }}
    >
      <h2>
        ルールの編集（現在: 版{rule.version}、{RULE_STATUS_LABEL[rule.status]}）
      </h2>
      <p className="note">
        ルールID: <code>{rule.ruleId}</code>
      </p>
      <p className="note">
        保存すると版{rule.version + 1}が追加されます。版{rule.version}を含む以前の版は消えず、上書きもされません。
        「有効」で保存したルールは、以降に作る仕訳候補の照合に使われます（すでに作成済みの仕訳候補は変わりません）。
        ルールに一致した候補も、Phase 1 では必ず人（承認者）が確認して承認します。自動では確定・登録されません。
      </p>

      <fieldset disabled={busy || locked}>
        <legend>条件（指定した項目をすべて満たすと一致。空欄は条件にしません。1つ以上必要です）</legend>
        <label>
          取引先キー（完全一致。前後の空白も含めて入力のまま照合します）
          <input type="text" value={draft.partnerKey} onChange={(e) => set("partnerKey", e.target.value)} />
        </label>
        <label>
          摘要に含まれる語句
          <input type="text" value={draft.descriptionKeyword} onChange={(e) => set("descriptionKeyword", e.target.value)} />
        </label>
        <label>
          金額の下限（円・以上）
          <input type="text" inputMode="numeric" value={draft.amountMin} onChange={(e) => set("amountMin", e.target.value)} />
        </label>
        <label>
          金額の上限（円・未満）
          <input type="text" inputMode="numeric" value={draft.amountMax} onChange={(e) => set("amountMax", e.target.value)} />
        </label>
        <label>
          口座
          <select value={draft.walletId} onChange={(e) => set("walletId", e.target.value)}>
            <option value="">指定なし</option>
            {draft.walletId !== "" && !wallets.some((w) => w.id === draft.walletId) && (
              <option value={draft.walletId}>（この顧客の口座にありません）</option>
            )}
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          入出金の向き
          <select value={draft.direction} onChange={(e) => set("direction", e.target.value)}>
            <option value="">指定なし</option>
            <option value="income">入金</option>
            <option value="expense">出金</option>
          </select>
        </label>
      </fieldset>

      <fieldset disabled={busy || locked}>
        <legend>処理</legend>
        {select("勘定科目", "accountItemId", masters.account_item, false)}
        {select("税区分", "taxCode", masters.tax, false)}
        {select("取引先", "partnerId", masters.partner, true)}
        {select("品目", "itemId", masters.item, true)}
        {select("部門", "sectionId", masters.section, true)}
        <fieldset>
          <legend>メモタグ</legend>
          {tagChoices.length === 0 && <span className="note">選べるメモタグはありません</span>}
          {tagChoices.map((t) => (
            <label key={t.value}>
              <input
                type="checkbox"
                checked={draft.tagIds.includes(t.value)}
                onChange={(e) => set("tagIds", e.target.checked ? [...draft.tagIds, t.value] : draft.tagIds.filter((x) => x !== t.value))}
              />
              {t.label}
            </label>
          ))}
        </fieldset>
        <label>
          摘要の雛形（使える差込み: {"{month}"} {"{year}"} {"{description}"}）
          <input type="text" value={draft.descriptionTemplate} onChange={(e) => set("descriptionTemplate", e.target.value)} />
        </label>
      </fieldset>

      <fieldset disabled={busy || locked}>
        <legend>優先順位・有効期間</legend>
        <label>
          優先順位（小さいほど優先）
          <input type="text" inputMode="numeric" value={draft.priority} onChange={(e) => set("priority", e.target.value)} />
        </label>
        <label>
          有効期間の開始日
          <input type="date" value={draft.validFrom} onChange={(e) => set("validFrom", e.target.value)} />
        </label>
        <label>
          有効期間の終了日
          <input type="date" value={draft.validTo} onChange={(e) => set("validTo", e.target.value)} />
        </label>
      </fieldset>

      <p>
        <label>
          <input type="checkbox" checked={confirmed} disabled={busy || locked} onChange={(e) => setConfirmed(e.target.checked)} />
          上の内容と、保存後の状態を確認しました
        </label>
      </p>
      <p>
        <button type="button" disabled={disabled} onClick={() => void save("proposed")}>
          提案中として新しい版を保存
        </button>{" "}
        <button type="button" disabled={disabled} onClick={() => void save("active")}>
          有効として新しい版を保存
        </button>{" "}
        <button type="button" disabled={disabled} onClick={() => void save("inactive")}>
          無効として新しい版を保存
        </button>
      </p>
      <p className="note">
        「有効」で保存するときは、勘定科目・税区分などが現在のマスタにあることを保存時に確認します。「無効」と「提案中」では、古い科目が無効になっていても保存できます。
        {locked && " この画面の内容は保存済み、または最新ではない可能性があるため、「最新の状態を読み込む」を押してから続けてください。"}
      </p>
    </form>
  );
}
