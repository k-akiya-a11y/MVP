import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { newRuleHref } from "@/lib/rules/candidate-schema";
import { loadPastQuality, type AccountLabel, type PastQuality } from "@/lib/retrieval/past-quality-load";
import { createUserClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const range = (r: { from: string; to: string }) => (r.from === r.to ? r.from : `${r.from} 〜 ${r.to}`);
const direction = (d: "income" | "expense") => (d === "income" ? "入金" : "出金");

function accountLabel(id: number, accounts: Map<number, AccountLabel>): string {
  const a = accounts.get(id);
  if (!a) return `科目ID ${id}（マスタに名前がありません）`;
  return `${a.name}（科目ID ${id}${a.available ? "" : "、現在は無効"}）`;
}

export default async function PastQualityPage({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;

  // 確認用の画面なので、読込に失敗しても承認画面には影響させず、失敗したことを表示する
  let data: PastQuality | null = null;
  let failure = false;
  try {
    data = await loadPastQuality(await createUserClient(), customerId);
  } catch {
    // 例外の中身（検証エラー・SDK・インフラの情報）は画面に出さず、ログにも出さない
    failure = true;
  }
  if (!failure && !data) notFound();

  return (
    <main>
      <p>
        <Link href={`/customers/${customerId}`}>← 承認画面に戻る</Link>
      </p>
      <h1>{data ? `${data.customer.name}：過去仕訳の科目の揺れ` : "過去仕訳の科目の揺れ"}</h1>
      <p className="note">
        同じ取引先の過去仕訳で、科目が複数に分かれているものを一覧にしています。AI は過去仕訳の誤りも真似るため、取込直後に担当者が確認するための表です。
        科目が分かれている理由が正当な場合もあり（取引の内容による使い分けなど）、件数が多い科目が正しいとは限りません。この表は誤りの判定や修正をせず、仕訳候補・ルール・履歴も変更しません。
      </p>
      {failure && (
        <p className="error">
          過去仕訳を読み込めなかったため、確認結果を表示できません（「揺れなし」ではありません）。時間をおいて再読み込みしてください。
        </p>
      )}
      {data && <Report data={data} />}
    </main>
  );
}

function Report({ data }: { data: PastQuality }) {
  const { report, accounts } = data;
  if (report.totalEntries === 0) {
    return <p>この顧客の過去仕訳はまだ取り込まれていません。取込後に確認できます。</p>;
  }
  const { missingKey } = report;
  return (
    <>
      <p>
        取り込み済みの過去仕訳 {report.totalEntries} 件（日付 {range(report.importedRange!)}）を対象にしています。
        freee の全期間や直近24か月分がそろっていることを示すものではなく、取り込み済みの範囲だけの結果です。
      </p>
      <ul>
        <li>取引先キーのある仕訳: {report.keyedEntries} 件（{report.groupCount} グループ）</li>
        <li>科目が2種類以上に分かれているグループ: {report.variantGroups.length} 件</li>
        <li>科目が1種類だけのグループ（ルール検討用の候補）: {report.stableAccountCandidates.length} 件</li>
        <li>取引先キーのない仕訳:{missingKey.count} 件</li>
      </ul>

      <section>
        <h2>科目が分かれている取引先（{report.variantGroups.length}）</h2>
        {report.variantGroups.length === 0 ? (
          <p>
            {report.keyedEntries === 0
              ? "取引先キーのある仕訳がないため、取引先ごとの確認はできません。"
              : "取引先キーと入出金の向きが同じ仕訳で、科目が分かれているものはありませんでした。"}
          </p>
        ) : (
          <>
            <p className="note">取引先キーが完全に同じものだけをまとめています。表記が似ているだけの取引先は別として扱います。</p>
            {report.variantGroups.map((g) => (
              <section key={`${g.direction}:${g.partnerKey}`}>
                <h3>
                  {g.partnerKey}（{direction(g.direction)}）
                </h3>
                <p className="note">
                  {g.total} 件、{range(g.dateRange)}
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>科目</th>
                      <th className="num">件数</th>
                      <th>期間</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.accounts.map((a) => (
                      <tr key={a.accountItemId}>
                        <td>{accountLabel(a.accountItemId, accounts)}</td>
                        <td className="num">{a.count}</td>
                        <td>{range(a.dateRange)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <details>
                  <summary>根拠の過去仕訳ID</summary>
                  {g.accounts.map((a) => (
                    <p key={a.accountItemId}>
                      {accountLabel(a.accountItemId, accounts)}: {a.entryIds.join(", ")}
                    </p>
                  ))}
                </details>
              </section>
            ))}
          </>
        )}
      </section>

      <section>
        <h2>科目が同じ取引先（ルール検討用）（{report.stableAccountCandidates.length}）</h2>
        <p className="note">
          この一覧は過去仕訳から抽出したルール検討用の資料です。この画面からルールの保存・有効化は行いません。既存ルールとの重複は確認していないため、ルール化の前に既存ルールも確認してください。過去仕訳そのものは通常の仕訳候補づくりで参照されます。
          取込済みの範囲で科目が1種類だったというだけで、その科目が正しいとは限りません。ルールにする前に、税区分・補助科目（取引先・品目・部門・メモタグ）・金額条件・有効期間・業務上の例外を担当者が確認してください。
        </p>
        <p className="note">
          <Link href={`/customers/${data.customer.id}/rules`}>保存済みの既存ルールを確認する</Link>
          （既存ルールの確認と編集ができます）
        </p>
        <p className="note">
          各候補の「この候補から新しいルールを作る」から、確認用の画面に進めます。そこで税区分と優先順位を人が決め、「提案中」のルールとして保存できます（有効にはなりません）。この一覧の画面自体は何も保存しません。
        </p>
        {report.stableAccountCandidates.length === 0 ? (
          <p>取引先キーと入出金の向きが同じで、科目が1種類だけのグループはありませんでした。</p>
        ) : (
          report.stableAccountCandidates.map((c) => {
            const a = accounts.get(c.accountItemId);
            return (
              <section key={`${c.direction}:${c.partnerKey}`}>
                <h3>
                  {c.partnerKey}（{direction(c.direction)}）
                </h3>
                <p>
                  科目: {accountLabel(c.accountItemId, accounts)}、{c.count} 件、{range(c.dateRange)}
                </p>
                {c.count === 1 && (
                  <p className="error">1件のみの実績です。1件だけでは、この取引先の科目が安定しているとは言えません。</p>
                )}
                {a && !a.available && (
                  <p className="error">この科目は現在のマスタでは無効です。そのままルールにすることはできません。</p>
                )}
                {!a && <p className="error">この科目IDは現在のマスタにありません。科目の存在を確認してください。</p>}
                <p>
                  {/* リンクごとに別の依頼IDを割り当てる（ページは毎回描画する）。IDは遷移先のURLで固定される */}
                  <Link href={newRuleHref(data.customer.id, c, randomUUID())}>この候補から新しいルールを作る</Link>
                </p>
                <details>
                  <summary>根拠の過去仕訳ID</summary>
                  <p>{c.entryIds.join(", ")}</p>
                </details>
              </section>
            );
          })
        )}
      </section>

      <section>
        <h2>取引先キーのない仕訳（{missingKey.count}）</h2>
        {missingKey.count === 0 ? (
          <p>すべての仕訳に取引先キーがあります。</p>
        ) : (
          <>
            <p className="note">
              取引先キーがない仕訳は、取引先ごとの確認の対象外です（同じ取引先としてまとめていません）。期間: {range(missingKey.dateRange!)}
            </p>
            <details>
              <summary>該当する過去仕訳ID</summary>
              <p>{missingKey.entryIds.join(", ")}</p>
            </details>
          </>
        )}
      </section>
    </>
  );
}
