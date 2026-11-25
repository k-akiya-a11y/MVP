import { randomUUID } from "node:crypto";
import type { FreeeTokens } from "./oauth";

/**
 * freee のアクセストークンを得る唯一の入口（CLAUDE.md 8章: リフレッシュトークンの更新は一か所にまとめ、ロックで同時更新を防ぐ）。
 *
 * 使い捨てのリフレッシュトークンを二重に送らないための約束:
 * - 更新を freee に送れるのは、DB のロックを取った処理だけ（ロックは REFRESH_LOCK_SECONDS、送信は TOKEN_REQUEST_TIMEOUT_MS で打ち切る）
 * - 更新が失敗したら、理由にかかわらず（拒否・期限切れ・通信の失敗・応答の形の違い）、freee 側で使用済みになったか分からないので、
 *   同じトークンを再送せず「再認可が必要」にする
 * - 前の処理のロックが期限切れで残っていたら（応答の喪失・処理の停止）、DB が引き継がずに「再認可が必要」にする
 *
 * - 期限まで REFRESH_MARGIN_MS 以上あれば、保存済みのアクセストークンをそのまま返す
 * - 期限が近い（または freee が 401 を返した）ときだけ更新する。更新は DB のロック（所有者と期限）を取った処理だけが行い、
 *   取れなかった処理は待ってから読み直す（他の処理が更新し終えていれば、その新しいトークンを使う）
 * - 更新に失敗したときは、接続を「再認可が必要」にして止める（上の約束）
 * - 更新は成功したのに保存に失敗した（ロックを失った等）ときは、使い捨てのリフレッシュトークンを失った可能性があるので、
 *   そのことを例外で伝える（黙って続けない）
 */

export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const REFRESH_LOCK_SECONDS = 60;
const WAIT_MS = 1000;
const MAX_WAITS = 30;

export type StoredAccessToken = { companyId: number; status: "active" | "needs_reauth"; accessToken: string; expiresAt: Date };

export type FreeeTokenStore = {
  get(customerId: string): Promise<StoredAccessToken | null>;
  /** ロックを取れたらリフレッシュトークン、他の処理がロック中なら null */
  beginRefresh(customerId: string, owner: string, lockSeconds: number): Promise<string | null>;
  completeRefresh(customerId: string, owner: string, tokens: FreeeTokens): Promise<void>;
  failRefresh(customerId: string, owner: string, needsReauth: boolean): Promise<void>;
};

export class FreeeNotConnectedError extends Error {
  constructor() {
    super("この顧客は freee と接続していません");
  }
}
export class FreeeNeedsReauthError extends Error {
  constructor() {
    super("freee との接続の再認可が必要です（管理者が接続し直してください）");
  }
}
/** 更新できたのに保存できなかった。外部のエラー文は載せない（固定の文言だけ） */
export class FreeeRefreshNotSavedError extends Error {
  constructor() {
    super("freee のトークンは更新されましたが、保存できませんでした。再認可が必要です（管理者が接続し直してください）");
  }
}

export async function getFreeeAccessToken(
  customerId: string,
  deps: {
    store: FreeeTokenStore;
    refresh: (refreshToken: string) => Promise<FreeeTokens>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    owner?: string;
  },
  opts: { force?: boolean } = {},
): Promise<{ accessToken: string; companyId: number }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const owner = deps.owner ?? randomUUID();

  const first = await deps.store.get(customerId);
  if (!first) throw new FreeeNotConnectedError();
  if (first.status === "needs_reauth") throw new FreeeNeedsReauthError();
  if (!opts.force && first.expiresAt.getTime() - now() > REFRESH_MARGIN_MS) {
    return { accessToken: first.accessToken, companyId: first.companyId };
  }

  for (let i = 0; i <= MAX_WAITS; i++) {
    const refreshToken = await deps.store.beginRefresh(customerId, owner, REFRESH_LOCK_SECONDS);
    if (refreshToken === null) {
      // 他の処理が更新中。待ってから読み直し、更新されていればそれを使う
      await sleep(WAIT_MS);
      const again = await deps.store.get(customerId);
      if (!again) throw new FreeeNotConnectedError();
      if (again.status === "needs_reauth") throw new FreeeNeedsReauthError();
      if (again.accessToken !== first.accessToken && again.expiresAt.getTime() - now() > REFRESH_MARGIN_MS) {
        return { accessToken: again.accessToken, companyId: again.companyId };
      }
      continue;
    }
    let tokens: FreeeTokens;
    try {
      tokens = await deps.refresh(refreshToken);
    } catch {
      // 結果が分からない（freee 側で使用済みになったかもしれない）ので、同じトークンは二度と送らない
      await deps.store.failRefresh(customerId, owner, true).catch(() => undefined);
      throw new FreeeNeedsReauthError();
    }
    try {
      await deps.store.completeRefresh(customerId, owner, tokens);
    } catch {
      // 新しいトークンを失った。ロックの期限が切れれば DB が再認可待ちにするが、できるならここで明示する
      await deps.store.failRefresh(customerId, owner, true).catch(() => undefined);
      throw new FreeeRefreshNotSavedError();
    }
    return { accessToken: tokens.accessToken, companyId: first.companyId };
  }
  throw new Error("freee のトークン更新を待ちきれませんでした（他の処理が更新中です）");
}
