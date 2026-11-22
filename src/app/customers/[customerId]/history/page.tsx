import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ENTRY_FIELDS,
  loadReviewHistory,
  MAX_PAGE,
  masterKey,
  parseHistoryPage,
  type EntryRecord,
  type HistoryRow,
  type MasterNames,
  type ReviewHistory,
} from "@/lib/review/history";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const ACTION_LABEL = { approve: "承認", correct: "修正して承認", hold: "保留", reject: "却下" } as const;
const NOT_RECORDED = "（記録なし）";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const direction = (d: "income" | "expense") => (d === "income" ? "入金" : "出金");

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

function idLabel(kind: string, id: number, masters: MasterNames): string {
  const m = masters.get(masterKey(kind, id));
  if (!m) return `ID ${id}（マスタに名前がありません）`;
  return `${m.name}（ID ${id}${m.available ? "" : "、現在は無効"}）`;
}

/** 仕訳の1項目の表示。値の形が想定と違うときは推測せず「表示できない形式」にする */
function fieldText(field: (typeof ENTRY_FIELDS)[number], v: unknown, masters: MasterNames): string {
  if (v === undefined) return NOT_RECORDED;
  if (v === null) return "なし";
  const kind = field.kind;
  if (kind === null) return typeof v === "string" ? (v === "" ? "（空）" : v) : "表示できない形式";
  if (Array.isArray(v)) {
    if (v.length === 0) return "なし";
    return v.every((x) => typeof x === "number") ? v.map((x: number) => idLabel(kind, x, masters)).join("、") : "表示できない形式";
  }
  return typeof v === "number" ? idLabel(kind, v, masters) : "表示できない形式";
}

export default async function ReviewHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { customerId } = await params;
  const page = parseHistoryPage((await searchParams).page);

  let data: ReviewHistory | null = null;
  let failure = false;
  try {
    data = await loadReviewHistory(await createUserClient(), customerId, page);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  // 顧客が見えない（権限外・存在しない）ときは、履歴の有無を示さず 404 にする
  if (!failure && !data) notFound();

  return (
    <main>
      <p>
        <Link href={`/customers/${customerId}`}>← 承認画面に戻る</Link>
      </p>
      <h1>{data ? `${data.customer.name}：確認の履歴` : "確認の履歴"}</h1>
      <p className="note">
        この顧客について、人が記録した確認（承認・修正・保留・却下）を新しい順に表示します。読み取り専用で、ここから記録の変更・取消・再確認はできません。
        「承認」「修正して承認」はこのアプリでの人の確認の記録です。freee への登録が済んだことを示すものではなく、登録の結果はこの画面では確認していません。
      </p>
      {failure && (
        <p className="error">
          確認の履歴を読み込めなかったため表示できません（「記録がない」ことを意味しません）。時間をおいて再読み込みしてください。
        </p>
      )}
      {data && <History data={data} customerId={customerId} />}
    </main>
  );
}

function History({ data, customerId }: { data: ReviewHistory; customerId: string }) {
  const href = (p: number) => (p <= 1 ? `/customers/${customerId}/history` : `/customers/${customerId}/history?page=${p}`);
  if (data.rows.length === 0) {
    return data.page === 1 ? (
      <p>この顧客の確認の記録はまだありません。</p>
    ) : (
      <p>
        このページに記録はありません。<Link href={href(1)}>最初のページに戻る</Link>
      </p>
    );
  }
  const nav = (
    <p>
      {data.hasPrevious ? <Link href={href(data.page - 1)}>← 前のページ（新しい記録）</Link> : null}
      {data.hasPrevious && data.hasNext ? " / " : null}
      {data.hasNext ? <Link href={href(data.page + 1)}>次のページ（古い記録）→</Link> : null}
    </p>
  );
  return (
    <>
      <p>
        {data.page} ページ目（1ページ {data.pageSize} 件、このページ {data.rows.length} 件）
      </p>
      <p className="note">閲覧中に新しい確認が記録されると、ページの区切りがずれて同じ記録が前後のページに出ることがあります。</p>
      {nav}
      {data.rows.map((row) => (
        <Row key={row.reviewId} row={row} masters={data.masters} />
      ))}
      {nav}
      {data.olderBeyondLimit && (
        <p className="note">
          これより古い記録がありますが、この画面で表示できるのはここまでです（最大 {MAX_PAGE.toLocaleString("ja-JP")} ページ）。残りの記録はこの画面からは確認できません。
        </p>
      )}
    </>
  );
}

function Row({ row, masters }: { row: HistoryRow; masters: MasterNames }) {
  const hasEntries = row.action === "approve" || row.action === "correct";
  const proposal = row.proposal.state === "ok" ? row.proposal.entry : null;
  return (
    <section>
      <h2>
        {ACTION_LABEL[row.action]}　{when(row.at)}
      </h2>
      {row.txn ? (
        <p>
          取引: {row.txn.date}、{yen(row.txn.amount)}（{direction(row.txn.direction)}）、{row.txn.description}
        </p>
      ) : (
        <p className="error">この確認の明細を表示できません（明細を読み込めませんでした）。</p>
      )}
      <p>
        確認者: {row.reviewer.name ?? "担当者"}（ID {row.reviewer.id}）{row.bulk ? "、まとめて承認" : ""}
      </p>
      <p>理由: {row.reason ?? "（記載なし）"}</p>
      {hasEntries && (
        <EntryTable
          proposal={row.proposal}
          proposalEntry={proposal}
          finalEntry={row.finalEntry}
          decisionId={row.decisionId}
          masters={masters}
        />
      )}
      {row.action === "correct" && (
        <>
          <h3>修正した項目（記録された差分）</h3>
          {row.diff.length === 0 ? (
            <p>差分の記録がありません。</p>
          ) : (
            <ul>
              {row.diff.map((d) => {
                const f = ENTRY_FIELDS.find((x) => x.key === d.field);
                return (
                  <li key={d.field}>
                    {f ? f.label : `項目 ${d.field}`}: {f ? fieldText(f, d.before, masters) : NOT_RECORDED} → {f ? fieldText(f, d.after, masters) : NOT_RECORDED}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <p className="note">
        確認ID {row.reviewId} / 判断ID {row.decisionId}
        {row.txn ? ` / 明細ID ${row.txn.id}` : ""}
      </p>
    </section>
  );
}

function EntryTable({
  proposal,
  proposalEntry,
  finalEntry,
  decisionId,
  masters,
}: {
  proposal: HistoryRow["proposal"];
  proposalEntry: EntryRecord | null;
  finalEntry: EntryRecord | null;
  decisionId: string;
  masters: MasterNames;
}) {
  return (
    <>
      {proposal.state === "unavailable" && <p className="error">変更前の仕訳候補を表示できません（判断ID {decisionId} を読み込めませんでした）。</p>}
      {proposal.state === "none" && <p>変更前の仕訳候補はありません（AI は提案を返していません）。</p>}
      {!finalEntry && <p className="error">確定内容を表示できません（記録の形式が不正です）。</p>}
      <table>
        <thead>
          <tr>
            <th>項目</th>
            <th>変更前の仕訳候補</th>
            <th>確定内容</th>
          </tr>
        </thead>
        <tbody>
          {ENTRY_FIELDS.map((f) => (
            <tr key={f.key}>
              <td>{f.label}</td>
              <td>{proposalEntry ? fieldText(f, proposalEntry[f.key], masters) : "表示できません"}</td>
              <td>{finalEntry ? fieldText(f, finalEntry[f.key], masters) : "表示できません"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
