import Link from "next/link";
import { notFound } from "next/navigation";
import { findStatementFormat } from "@/lib/statements/formats";
import {
  IMPORT_MAX_PAGE,
  loadImportHistory,
  MAX_DETAIL_ITEMS,
  parseImportPage,
  type DetailList,
  type ImportHistory,
  type ImportRecord,
} from "@/lib/statements/history";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const NOT_RECORDED = "（記録なし）";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const count = (n: number) => `${n.toLocaleString("ja-JP")}件`;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
}

export default async function ImportHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { customerId } = await params;
  const page = parseImportPage((await searchParams).page);

  let data: ImportHistory | null = null;
  let failure = false;
  try {
    data = await loadImportHistory(await createUserClient(), customerId, page);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  // 顧客が見えない（権限外・存在しない）ときは、記録の有無を示さず 404 にする
  if (!failure && !data) notFound();

  return (
    <main>
      <p>
        <Link href={`/customers/${customerId}`}>← 承認画面に戻る</Link>
      </p>
      <h1>{data ? `${data.customer.name}：明細CSVの取込の記録` : "明細CSVの取込の記録"}</h1>
      <p className="note">
        この顧客について、取込の記録（成功・失敗）を新しい順に表示します。読み取り専用で、ここから取込・再取込・記録の変更はできません。
        取込の記録は、明細を取り込んだ事実と件数・金額の記録です。承認ではなく、freee への登録が済んだことも示しません。
        件数は取込を行った時点の記録で、あとで「重複の疑い」を解決しても変わりません。
      </p>
      <p className="note">
        取込の結果が分からなかったときも、この画面に記録が見つからないことは「登録されていない」ことの証明ではありません
        （記録の反映前に開いた、別の顧客・口座で取り込んだ、この画面で読めなかった、などの場合があります）。
        取引の一覧と合わせて確認してください。このアプリは取込を自動では再送しません。
      </p>
      {failure && (
        <p className="error">
          取込の記録を読み込めなかったため表示できません（「記録がない」ことを意味しません）。時間をおいて再読み込みしてください。
        </p>
      )}
      {data && <Imports data={data} customerId={customerId} />}
    </main>
  );
}

function Imports({ data, customerId }: { data: ImportHistory; customerId: string }) {
  const href = (p: number) => (p <= 1 ? `/customers/${customerId}/imports` : `/customers/${customerId}/imports?page=${p}`);
  if (data.rows.length === 0) {
    return data.page === 1 ? (
      <p>この顧客の取込の記録は、この画面ではまだ見つかりません（取込が行われていないことの証明ではありません）。</p>
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
      <p className="note">閲覧中に新しい取込が記録されると、ページの区切りがずれて同じ記録が前後のページに出ることがあります。</p>
      {nav}
      {data.rows.map((row) => (
        <ImportCard key={row.importId} row={row} />
      ))}
      {nav}
      {data.olderBeyondLimit && (
        <p className="note">
          これより古い記録がありますが、この画面で表示できるのはここまでです（最大 {IMPORT_MAX_PAGE.toLocaleString("ja-JP")} ページ）。残りの記録はこの画面からは確認できません。
        </p>
      )}
    </>
  );
}

function ImportCard({ row }: { row: ImportRecord }) {
  const failed = row.status === "failed";
  const format = row.csvFormat ? (findStatementFormat(row.csvFormat)?.label ?? `${row.csvFormat}（この版では名前を引けない形式）`) : NOT_RECORDED;
  return (
    <section>
      <h2>
        {row.warnings.length > 0 ? "要確認（記録に不整合）" : failed ? "失敗（取り込んでいません）" : "成功"}　{when(row.at)}
      </h2>
      {row.warnings.length > 0 && (
        <div className="error">
          <p>記録上の状態: {failed ? "失敗" : "成功"}（この状態は、下の矛盾が解消されるまで確定として扱えません）</p>
          <p>この取込の記録に、読み取れた範囲で矛盾があります。数値を信用せず、原因が分かるまで未解決として扱ってください。</p>
          <ul>
            {row.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      <p>
        ファイル: {row.fileName ?? NOT_RECORDED}
        {row.source === "freee_wallet_txns" ? "（freee から取得した記録）" : ""}
      </p>
      <p>
        口座: {row.wallet.name ?? "（名前を読めません）"}（ID {row.wallet.id}）
      </p>
      <p>
        取込者: {row.importer.id === null ? NOT_RECORDED : `${row.importer.name ?? "（名前を読めません）"}（ID ${row.importer.id}）`}
      </p>
      <p>CSVの形式: {format}</p>
      <p>元のファイルの行数（見出し・空行を除く）: {row.sourceRowCount === null ? "不明（記録されていません）" : count(row.sourceRowCount)}</p>
      {failed ? (
        <p>
          このファイルは取り込んでいません。件数・金額が 0 なのは「取込がなかった」ことを表し、元のファイルに金額がなかったことの証明ではありません。
          元のファイルの金額合計は計算していません。
        </p>
      ) : (
        <Totals row={row} />
      )}
      <Details title="金額0のため取引にしなかった行" list={row.ignored} noun="行" />
      <Details title="読めなかった行" list={row.errors} noun="行" />
      <p className="note">取込ID {row.importId}</p>
    </section>
  );
}

function Totals({ row }: { row: ImportRecord }) {
  const { counts: c, amounts: a } = row;
  return (
    <ul>
      <li>
        読めた行: {count(c.read)}（入金 {yen(a.income)}・出金 {yen(a.expense)}）
      </li>
      <li>
        登録: {count(c.inserted)} {yen(a.inserted)}
      </li>
      <li>
        取込済みのため読み飛ばし: {count(c.skipped)} {yen(a.skipped)}
      </li>
      <li>
        重複の疑い（人の確認待ちとして登録）: {count(c.suspected)} {yen(a.suspected)}
      </li>
    </ul>
  );
}

function Details({ title, list, noun }: { title: string; list: DetailList; noun: string }) {
  if (list.state === "invalid") {
    return (
      <p className="error">
        {title}: 記録の形式が不正で表示できません（「なし」ではありません）。
      </p>
    );
  }
  if (list.total === 0) return null;
  return (
    <>
      <h3>
        {title}（{list.total.toLocaleString("ja-JP")} {noun}）
      </h3>
      <ul>
        {list.items.map((d, i) => (
          <li key={i}>
            {d.line === 0 ? "ファイル全体" : `${d.line}行目`}: {d.text}
          </li>
        ))}
      </ul>
      {list.omitted > 0 && (
        <p className="note">
          ほか {list.omitted.toLocaleString("ja-JP")} {noun}は省略しました（表示は先頭の {MAX_DETAIL_ITEMS} 件まで）。
        </p>
      )}
    </>
  );
}
