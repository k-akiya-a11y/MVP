"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { draftToInput, toDraft, type NoteDraft } from "@/lib/notes/editor-draft";
import type { EditorNote } from "@/lib/notes/editor-load";
import { NOTE_STATUS_LABEL, type NoteStatus } from "@/lib/notes/editor-schema";
import { UNKNOWN_OUTCOME_MESSAGE, type NoteSubmitResult } from "@/lib/notes/editor-submit";
import { saveNoteVersionAction } from "./actions";

type Props = { customerId: string; notes: EditorNote[] };

type Notice = { tone: "ok" | "error"; text: string; needsReload: boolean };

/** メモの文章はすべてエスケープされた React のテキストとして出す（HTML として描画しない）。改行はそのまま見せる */
const TEXT_STYLE = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as const;

/** 既存メモの一覧と、選んだメモの編集。保存は明示的なボタンだけで、選択や表示では何も保存・有効化しない */
export function NoteEditor({ customerId, notes }: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reloads, setReloads] = useState(0);
  const selected = notes.find((n) => n.noteId === selectedId) ?? null;

  if (notes.length === 0) {
    return <p>保存されているメモはありません。上の「新しいメモを作る」から作成できます。</p>;
  }

  return (
    <>
      <table>
        <thead>
          <tr>
            <th>メモID</th>
            <th>状態</th>
            <th className="num">版</th>
            <th>タイトル</th>
            <th>本文</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {notes.map((n) => (
            <tr key={n.noteId}>
              <td>
                <code>{n.noteId}</code>
              </td>
              <td>{NOTE_STATUS_LABEL[n.status]}</td>
              <td className="num">{n.version}</td>
              <td style={TEXT_STYLE}>{n.title}</td>
              <td style={TEXT_STYLE}>{n.body}</td>
              <td>
                <button
                  type="button"
                  aria-pressed={n.noteId === selectedId}
                  onClick={() => {
                    setSelectedId(n.noteId);
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
        <NoteForm
          key={`${selected.noteId}:${selected.version}:${reloads}`}
          customerId={customerId}
          note={selected}
          onResult={(result) => {
            setNotice({
              tone: result.ok ? "ok" : "error",
              text: result.message,
              needsReload: !result.ok && (result.outcome === "unknown" || result.code === "stale" || result.code === "conflict"),
            });
            if (result.ok) router.refresh();
          }}
        />
      )}
    </>
  );
}

function NoteForm({ customerId, note, onResult }: { customerId: string; note: EditorNote; onResult: (result: NoteSubmitResult) => void }) {
  const [draft, setDraft] = useState<NoteDraft>(() => toDraft(note));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  // 保存済み・結果不明・競合のあとは、最新を読み込み直すまで同じ画面から再送できないようにする
  const [locked, setLocked] = useState(false);

  // 内容を変えたら確認は取り消す（確認は現在の内容に対するもの）
  const set = <K extends keyof NoteDraft>(key: K, value: NoteDraft[K]) => {
    setConfirmed(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  async function save(status: NoteStatus) {
    if (!confirmed || busy || locked) return;
    setBusy(true);
    try {
      // 送信は1回だけ。例外でも自動では再送しない
      const result = await saveNoteVersionAction(draftToInput({ customerId, note, status, draft }));
      if (result.ok || result.outcome === "unknown" || result.code === "stale" || result.code === "conflict") setLocked(true);
      if (result.ok) setConfirmed(false);
      onResult(result);
    } catch {
      setLocked(true);
      onResult({ ok: false, outcome: "unknown", code: "unknown", message: UNKNOWN_OUTCOME_MESSAGE });
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
      <h2>
        メモの編集（現在: 版{note.version}、{NOTE_STATUS_LABEL[note.status]}）
      </h2>
      <p className="note">
        メモID: <code>{note.noteId}</code>（保存の結果が不明なときは、このIDと版で一覧を確認できます）
      </p>
      <p className="note">
        保存すると版{note.version + 1}が追加されます。版{note.version}を含む以前の版は消えず、上書きもされません。
        「有効」で保存したメモは、以降に作る仕訳候補で AI に渡される参考データです（命令ではなく、承認の省略や権限の付与にはなりません）。
        「無効」で保存すると、以降の仕訳候補には使われません。
      </p>
      <label>
        タイトル
        <input type="text" value={draft.title} disabled={busy || locked} onChange={(e) => set("title", e.target.value)} />
      </label>
      <label>
        本文
        <textarea rows={8} value={draft.body} disabled={busy || locked} onChange={(e) => set("body", e.target.value)} />
      </label>
      <p>
        <label>
          <input type="checkbox" checked={confirmed} disabled={busy || locked} onChange={(e) => setConfirmed(e.target.checked)} />
          上の内容と、保存後の状態を確認しました
        </label>
      </p>
      <p>
        <button type="button" disabled={disabled} onClick={() => void save("active")}>
          有効として新しい版を保存
        </button>{" "}
        <button type="button" disabled={disabled} onClick={() => void save("inactive")}>
          無効として新しい版を保存
        </button>
      </p>
      <p className="note">
        「有効」で保存するにはタイトルと本文が必要です。「無効」にするときは、保存済みの内容が空白だけでも保存できます。
        {locked && " この画面の内容は保存済み、または最新ではない可能性があるため、「最新の状態を読み込む」を押してから続けてください。"}
      </p>
    </form>
  );
}
