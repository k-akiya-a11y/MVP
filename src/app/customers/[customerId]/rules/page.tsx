import Link from "next/link";
import { notFound } from "next/navigation";
import { loadRuleEditor, RULE_LOAD_FAILED_MESSAGE, type RuleEditorData } from "@/lib/rules/editor-load";
import { createUserClient } from "@/lib/supabase/server";
import { RuleEditor } from "./rule-editor";

export const dynamic = "force-dynamic";

export default async function RulesPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;

  // 読込に失敗しても承認画面には影響させず、固定の失敗文を表示する（「ルールなし」とは区別する）
  let data: RuleEditorData | null = null;
  let failure = false;
  try {
    data = await loadRuleEditor(await createUserClient(), customerId);
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
        <Link href={`/customers/${customerId}/past-quality`}>過去仕訳の科目の揺れを確認する</Link>
        {" / "}
        <Link href={`/customers/${customerId}/notes`}>文章メモを確認・編集する</Link>
      </p>
      <h1>{data ? `${data.customer.name}：顧客ルール` : "顧客ルール"}</h1>
      <p className="note">
        保存されているルールの現在の版を確認し、内容を直して新しい版として保存できます。このページでは新しいルールの作成と、過去仕訳の候補からの自動変換はできません。文章メモは、上の「文章メモを確認・編集する」から専用のページで確認・編集できます。
      </p>
      <ul className="note">
        <li>保存は、内容を確認したうえで「提案中」「有効」「無効」のいずれかのボタンを押したときだけ行われます。ページを開いたり、ルールを選んだりしても、何も保存・有効化されません。</li>
        <li>変更は上書きされず、新しい版が追加されます。以前の版は消えず、判断ログが指すルールの版も変わりません。</li>
        <li>「有効」のルールは、以降に作る仕訳候補の照合に使われ、ルールに一致した取引は AI を呼ばずにルールの処理が提案されます。すでに作成済みの仕訳候補は変わりません。</li>
        <li>ルールに一致した候補も、Phase 1 では必ず人（承認者）が確認して承認します。自動では確定・登録されません。</li>
        <li>担当している顧客のルールだけを扱えます。同時に別の人が更新していた場合は、保存せずに最新を読み込み直してもらいます。</li>
      </ul>
      {failure && <p className="error">{RULE_LOAD_FAILED_MESSAGE}</p>}
      {data && <RuleEditor customerId={customerId} rules={data.rules} masters={data.masters} wallets={data.wallets} />}
    </main>
  );
}
