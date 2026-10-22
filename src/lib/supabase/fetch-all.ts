/** 1回に読む行数。Supabase（PostgREST）の既定の上限 1,000 行に合わせる */
export const PAGE_SIZE = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * 条件に合う行をページ分割ですべて読む。1回の select は上限で黙って切れるため、
 * 件数で判定や集計をする読込（過去仕訳・マスタなど）は必ずこれを通す。
 * page には並び順が一意に決まる order を付けた range 付きのクエリを返させる。
 * サーバー側の上限が PAGE_SIZE より小さくても漏れないよう、空のページが返るまで読む。
 */
export async function fetchAll<T>(what: string, page: (from: number, to: number) => Page<T>): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + PAGE_SIZE - 1);
    if (error) throw new Error(`${what}の読込に失敗しました: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}
