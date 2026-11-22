import Link from "next/link";
import { notFound } from "next/navigation";
import {
  isFiltered,
  LEDGER_MAX_PAGE,
  ledgerHref,
  loadLedger,
  NO_FILTERS,
  parseLedgerFilters,
  parseLedgerPage,
  TXN_STATUSES,
  TXN_STATUS_LABEL,
  type Ledger,
  type LedgerFilters,
  type LedgerRow,
} from "@/lib/statements/ledger";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

type Param = string | string[] | undefined;

export default async function StatementLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ customerId: string }>;
  searchParams: Promise<{ page?: Param; status?: Param; wallet?: Param; from?: Param; to?: Param }>;
}) {
  const { customerId } = await params;
  const sp = await searchParams;
  const page = parseLedgerPage(sp.page);
  const parsed = parseLedgerFilters(sp);
  const invalid = parsed.errors.length > 0;

  let data: Ledger | null = null;
  let failure = false;
  try {
    // 入力が無効なときは null を渡し、条件を落とした広い結果を読まない（顧客と口座の選択肢だけ読む）
    data = await loadLedger(await createUserClient(), customerId, page, invalid ? null : parsed.filters);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  // 顧客が見えない（権限外・存在しない）ときは、明細の有無を示さず 404 にする
  if (!failure && !data) notFound();

  return (
    <main>
      <p>
        <Link href={`/customers/${customerId}`}>← 承認画面に戻る</Link>
      </p>
      <h1>{data ? `${data.customer.name}：取り込んだ明細の一覧` : "取り込んだ明細の一覧"}</h1>
      <p className="note">
        この顧客の明細を、状態を問わず取引日の新しい順（同じ日は明細IDの降順）に表示します。明細IDは取込や登録の順番を表すものではないため、同じ日の中の並びは取り込んだ順ではありません。読み取り専用で、ここから承認・取込・再取込・変更はできません。
        「状態」は記録されている処理の段階です。「承認済み」は人が承認した記録があることを表し、freee への登録が済んだことは示しません（登録済みは別の状態です）。
        「未判定」は仕訳候補をまだ作っていないだけで、判定に失敗した・不可という意味ではありません。
      </p>
      <p className="note">
        取込の結果が分からなかったときも、ここに明細が見つからないことは「取り込まれていない」ことの証明ではありません
        （記録の反映前に開いた、別の顧客・口座で取り込んだ、この画面で読めなかった、などの場合があります）。
        取込の記録と合わせて確認してください。このアプリは取込を自動では再送しません。
      </p>
      {failure && (
        <p className="error">
          明細を読み込めなかったため表示できません（「明細がない」ことを意味しません）。時間をおいて再読み込みしてください。
        </p>
      )}
      {/* フォームは defaultValue（非制御）なので、ソフトナビゲーションで同じ要素が使い回されると、リセット後も古い選択が残る。
          顧客と有効な絞り込みから作る正規の URL（page なし）を key にし、絞り込みが変わるときだけ作り直す（ページ送りでは変わらない） */}
      {data && <FilterForm key={ledgerHref(customerId, parsed.filters, 1)} data={data} customerId={customerId} filters={parsed.filters} />}
      {data && invalid && (
        <div className="error">
          <p>絞り込みの条件が正しくないため、明細は表示していません（条件を外した一覧も表示していません）。</p>
          <ul>
            {parsed.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p>
            条件を直して「絞り込む」を押すか、<ResetLink customerId={customerId}>リセット</ResetLink>してください。
          </p>
        </div>
      )}
      {data && !invalid && <LedgerList data={data} customerId={customerId} />}
    </main>
  );
}

/** リセットは素の <a>（Link ではない）。フルページの GET ナビゲーションで、未送信の入力を含めフォームを必ず初期状態に戻す。
    Link だと、絞り込みなしの画面で同じ URL に戻るとき、非制御の select/input が再利用されて未送信の選択が残る */
function ResetLink({ customerId, children }: { customerId: string; children: React.ReactNode }) {
  return <a href={ledgerHref(customerId, NO_FILTERS, 1)}>{children}</a>;
}

/** 絞り込みのフォーム。GET だけ（読取専用）。page を送らないので、適用すると必ず1ページ目に戻る */
function FilterForm({ data, customerId, filters }: { data: Ledger; customerId: string; filters: LedgerFilters }) {
  return (
    <form method="get" action={`/customers/${customerId}/statements`}>
      <p>
        <label>
          状態{" "}
          <select name="status" defaultValue={filters.status ?? "all"}>
            <option value="all">すべて</option>
            {TXN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TXN_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          口座{" "}
          <select name="wallet" defaultValue={filters.walletId ?? ""}>
            <option value="">すべて</option>
            {data.walletOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          取引日（開始日） <input type="date" name="from" defaultValue={filters.from ?? ""} />
        </label>{" "}
        〜{" "}
        <label>
          取引日（終了日） <input type="date" name="to" defaultValue={filters.to ?? ""} />
        </label>{" "}
        （その日を含む）
      </p>
      {data.walletOptionsTruncated && <p className="note">口座が多いため、選択肢には一部の口座だけを表示しています。</p>}
      <p>
        <button type="submit">絞り込む</button> <ResetLink customerId={customerId}>リセット（絞り込みを外す）</ResetLink>
      </p>
    </form>
  );
}

function LedgerList({ data, customerId }: { data: Ledger; customerId: string }) {
  const href = (p: number) => ledgerHref(customerId, data.filters, p);
  const filtered = isFiltered(data.filters);
  if (data.walletUnavailable) {
    return <p className="error">指定された口座は、この顧客の口座として確認できなかったため、明細は表示していません。口座を選び直すか、リセットしてください。</p>;
  }
  if (data.rows.length === 0) {
    if (data.page > 1) {
      return (
        <p>
          このページに明細はありません。<Link href={href(1)}>最初のページに戻る</Link>
        </p>
      );
    }
    return filtered ? (
      <p>
        この条件に合う明細は、この画面では見つかりませんでした。この顧客に明細がないという意味ではなく、取込の結果が分からなかった分が「取り込まれていない」とも言えません。条件を変えるか、リセットしてください。
      </p>
    ) : (
      <p>この顧客の明細は、この画面ではまだ見つかりません（取り込まれていないことの証明ではありません）。</p>
    );
  }
  const nav = (
    <p>
      {data.hasPrevious ? <Link href={href(data.page - 1)}>← 前のページ（新しい明細）</Link> : null}
      {data.hasPrevious && data.hasNext ? " / " : null}
      {data.hasNext ? <Link href={href(data.page + 1)}>次のページ（古い明細）→</Link> : null}
    </p>
  );
  return (
    <>
      <p>
        {filtered ? "条件に合う明細: " : ""}
        {data.page} ページ目（1ページ {data.pageSize} 件、このページ {data.rows.length} 件）
      </p>
      <p className="note">閲覧中に新しい明細が取り込まれると、ページの区切りがずれて同じ明細が前後のページに出ることがあります。</p>
      {nav}
      {data.rows.map((row) => (
        <TxnCard key={row.id} row={row} />
      ))}
      {nav}
      {data.olderBeyondLimit && (
        <p className="note">
          これより古い明細がありますが、この画面で表示できるのはここまでです（最大 {LEDGER_MAX_PAGE.toLocaleString("ja-JP")} ページ）。残りの明細はこの画面からは確認できません。
        </p>
      )}
    </>
  );
}

function TxnCard({ row }: { row: LedgerRow }) {
  return (
    <section>
      <h2>
        {row.date}　{row.direction === "income" ? "入金" : "出金"} {yen(row.amount)}
      </h2>
      <p>摘要: {row.description === "" ? "（空）" : row.description}</p>
      <p>
        口座: {row.wallet.name ?? "（名前を読めません）"}（ID {row.wallet.id}）
      </p>
      <p>状態: {TXN_STATUS_LABEL[row.status]}</p>
      {row.duplicateOfId && <p>重複の疑いの元の明細ID: {row.duplicateOfId}</p>}
      <p className="note">
        明細ID {row.id} / 取込ID {row.importId}
      </p>
    </section>
  );
}
