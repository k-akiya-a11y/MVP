"use client";

import Link from "next/link";
import { useState } from "react";
import { createNoteSchema, NOTE_CREATE_UNKNOWN_MESSAGE } from "@/lib/notes/create-schema";
import { formatNoteIssues } from "@/lib/notes/editor-schema";
import type { CreateNoteResult } from "@/lib/notes/create-submit";
import { createCustomerNoteAction } from "./actions";

type Props = {
  customerId: string;
  /** URL で固定された依頼ID（そのまま新しいメモのIDになる）。再読み込みしても変わらず、DB 側で同じIDの2回目の保存を拒否する */
  requestId: string;
};

/**
 * 新しいメモを「無効」の版1で保存する。タイトルと本文は空欄から始まり、人が入力するまで保存できない。
 * 保存は明示的なボタン1つだけ。保存済み・結果不明・競合のあとは、この画面から再送できないようにする。
 */
export function NewNoteForm({ customerId, requestId }: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const notesHref = `/customers/${customerId}/notes`;

  async function save() {
    if (!confirmed || busy || locked) return;
    // 状態・版・作成者は送らない（サーバーと DB 関数が決める）
    const input = { customerId, requestId, title, body };
    const checked = createNoteSchema.safeParse(input);
    if (!checked.success) {
      setNotice({ tone: "error", text: formatNoteIssues(checked.error) });
      return;
    }
    setBusy(true);
    try {
      // 送信は1回だけ。例外でも自動では再送しない
      const result: CreateNoteResult = await createCustomerNoteAction(input);
      if (result.ok || result.outcome === "unknown" || result.code === "conflict") setLocked(true);
      if (result.ok) setConfirmed(false);
      setNotice({ tone: result.ok ? "ok" : "error", text: result.message });
    } catch {
      setLocked(true);
      setNotice({ tone: "error", text: NOTE_CREATE_UNKNOWN_MESSAGE });
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
      <p className="note">
        メモID（依頼ID）: <code>{requestId}</code>（保存の結果が不明なときは、このIDで一覧を確認できます）
      </p>
      <label>
        タイトル
        <input
          type="text"
          value={title}
          disabled={busy || locked}
          onChange={(e) => {
            setConfirmed(false);
            setTitle(e.target.value);
          }}
        />
      </label>
      <label>
        本文
        <textarea
          rows={8}
          value={body}
          disabled={busy || locked}
          onChange={(e) => {
            setConfirmed(false);
            setBody(e.target.value);
          }}
        />
      </label>
      <p className="note">同じ画面（同じ依頼ID）から保存できるのは1回だけです。再読み込みしても、2回目は保存されません。</p>
      <p>
        <label>
          <input type="checkbox" checked={confirmed} disabled={busy || locked} onChange={(e) => setConfirmed(e.target.checked)} />
          上のタイトルと本文を確認しました。「無効」で保存され、AI にはまだ使われないことを理解しました
        </label>
      </p>
      <p>
        <button type="button" disabled={disabled} onClick={() => void save()}>
          無効で保存（AIにはまだ使わない）
        </button>
      </p>

      {notice && (
        <p className={notice.tone === "error" ? "error" : "note"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      )}
      {locked && (
        <p className="note">
          この画面からは再送できません。メモID（依頼ID）: <code>{requestId}</code>。<Link href={notesHref}>文章メモの一覧</Link>で確認してください。
        </p>
      )}
    </form>
  );
}
