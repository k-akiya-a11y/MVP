import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCandidateSource, CANDIDATE_LOAD_FAILED_MESSAGE, type CandidateSource } from "@/lib/rules/candidate-load";
import { parseCandidateQuery } from "@/lib/rules/candidate-schema";
import { createUserClient } from "@/lib/supabase/server";
import { NewRuleForm } from "./new-rule-form";

// 依頼IDは URL で固定する。ページ自体は毎回、最新の過去仕訳とマスタで候補を確かめる
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function NewRulePage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { customerId } = await params;
  // URL の値はすべて外部入力。形式が正しくなければ読込にも進まず、入力値も画面に出さない
  const query = parseCandidateQuery(await searchParams);

  let source: CandidateSource | null = null;
  let failure = false;
  if (query) {
    try {
      source = await loadCandidateSource(await createUserClient(), customerId, query);
    } catch {
      // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
      failure = true;
    }
    if (!failure && !source) notFound();
  }

  const rulesHref = `/customers/${customerId}/rules`;
  const pastQualityHref = `/customers/${customerId}/past-quality`;

  return (
    <main>
      <p>
        <Link href={pastQualityHref}>← 過去仕訳の科目の揺れに戻る</Link>
        {" / "}
        <Link href={rulesHref}>既存の顧客ルールを確認する</Link>
      </p>
      <h1>{source ? `${source.customer.name}：過去仕訳の候補から新しいルールを作る` : "過去仕訳の候補から新しいルールを作る"}</h1>
      <p className="note">
        過去仕訳で科目が1種類だけだった取引先を、「提案中」のルールとして保存します。ページを開いただけでは何も保存されず、下のボタンを押したときだけ保存されます。
      </p>

      {!query && (
        <p className="error">
          候補の指定が正しくないため、表示できません。<Link href={pastQualityHref}>過去仕訳の画面</Link>から候補を選び直してください。
        </p>
      )}
      {failure && <p className="error">{CANDIDATE_LOAD_FAILED_MESSAGE}</p>}
      {source?.kind === "blocked" && source.reason === "candidate_missing" && (
        <p className="error">
          指定された候補は、最新の過去仕訳にはありません（取引先キーが見つからない、科目が複数に分かれた、科目が変わった等）。保存できません。
          <Link href={pastQualityHref}>過去仕訳の画面</Link>で確認し直してください。
        </p>
      )}
      {source?.kind === "blocked" && source.reason === "account_unavailable" && (
        <p className="error">
          この候補の勘定科目は、現在の有効なマスタにありません（無効になった、またはマスタにない）。このままルールにすることはできないため、保存できません。
          科目のマスタを確認してください。
        </p>
      )}
      {query && source?.kind === "ready" && (
        // key に依頼ID・顧客・候補の中身・表示する根拠とマスタを含め、別の候補や、同じ依頼IDで根拠・選択肢が変わったときに
        // 入力済みの税区分・優先順位と確認を引き継がない（JSON の配列なので区切りの曖昧さがない）
        <NewRuleForm
          key={JSON.stringify([
            customerId,
            query.requestId,
            source.candidate.partnerKey,
            source.candidate.direction,
            source.candidate.accountItemId,
            source.candidate.count,
            source.candidate.dateRange.from,
            source.candidate.dateRange.to,
            source.account.id,
            source.account.name,
            source.taxOptions.map((t) => [t.id, t.name]),
          ])}
          customerId={customerId}
          requestId={query.requestId}
          candidate={{
            partnerKey: source.candidate.partnerKey,
            direction: source.candidate.direction,
            accountItemId: source.candidate.accountItemId,
            count: source.candidate.count,
            dateRange: source.candidate.dateRange,
          }}
          accountName={source.account.name}
          taxOptions={source.taxOptions}
        />
      )}
    </main>
  );
}
