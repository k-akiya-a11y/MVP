import type { JournalAi } from "../ai/client";
import { toAiDecisionRow } from "../audit/decision-log";
import { proposeForTransaction, type DecisionDraft } from "./propose";
import type { ProposalStore } from "./store";
import type { BankTransaction } from "./types";

export type ProposalRunResult = {
  processed: number;
  byConfidence: { high: number; medium: number; low: number };
  failures: { bankTransactionId: string; error: string }[];
  /** この回に判定を試みた明細の数（成功＋失敗） */
  attempted: number;
  /** 1回あたりの上限まで受け取った、または時間の予算で打ち切った。続きの未判定明細が残っている可能性がある（次回以降の実行が巡回を続ける） */
  truncated: boolean;
};

/** 1回の実行で判定を試みる明細の上限（AI の呼出し回数・費用の上限）。DB 側（claim_pending_proposal_batch）も同じ値で制限する */
export const MAX_ATTEMPTS_PER_RUN = 200;

/**
 * 1回の実行で新しい判定を始めてよい時間（ミリ秒）。cron ルートの maxDuration（300 秒）と、最後の 1 件の AI 呼出しの上限
 * （AI_CALL_TIMEOUT_MS）＋記録の時間より短くする。超えたら残りは始めずに貸出しを返す。
 */
export const RUN_BUDGET_MS = 200_000;

/**
 * 1件の判定（AI 呼出しを含む）を待つ上限（ミリ秒）。超えたら次の明細へ進むが、呼出しは捨てない。
 * 遅れて届いた結果は、実行の終わりに LATE_DEADLINE_MS まで待って判断ログに記録する（費用がかかった呼出しの使用量・費用を残すため）
 */
export const AI_CALL_TIMEOUT_MS = 60_000;

/**
 * 実行の開始から、遅れている判定を待ってよい上限（ミリ秒）。cron ルートの maxDuration（300 秒）より短くし、記録と貸出しの返却の時間を残す。
 * RUN_BUDGET_MS（200 秒）で最後に始めた判定は AI_CALL_TIMEOUT_MS で 260 秒までに待つのをやめ、ここで 280 秒まで待つ
 */
export const LATE_DEADLINE_MS = 280_000;

/** 待つのをやめた（呼出しはまだ続いている可能性がある） */
class AttemptTimeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, bankTransactionId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttemptTimeout(`判定が ${ms}ms で終わりませんでした（${bankTransactionId}）`)), ms);
  });
  // 待つのをやめた後に元の処理が失敗しても、未処理の拒否として落とさない
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** promise を ms まで待つ（ms <= 0 なら待たない）。待ちきれなくても例外にしない */
function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise.then(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

/**
 * 未判定の明細に仕訳候補を作り、AI判断ログに記録する（Vercel Cron から呼ぶ）。
 * 1件失敗しても残りは続ける。失敗した明細は「未判定」のまま残り（件数にも出続ける）、巡回が戻ってきたときにまた判定する。
 *
 * 公平な巡回: 失敗が続く明細が先頭に溜まっても後ろの明細が飢えないよう、DB が持つ走査位置から 1 件ずつ、判定の直前に借りる
 * （合計は最大 200 件）。位置は「実際に判定を始めた明細」の分だけ前へ進む。時間の予算で止まっても、借りていない残りの上を位置が
 * 飛び越すことはない（200 件を先に借りて位置を進めると、先頭の遅い失敗で予算が尽きたとき、残りが未着手のまま次の区間へ飛ばされた）。
 * 失敗した明細は実行の終わりまで借りたままにするので、同じ実行では再び渡らない（折返しても再試行しない）。
 * 末尾に届くと先頭に戻る。位置はここでは持たない（DB の 1 トランザクションで更新。並行する実行の位置を巻き戻さない）。
 *
 * 貸出し（リース）: 受け取った明細は、この実行が所有者として期限つきで借りる。期限内は他の実行（位置が折り返した場合を含む）に渡らない。
 *   - 顧客の文脈は明細ごとに読み直す（実行内で使い回さない）。取得した後、AI を呼ぶ直前に、予算の確認 → confirmClaim で所有の確認 → 予算の再確認の順で行う
 *     （文脈の取得が遅くて奪われた場合に備える。confirmClaim 自体も DB の往復で遅くなりうるので、その後にもう一度予算を見る）。
 *     奪われていれば AI を呼ばず失敗として数える。予算を超えていれば AI を呼ばず、失敗には数えず打ち切る
 *     （これは確認した時点の予算の検査であり、実行の絶対的な期限の保証ではない）
 *   - 記録は所有者だけが行える（recordDecision）。期限切れで他の実行に奪われた後の古い実行は記録できない
 *   - 失敗・未着手の明細は最後に貸出しを返す。中止・例外でも finally で返す。落ちて返せなければ期限（600 秒）で切れる
 *   - 時間: 予算（RUN_BUDGET_MS）を超えたら新しい明細を借りず判定も始めない。1件は AI_CALL_TIMEOUT_MS で「呼出し側が」待つのをやめる。
 *     待つのをやめることは外部の呼出しの取消しではない（AI への要求は止まらず、費用がかかりうる）。待つのをやめた明細の貸出しは返さない
 *     （呼出しがまだ続いているかもしれないので、期限まで他の実行に渡さない）
 *   - 遅れた結果: 呼出しは捨てず、実行の終わりに LATE_DEADLINE_MS まで待つ。届いたら、貸出しを持ったまま通常どおり判断ログに記録する
 *     （モデル・使用量・費用が残り、承認キューに入る。失敗の一覧からは外し、processed に数える）。遅れて失敗したら貸出しを返し、次の巡回で判定し直す
 * 限界: 期限が切れても古い実行の AI 呼出しが続いていれば二重に呼ばれうる。期限は関数の最大実行時間より長くして避けている。
 *   LATE_DEADLINE_MS までに届かなかった呼出しは、費用がかかっても判断ログに残らない（関数が止められるため）。失敗として返し、貸出しは期限まで返さない。
 *   締切で受付を閉じ、その後に届いた結果は記録せず、返した結果も書き換えない。締切の時点で記録の途中だったものは「記録されたかは不明」の失敗として返す。
 * 1回の AI 呼出しの上限は 200 件のまま増やさない。
 */
export async function runProposalJob(
  deps: {
    store: ProposalStore;
    ai: JournalAi;
    today: string;
    /** テスト用: 現在時刻（ミリ秒）、時間の予算、1件の待ち時間の上限 */
    now?: () => number;
    budgetMs?: number;
    aiTimeoutMs?: number;
    lateDeadlineMs?: number;
  },
  batchSize = MAX_ATTEMPTS_PER_RUN,
): Promise<ProposalRunResult> {
  const result: ProposalRunResult = {
    processed: 0,
    byConfidence: { high: 0, medium: 0, low: 0 },
    failures: [],
    attempted: 0,
    truncated: false,
  };
  const now = deps.now ?? Date.now;
  const budgetMs = deps.budgetMs ?? RUN_BUDGET_MS;
  const aiTimeoutMs = deps.aiTimeoutMs ?? AI_CALL_TIMEOUT_MS;
  const lateDeadlineMs = deps.lateDeadlineMs ?? LATE_DEADLINE_MS;

  // 呼出し側の指定でも上限（200）を超えない。1 未満や整数でない値は既定の上限を使う
  const limit = Number.isInteger(batchSize) && batchSize >= 1 ? Math.min(batchSize, MAX_ATTEMPTS_PER_RUN) : MAX_ATTEMPTS_PER_RUN;

  const startedAt = now();
  // この実行が借りた明細（失敗したものも、実行の終わりまで借りたままにして同じ実行で再び渡らないようにする）
  const owned: BankTransaction[] = [];
  // 貸出しを返さない明細: 記録できた（貸出しは記録と同時に終わる）、または待つのをやめた（呼出しが続いているかもしれない）もの。
  // それ以外（失敗・例外で中断）は finally で返す
  const settled = new Set<string>();
  // 待つのをやめた判定の続き（届いたら記録する）。実行の終わりに LATE_DEADLINE_MS まで待つ
  const late: Promise<void>[] = [];
  // 締切（LATE_DEADLINE_MS）を過ぎたら受付を閉じる。閉じた後に届いた結果は記録せず、返した結果も書き換えない
  let lateClosed = false;
  // 締切の時点で記録（DB 書込）を始めていて、まだ終わっていない明細の失敗。締切後は結果不明として確定扱いにしない
  const recording = new Set<{ bankTransactionId: string; error: string }>();
  const followLate = (txnId: string, pending: Promise<DecisionDraft>, failure: { bankTransactionId: string; error: string }) => {
    late.push(
      pending.then(
        async (draft) => {
          if (lateClosed) return;
          recording.add(failure);
          try {
            await deps.store.recordDecision(toAiDecisionRow(draft));
          } catch (error) {
            if (lateClosed) return;
            failure.error = `遅れて届いた判定を記録できませんでした: ${error instanceof Error ? error.message : String(error)}`;
            return;
          } finally {
            if (!lateClosed) recording.delete(failure);
          }
          if (lateClosed) return;
          result.failures.splice(result.failures.indexOf(failure), 1);
          result.processed++;
          result.byConfidence[draft.confidence.level]++;
        },
        (error: unknown) => {
          if (lateClosed) return;
          // 呼出しが終わったので、貸出しを返して次の巡回で判定し直す
          failure.error = `遅れて失敗しました: ${error instanceof Error ? error.message : String(error)}`;
          settled.delete(txnId);
        },
      ),
    );
  };
  try {
    while (true) {
      if (result.attempted >= limit) {
        result.truncated = true;
        break;
      }
      if (now() - startedAt >= budgetMs) {
        result.truncated = true;
        break;
      }
      // 1 件ずつ、判定の直前に借りる。位置は実際に判定を始める明細の分だけ進む
      const batch = await deps.store.claimPendingBatch(1);
      owned.push(...batch);
      // ストアが 1 件を超えて返しても、判定するのは先頭の 1 件。残りは finally で貸出しを返す
      const txn = batch[0];
      if (!txn) break;
      result.attempted++;
      try {
        // 文脈は明細ごとに読み直す（実行の途中で人が確定した過去仕訳や、無効化・編集されたルール・メモを次の明細から反映する）。使い回さない
        const ctx = await deps.store.loadCustomerContext(txn.customerId, deps.today);
        // 文脈の読込は遅いことがある。貸出しが切れて奪われうるので、所有の確認は AI を呼ぶ直前（文脈の取得の後）に行う
        // 時間の予算もここで見直す。超えていれば AI を呼ばず、貸出しは finally で返す（位置は進んだまま。失敗にも数えない）
        if (now() - startedAt >= budgetMs) {
          result.truncated = true;
          break;
        }
        // 奪われていれば、その明細は今の持ち主に任せる（返さない・AI を呼ばない）
        if (!(await deps.store.confirmClaim(txn.id))) {
          result.failures.push({ bankTransactionId: txn.id, error: "貸出しが他の実行に移ったため判定しませんでした" });
          continue;
        }
        // 所有の確認（DB の往復）が遅く予算を使い切った場合も、AI を呼ばない。貸出しは finally で返す
        if (now() - startedAt >= budgetMs) {
          result.truncated = true;
          break;
        }
        const pending = proposeForTransaction(ctx, txn, deps.ai);
        let draft: DecisionDraft;
        try {
          draft = await withTimeout(pending, aiTimeoutMs, txn.id);
        } catch (error) {
          if (!(error instanceof AttemptTimeout)) throw error;
          const failure = { bankTransactionId: txn.id, error: error.message };
          result.failures.push(failure);
          settled.add(txn.id);
          followLate(txn.id, pending, failure);
          continue;
        }
        await deps.store.recordDecision(toAiDecisionRow(draft));
        settled.add(txn.id);
        result.processed++;
        result.byConfidence[draft.confidence.level]++;
      } catch (error) {
        result.failures.push({ bankTransactionId: txn.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    if (late.length > 0) {
      await waitAtMost(Promise.all(late), startedAt + lateDeadlineMs - now());
      lateClosed = true;
      // 記録の途中で締切を迎えたものは、DB に記録されたかが分からない。成功扱いにせず、貸出しも返さない（記録済みなら次の巡回で new でないため渡らない）
      for (const failure of recording) {
        failure.error = `締切までに判断ログの記録が終わらず、記録されたかは不明です（${failure.bankTransactionId}）`;
      }
    }
    const release = owned.filter((t) => !settled.has(t.id)).map((t) => t.id);
    if (release.length > 0) {
      // 返せなくても期限で切れる。返却の失敗で実行の結果（や元の例外）を隠さない
      await deps.store.releaseClaims(release).catch(() => undefined);
    }
  }
  return result;
}
