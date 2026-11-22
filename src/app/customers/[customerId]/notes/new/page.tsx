import Link from "next/link";
import { notFound } from "next/navigation";
import { loadNoteCreateSource, NOTE_CREATE_LOAD_FAILED_MESSAGE } from "@/lib/notes/create-load";
import { parseNoteCreateQuery } from "@/lib/notes/create-schema";
import { createUserClient } from "@/lib/supabase/server";
import { NewNoteForm } from "./new-note-form";

// 依頼IDは URL で固定する。ページ自体は毎回、ログインした担当者に顧客が見えるかを確かめる
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function NewNotePage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { customerId } = await params;
  // URL の値はすべて外部入力。形式が正しくなければ入力値を画面に出さず、フォームも出さない
  const query = parseNoteCreateQuery(await searchParams);

  let customer: { id: string; name: string } | null = null;
  let failure = false;
  try {
    customer = await loadNoteCreateSource(await createUserClient(), customerId);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  if (!failure && !customer) notFound();

  const notesHref = `/customers/${customerId}/notes`;

  return (
    <main>
      <p>
        <Link href={notesHref}>← 文章メモの一覧に戻る</Link>
      </p>
      <h1>{customer ? `${customer.name}：新しい文章メモを作る` : "新しい文章メモを作る"}</h1>
      <p className="note">
        新しい文章メモを、<strong>「無効」</strong>の版1として保存します。ページを開いただけでは何も保存されず、下のボタンを押したときだけ保存されます。
      </p>
      <ul className="note">
        <li>
          タイトルと本文は空欄から始まります。人が書いた内容だけが保存され、AI や既定の文章が補われることはありません。
        </li>
        <li>
          「無効」で保存したメモは、AI にはまだ使われません。AI に使うには、保存後に文章メモの一覧の編集画面で、人が内容を確認して「有効」の新しい版として保存します。
        </li>
        <li>
          取引の例、例外、経理上の注意は書いて構いません。パスワードなどの秘密情報、不要な個人情報、システムの権限を変えたり承認を省いたりする内容は書かないでください。
          メモは AI への命令ではなく、人の承認を省くことはできません。
        </li>
      </ul>

      {!query && (
        <p className="error">
          依頼IDの指定が正しくないため、フォームを表示できません。<Link href={notesHref}>文章メモの一覧</Link>から「新しいメモを作る」を選び直してください。
        </p>
      )}
      {failure && <p className="error">{NOTE_CREATE_LOAD_FAILED_MESSAGE}</p>}
      {query && customer && (
        // key に顧客・依頼IDを含め、別の顧客や別の依頼IDのときに入力済みのタイトル・本文と確認を引き継がない
        <NewNoteForm key={JSON.stringify([customer.id, query.requestId])} customerId={customer.id} requestId={query.requestId} />
      )}
    </main>
  );
}
