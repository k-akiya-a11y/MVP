import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { newNoteHref } from "@/lib/notes/create-schema";
import { loadNoteEditor, NOTE_LOAD_FAILED_MESSAGE, type NoteEditorData } from "@/lib/notes/editor-load";
import { createUserClient } from "@/lib/supabase/server";
import { NoteEditor } from "./note-editor";

export const dynamic = "force-dynamic";

export default async function NotesPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;

  // 読込に失敗しても承認画面には影響させず、固定の失敗文を表示する（「メモなし」とは区別する）
  let data: NoteEditorData | null = null;
  let failure = false;
  try {
    data = await loadNoteEditor(await createUserClient(), customerId);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  if (!failure && !data) notFound();

  return (
    <main>
      <p>
        <Link href={`/customers/${customerId}`}>← 承認画面に戻る</Link>
        {" / "}
        <Link href={`/customers/${customerId}/rules`}>顧客ルールを確認・編集する</Link>
      </p>
      <h1>{data ? `${data.customer.name}：文章メモ` : "文章メモ"}</h1>
      <p className="note">
        保存されている文章メモの現在の版を確認し、タイトルと本文を直して新しい版として保存できます。新しいメモは「新しいメモを作る」から、「無効」の状態で作成できます（AI に使うには、作成後にこのページで人が「有効」にします）。
      </p>
      {data && (
        <p>
          {/* 依頼ID（= 新しいメモのID）は描画のたびにサーバーで生成し、リンク先の URL に固定する */}
          <Link href={newNoteHref(customerId, randomUUID())}>新しいメモを作る</Link>
        </p>
      )}
      <ul className="note">
        <li>
          「有効」なメモは、以降に作る仕訳候補で AI に渡される<strong>参考データ</strong>です。メモは AI への命令ではなく、メモに書いた文章で権限を与えたり、人の承認を省いたり、ツールや外部サービスを動かしたりすることはできません。
        </li>
        <li>AI の提案は、マスタにある値だけが受け付けられ、確信度はプログラムが計算し、Phase 1 では必ず人（承認者）が確認して承認します。メモで変わりません。</li>
        <li>
          取引の例、例外、経理上の注意（例：「私用分は役員貸付金で処理」）は書いて構いません。パスワードなどの秘密情報、不要な個人情報、システムの権限を変えたり承認を省いたりする内容は書かないでください。
        </li>
        <li>保存は、内容を確認したうえで「有効」または「無効」のボタンを押したときだけ行われます。ページを開いたり、メモを選んだりしても、何も保存・有効化されません。</li>
        <li>変更は上書きされず、新しい版が追加されます。以前の版は消えず、判断ログが指すメモの版も変わりません。すでに作成済みの仕訳候補は変わりません。</li>
        <li>担当している顧客のメモだけを扱えます。同時に別の人が更新していた場合は、保存せずに最新を読み込み直してもらいます。</li>
      </ul>
      {failure && <p className="error">{NOTE_LOAD_FAILED_MESSAGE}</p>}
      {data && <NoteEditor customerId={customerId} notes={data.notes} />}
    </main>
  );
}
