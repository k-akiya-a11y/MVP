"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntryJson, MasterOption, ReviewItem, ReviewQueue } from "@/lib/review/queue";
import { bulkApprovalTargets } from "@/lib/review/selection";
import { bulkApproveAction, reviewAction } from "./actions";

type Tab = "high" | "medium" | "low" | "on_hold";
const TABS: { id: Tab; label: string }[] = [
  { id: "high", label: "高（まとめて承認）" },
  { id: "medium", label: "中（1件ずつ承認）" },
  { id: "low", label: "低（担当者が確認して入力）" },
  { id: "on_hold", label: "保留" },
];
const CONFIDENCE_LABEL = { high: "高", medium: "中", low: "低" } as const;

const yen = (n: number) => n.toLocaleString("ja-JP");
const secondsSince = (t: number) => Math.max(0, Math.round((Date.now() - t) / 1000));

function inTab(item: ReviewItem, tab: Tab) {
  return tab === "on_hold" ? item.txn.status === "on_hold" : item.txn.status === "proposed" && item.confidence === tab;
}

const emptyEntry = (): EntryJson => ({
  account_item_id: 0,
  tax_code: 0,
  partner_id: null,
  item_id: null,
  section_id: null,
  tag_ids: [],
  description: "",
});

/**
 * 承認画面（設計書7章）。明細・AI の案・根拠を並べ、キーボードだけで操作できる。
 * j / k: 前後の明細、a: 承認、e: 修正、h: 保留、x: 却下、Space: 選択（高のみ）、Shift+A: 選択分をまとめて承認
 * 表示から確定までの秒数を記録する（KPI「人間作業時間」の補助データ）。
 * 承認・修正・却下は承認者（管理者）だけ。担当者は理由を添えて保留にする（DB の関数でも同じ判定をする）。
 */
export function ReviewBoard({
  customerId,
  canApprove,
  items,
  masters,
}: {
  customerId: string;
  canApprove: boolean;
  items: ReviewItem[];
  masters: ReviewQueue["masters"];
}) {
  const [tab, setTab] = useState<Tab>("high");
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<EntryJson | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownAt = useRef(Date.now());
  const tabShownAt = useRef(Date.now());

  const visible = useMemo(() => items.filter((i) => inTab(i, tab)), [items, tab]);
  const current = visible[Math.min(index, Math.max(visible.length - 1, 0))];
  // まとめて承認の対象は「いま高のタブに表示されている明細」のうち選択したものだけ。
  // 保留・却下などで一覧から外れた明細の ID が選択に残っても、送らない。
  const bulkTargets = useMemo(() => (tab === "high" ? bulkApprovalTargets(visible, selected) : []), [selected, tab, visible]);

  // 一覧が変わったら（確認後の再読込など）、表示されていない明細を選択から外す
  useEffect(() => {
    const shown = new Set(visible.map((v) => v.decisionId));
    setSelected((s) => {
      const next = new Set([...s].filter((id) => shown.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [visible]);

  const name = useCallback(
    (kind: keyof ReviewQueue["masters"], id: number | null) =>
      id === null ? "—" : (masters[kind].find((m) => m.id === id)?.name ?? `（不明 ${id}）`),
    [masters],
  );

  // 表示中の明細が変わったら計測をやり直す
  useEffect(() => {
    shownAt.current = Date.now();
    setEditing(null);
    setReason("");
  }, [current?.decisionId]);
  useEffect(() => {
    tabShownAt.current = Date.now();
    setIndex(0);
    setSelected(new Set());
  }, [tab]);

  const act = useCallback(
    async (action: "approve" | "correct" | "hold" | "reject", entry: EntryJson | null = null) => {
      if (!current || busy) return;
      if (action !== "hold" && !canApprove) return;
      setBusy(true);
      setMessage(null);
      // 確認した明細は、結果にかかわらずまとめて承認の選択から外す（保留した明細が混ざらないように）
      const decided = current.decisionId;
      setSelected((s) => {
        if (!s.has(decided)) return s;
        const next = new Set(s);
        next.delete(decided);
        return next;
      });
      try {
        const result = await reviewAction(customerId, {
          decisionId: current.decisionId,
          action,
          finalEntry: action === "correct" ? entry : null,
          reason: reason || null,
          reviewSeconds: secondsSince(shownAt.current),
          bulk: false,
        });
        setMessage(result.ok ? null : result.error);
      } finally {
        setBusy(false);
      }
    },
    [busy, canApprove, current, customerId, reason],
  );

  const bulkApprove = useCallback(async () => {
    if (!canApprove || bulkTargets.length === 0 || busy) return;
    setBusy(true);
    try {
      // まとめて承認は一覧を見ていた時間を件数で割って1件あたりの秒数にする
      const perItem = Math.round(secondsSince(tabShownAt.current) / bulkTargets.length);
      const result = await bulkApproveAction(
        customerId,
        bulkTargets.map((item) => ({ decisionId: item.decisionId, reviewSeconds: perItem })),
      );
      setSelected(new Set());
      tabShownAt.current = Date.now();
      setMessage(
        result.failures.length
          ? `${result.approved}件を承認、${result.failures.length}件は承認できませんでした: ${result.failures[0]?.error}`
          : `${result.approved}件を承認しました`,
      );
    } finally {
      setBusy(false);
    }
  }, [bulkTargets, busy, canApprove, customerId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (editing || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (e.key === "j") setIndex((i) => Math.min(i + 1, visible.length - 1));
      else if (e.key === "k") setIndex((i) => Math.max(i - 1, 0));
      else if (e.key === "A" && e.shiftKey && tab === "high" && canApprove) void bulkApprove();
      else if (e.key === "a" && current?.proposal && canApprove) void act("approve");
      else if (e.key === "e" && current && canApprove) setEditing(current.proposal ? { ...current.proposal } : emptyEntry());
      else if (e.key === "h" && current && tab !== "on_hold") void act("hold");
      else if (e.key === "x" && current && canApprove) void act("reject");
      else if (e.key === " " && current && tab === "high" && canApprove) {
        e.preventDefault();
        setSelected((s) => {
          const next = new Set(s);
          if (next.has(current.decisionId)) next.delete(current.decisionId);
          else next.add(current.decisionId);
          return next;
        });
      } else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, bulkApprove, canApprove, current, editing, tab, visible.length]);

  return (
    <section>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={t.id === tab ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}（{items.filter((i) => inTab(i, t.id)).length}）
          </button>
        ))}
      </nav>
      {canApprove ? (
        <p className="note">j / k: 移動、a: 承認、e: 修正、h: 保留、x: 却下{tab === "high" && "、Space: 選択、Shift+A: 選択分をまとめて承認"}</p>
      ) : (
        <p className="note">j / k: 移動、h: 保留。承認・修正・却下は承認者（管理者）が行います。気づいたことは理由に書いて保留にしてください。</p>
      )}
      {message && <p className="error">{message}</p>}

      {tab === "high" && canApprove && visible.length > 0 && (
        <p>
          <button type="button" onClick={() => setSelected(new Set(visible.map((v) => v.decisionId)))}>
            すべて選択
          </button>{" "}
          <button type="button" disabled={bulkTargets.length === 0 || busy} onClick={() => void bulkApprove()}>
            選択した {bulkTargets.length} 件をまとめて承認
          </button>
        </p>
      )}

      <div className="board">
        <table className="list">
          <thead>
            <tr>
              {tab === "high" && canApprove && <th />}
              <th>日付</th>
              <th className="num">金額</th>
              <th>摘要</th>
              <th>科目（案）</th>
              <th>確信度</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item, i) => (
              <tr key={item.decisionId} className={item === current ? "current" : ""} onClick={() => setIndex(i)}>
                {tab === "high" && canApprove && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label="選択"
                      checked={selected.has(item.decisionId)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(item.decisionId);
                          else next.delete(item.decisionId);
                          return next;
                        })
                      }
                    />
                  </td>
                )}
                <td>{item.txn.date}</td>
                <td className={`num ${item.txn.direction}`}>{item.txn.direction === "income" ? "+" : "-"}{yen(item.txn.amount)}</td>
                <td>{item.txn.description}</td>
                <td>{item.proposal ? name("account_item", item.proposal.account_item_id) : "（提案なし）"}</td>
                <td>{CONFIDENCE_LABEL[item.confidence]}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p>この区分の明細はありません。</p>}

        {current && (
          <div className="detail">
            <h2>
              {current.txn.date} {current.txn.direction === "income" ? "入金" : "出金"} {yen(current.txn.amount)}円
            </h2>
            <p>
              {current.txn.walletName} ／ 摘要「{current.txn.description}」
            </p>

            {editing ? (
              <EntryEditor
                entry={editing}
                masters={masters}
                reason={reason}
                onReason={setReason}
                onChange={setEditing}
                onCancel={() => setEditing(null)}
                onSave={() => void act("correct", editing)}
                busy={busy}
              />
            ) : (
              <>
                <h3>AI の案（確信度 {CONFIDENCE_LABEL[current.confidence]}）</h3>
                {current.proposal ? (
                  <dl className="entry">
                    <dt>勘定科目</dt>
                    <dd>{name("account_item", current.proposal.account_item_id)}</dd>
                    <dt>税区分</dt>
                    <dd>{name("tax", current.proposal.tax_code)}</dd>
                    <dt>取引先</dt>
                    <dd>{name("partner", current.proposal.partner_id)}</dd>
                    <dt>品目</dt>
                    <dd>{name("item", current.proposal.item_id)}</dd>
                    <dt>部門</dt>
                    <dd>{name("section", current.proposal.section_id)}</dd>
                    <dt>メモタグ</dt>
                    <dd>{current.proposal.tag_ids.map((t) => name("tag", t)).join("、") || "—"}</dd>
                    <dt>摘要</dt>
                    <dd>{current.proposal.description || "—"}</dd>
                  </dl>
                ) : (
                  <p>提案はありません。内容を確認して入力してください（e）。</p>
                )}
                <label>
                  理由・メモ（保留・却下のとき）
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
                </label>
                <div className="actions">
                  {canApprove && (
                    <>
                      <button type="button" disabled={!current.proposal || busy} onClick={() => void act("approve")}>
                        承認 (a)
                      </button>
                      <button type="button" disabled={busy} onClick={() => setEditing(current.proposal ? { ...current.proposal } : emptyEntry())}>
                        修正 (e)
                      </button>
                    </>
                  )}
                  {tab !== "on_hold" && (
                    <button type="button" disabled={busy} onClick={() => void act("hold")}>
                      保留 (h)
                    </button>
                  )}
                  {canApprove && (
                    <button type="button" disabled={busy} onClick={() => void act("reject")}>
                      却下 (x)
                    </button>
                  )}
                </div>
              </>
            )}

            <h3>根拠</h3>
            <ul>
              {current.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
              <li>
                ルール: {current.rule ? `一致（${current.rule.ruleId.slice(0, 8)} 版${current.rule.version}）` : "一致なし"}
              </li>
              <li>
                過去仕訳: {current.past.matchType === "none" ? "なし（新規取引先）" : `${current.past.total}件（${current.past.matchType === "exact" ? "完全一致" : "類似"}）`}
                {current.past.majorityShare !== null && `、最多の組合せが ${Math.round(current.past.majorityShare * 100)}%`}
              </li>
              {current.checks.map((c) => (
                <li key={c.id} className={c.passed ? "" : "error"}>
                  検査: {c.detail}
                </li>
              ))}
            </ul>
            {current.aiUsed && (
              <>
                <h3>AI の理由</h3>
                <p>{current.aiReason ?? "—"}</p>
              </>
            )}
            {current.unknowns.length > 0 && (
              <>
                <h3>わからないこと</h3>
                <ul>
                  {current.unknowns.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </>
            )}
            {current.pastExamples.length > 0 && (
              <>
                <h3>参照した過去仕訳</h3>
                <table>
                  <tbody>
                    {current.pastExamples.map((p) => (
                      <tr key={p.id}>
                        <td>{p.date}</td>
                        <td className="num">{yen(p.amount)}</td>
                        <td>{p.bankDescription}</td>
                        <td>
                          {name("account_item", p.entry.account_item_id)}／{name("tax", p.entry.tax_code)}
                        </td>
                        <td>{p.entry.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function MasterSelect({
  label,
  options,
  value,
  required,
  onChange,
}: {
  label: string;
  options: MasterOption[];
  value: number | null;
  required?: boolean;
  onChange: (v: number | null) => void;
}) {
  return (
    <label>
      {label}
      <select
        value={value ?? ""}
        required={required}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      >
        <option value="">{required ? "選択してください" : "—"}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 修正・入力フォーム。選べるのはマスタの写しにある値だけ。Ctrl+Enter で保存、Esc で取消 */
function EntryEditor({
  entry,
  masters,
  reason,
  onReason,
  onChange,
  onCancel,
  onSave,
  busy,
}: {
  entry: EntryJson;
  masters: ReviewQueue["masters"];
  reason: string;
  onReason: (v: string) => void;
  onChange: (e: EntryJson) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const valid = entry.account_item_id > 0 && entry.tax_code > 0;
  return (
    <form
      className="editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && valid) onSave();
      }}
    >
      <MasterSelect
        label="勘定科目"
        required
        options={masters.account_item}
        value={entry.account_item_id || null}
        onChange={(v) => onChange({ ...entry, account_item_id: v ?? 0 })}
      />
      <MasterSelect
        label="税区分"
        required
        options={masters.tax}
        value={entry.tax_code || null}
        onChange={(v) => onChange({ ...entry, tax_code: v ?? 0 })}
      />
      <MasterSelect label="取引先" options={masters.partner} value={entry.partner_id} onChange={(v) => onChange({ ...entry, partner_id: v })} />
      <MasterSelect label="品目" options={masters.item} value={entry.item_id} onChange={(v) => onChange({ ...entry, item_id: v })} />
      <MasterSelect label="部門" options={masters.section} value={entry.section_id} onChange={(v) => onChange({ ...entry, section_id: v })} />
      <label>
        メモタグ
        <select
          multiple
          value={entry.tag_ids.map(String)}
          onChange={(e) => onChange({ ...entry, tag_ids: [...e.target.selectedOptions].map((o) => Number(o.value)) })}
        >
          {masters.tag.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        摘要
        <input value={entry.description} maxLength={250} onChange={(e) => onChange({ ...entry, description: e.target.value })} />
      </label>
      <label>
        修正理由（任意）
        <input value={reason} maxLength={1000} onChange={(e) => onReason(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" disabled={!valid || busy}>
          保存 (Ctrl+Enter)
        </button>
        <button type="button" onClick={onCancel}>
          取消 (Esc)
        </button>
      </div>
    </form>
  );
}
