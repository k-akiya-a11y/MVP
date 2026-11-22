import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { AiCallResult, JournalAi } from "@/lib/ai/client";
import type { AiJournalOutput } from "@/lib/ai/schema";
import { JOURNAL_MODEL, JOURNAL_PROMPT_VERSION } from "@/lib/ai/version";
import { toAiDecisionRow } from "@/lib/audit/decision-log";
import { proposeForTransaction } from "@/lib/proposals/propose";
import { MAX_ATTEMPTS_PER_RUN, runProposalJob } from "@/lib/proposals/run";
import { CLAIM_LEASE_SECONDS, supabaseProposalStore, type ProposalStore } from "@/lib/proposals/store";
import type { BankTransaction } from "@/lib/proposals/types";
import { sampleContext, txn } from "../fixtures/proposal-context";

// これらは DB を使わないモックのテスト。run は 1 件ずつ借りる（claimPendingBatch(1)）ので、位置は判定を始めた明細の分だけ進む。
// FakeDb は supabase/migrations/20261024000100_proposal_scan_cursor.sql の
// claim_pending_proposal_batch（位置より後ろで貸出しのない未判定を選ぶ → 0 件なら先頭から → 貸出しを記録 → 上限まで取れたら位置を進め、
// 未満なら先頭へ戻す）、renew_proposal_claim、release_proposal_claims、record_claimed_ai_decision の手順を写したもので、
// SQL そのものの動作の証明ではない（SQL は tests/db/proposal-claim.test.ts と upgrade.test.ts。どちらも書いただけで未実行）

const TODAY = "2026-10-31";
const TTL_MS = CLAIM_LEASE_SECONDS * 1000;

const usage = { inputTokens: 3000, outputTokens: 300, cacheReadTokens: 2500, cacheWriteTokens: 0, costUsdMicros: 9500 };
const aiOutput: AiJournalOutput = {
  decision: "proposal",
  account_item_id: 105,
  tax_code: 21,
  partner_id: 302,
  item_id: null,
  section_id: 401,
  tag_ids: [],
  description: "11月分 家賃",
  reason: "過去6件すべて地代家賃",
  unknowns: [],
  fixed_asset_possible: false,
  officer_or_personal: false,
};
const okResult: AiCallResult = { status: "ok", output: aiOutput, model: JOURNAL_MODEL, promptVersion: JOURNAL_PROMPT_VERSION, usage };
/** 呼ばれた回数を数える AI（ルールに一致しない明細だけが呼ぶ） */
const countingAi = () => vi.fn<JournalAi>(async () => okResult);
/** ルール一致（AI 不要）の明細では呼ばれないはずの AI */
const unusedAi = () => countingAi();

/** ルール一致（AI を呼ばない）になる明細。id は 4 桁 0 埋めで辞書順＝数値順 */
function row(n: number, date = "2026-10-01"): BankTransaction {
  return txn({ id: `t${String(n).padStart(4, "0")}`, txnDate: date, description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", amount: 9020 });
}
/** ルールに一致しない（AI を呼ぶ）明細 */
function aiRow(n: number, date = "2026-10-01"): BankTransaction {
  return txn({ id: `t${String(n).padStart(4, "0")}`, txnDate: date });
}
const id = (n: number) => `t${String(n).padStart(4, "0")}`;
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => id(from + i));
const num = (v: string) => Number(v.slice(1));
type Key = { txnDate: string; id: string };
const lt = (a: Key, b: Key) => a.txnDate < b.txnDate || (a.txnDate === b.txnDate && a.id < b.id);

type Status = "new" | "proposed" | "on_hold";
type Lease = { owner: string; expiresAt: number };

/** 走査位置と貸出しを持つ DB の代用。各操作は不可分（行ロックで直列化されることの写し）。位置・貸出しは run 側のメモリではなくここにある */
class FakeDb {
  status = new Map<string, Status>();
  rows = new Map<string, BankTransaction>();
  cursor: Key | undefined;
  cursorHistory: Array<Key | undefined> = [];
  leases = new Map<string, Lease>();
  /** DB の時計（ミリ秒）。貸出しの期限の判定に使う */
  clock = 0;
  claims: string[][] = [];
  recorded: string[] = [];
  failing: (id: string) => boolean = () => false;
  private ownerSeq = 0;

  constructor(rows: BankTransaction[]) {
    for (const r of rows) this.add(r);
  }
  add(r: BankTransaction) {
    this.rows.set(r.id, r);
    this.status.set(r.id, "new");
  }
  newOwner() {
    return `owner-${++this.ownerSeq}`;
  }
  pendingIds() {
    return [...this.rows.keys()].filter((v) => this.status.get(v) === "new").sort();
  }
  leasedIds() {
    return [...this.leases.keys()].sort();
  }

  claim(owner: string, limit: number): BankTransaction[] {
    // もう未判定でない明細の貸出しを掃除する
    for (const leaseId of [...this.leases.keys()]) if (this.status.get(leaseId) !== "new") this.leases.delete(leaseId);
    const free = (r: BankTransaction) => {
      const lease = this.leases.get(r.id);
      return !lease || lease.expiresAt <= this.clock;
    };
    const sorted = (after?: Key) =>
      [...this.rows.values()]
        .filter((r) => this.status.get(r.id) === "new" && (!after || lt(after, r)) && free(r))
        .sort((a, b) => (a.txnDate === b.txnDate ? (a.id < b.id ? -1 : 1) : a.txnDate < b.txnDate ? -1 : 1))
        .slice(0, limit);
    let batch = sorted(this.cursor);
    if (batch.length === 0 && this.cursor) batch = sorted(undefined);
    for (const r of batch) this.leases.set(r.id, { owner, expiresAt: this.clock + TTL_MS });
    const last = batch[batch.length - 1];
    this.cursor = batch.length >= limit && last ? { txnDate: last.txnDate, id: last.id } : undefined;
    this.cursorHistory.push(this.cursor);
    this.claims.push(batch.map((r) => r.id));
    return batch;
  }
  renew(owner: string, txnId: string): boolean {
    const lease = this.leases.get(txnId);
    if (!lease || lease.owner !== owner || this.status.get(txnId) !== "new") return false;
    lease.expiresAt = this.clock + TTL_MS;
    return true;
  }
  release(owner: string, txnIds: string[]) {
    for (const v of txnIds) if (this.leases.get(v)?.owner === owner) this.leases.delete(v);
  }
  record(owner: string, txnId: string) {
    if (this.leases.get(txnId)?.owner !== owner) throw new Error(`proposal claim for bank transaction ${txnId} is not held by this owner`);
    // record_ai_decision と同じ。new の明細にだけ記録でき、保留などは書き換えない
    if (this.status.get(txnId) !== "new") throw new Error(`bank transaction ${txnId} is not waiting for a proposal`);
    this.status.set(txnId, "proposed");
    this.leases.delete(txnId);
    this.recorded.push(txnId);
  }

  /** 実行ごとに新しいストア（所有者）を作る。サーバーレスの別インスタンスの代用で、メモリに位置を持たない */
  store(owner = this.newOwner()): ProposalStore & { owner: string } {
    return {
      owner,
      claimPendingBatch: async (limit) => {
        await Promise.resolve(); // 並行する実行と交互に進める
        return this.claim(owner, limit);
      },
      confirmClaim: async (txnId) => {
        await Promise.resolve();
        return this.renew(owner, txnId);
      },
      releaseClaims: async (txnIds) => {
        await Promise.resolve();
        this.release(owner, txnIds);
      },
      loadCustomerContext: async () => sampleContext(),
      recordDecision: async (d) => {
        await Promise.resolve();
        if (this.failing(d.bank_transaction_id)) throw new Error("persistent failure");
        this.record(owner, d.bank_transaction_id);
        return "d";
      },
    };
  }
  run(batchSize?: number, ai: JournalAi = unusedAi(), extra: Partial<Parameters<typeof runProposalJob>[0]> = {}) {
    return runProposalJob({ store: this.store(), ai, today: TODAY, ...extra }, batchSize);
  }
}

describe("runProposalJob: 連続する実行で公平に巡回する", () => {
  it("上限を超える失敗の群が先頭にあっても、続く実行で後ろの健全な明細に届く（上限は増やさない）", async () => {
    // 0〜399 は失敗し続け、400〜449 は健全。1回の上限は 200
    const db = new FakeDb(Array.from({ length: 450 }, (_, i) => row(i)));
    db.failing = (v) => num(v) < 400;

    const r1 = await db.run();
    expect(db.claims.flat().slice(0, 200)).toEqual(ids(0, 200));
    expect(r1).toMatchObject({ attempted: 200, processed: 0, truncated: true });
    expect(r1.failures).toHaveLength(200);
    // 失敗した明細の貸出しは実行の終わりに返され、new のまま残る
    expect(db.leasedIds()).toEqual([]);

    const r2 = await db.run();
    expect(db.claims.flat()[200]).toBe("t0200");
    expect(r2).toMatchObject({ attempted: 200, processed: 0, truncated: true });

    // 3回目で、従来は永久に届かなかった健全な 50 件に届く。末尾に届いた後の折返しでは、直前の回で返された失敗分を再び調べる
    const r3 = await db.run();
    expect(db.claims.flat().slice(400, 450)).toEqual(ids(400, 50));
    expect(r3).toMatchObject({ attempted: MAX_ATTEMPTS_PER_RUN, processed: 50, truncated: true });
    expect(db.recorded).toHaveLength(50);

    // どの回も試みた数は 200 以内
    for (const run of [r1, r2, r3]) expect(run.attempted).toBeLessThanOrEqual(MAX_ATTEMPTS_PER_RUN);
    expect(db.claims.every((c) => c.length <= 1)).toBe(true); // 借りるのは常に 1 件ずつ
    // 失敗した 400 件は消えず new のまま残る（業務上の状態を作り出していない）
    expect(db.pendingIds()).toHaveLength(400);
    expect(db.leasedIds()).toEqual([]);
  });

  it("失敗した群は貸出しを返して巡回が戻ったときに再び調べられ、直っていれば処理される（eventual retry）", async () => {
    const db = new FakeDb(Array.from({ length: 450 }, (_, i) => row(i)));
    db.failing = (v) => num(v) < 400;
    await db.run();
    await db.run();
    const third = await db.run(); // 末尾に届いて先頭へ戻り、返された失敗分を再び調べる
    expect(db.claims.flat()[450]).toBe("t0000");
    expect(third.failures).toHaveLength(150);

    // 原因が直った後は、数回の巡回ですべて処理される
    db.failing = () => false;
    for (let i = 0; i < 5 && db.pendingIds().length > 0; i++) await db.run();
    expect(db.pendingIds()).toHaveLength(0);
    expect(db.recorded.filter((v) => num(v) < 400)).toHaveLength(400);
    expect(db.leasedIds()).toEqual([]);
  });

  it("実行ごとに新しいストア（別の所有者）でも位置が引き継がれる", async () => {
    const db = new FakeDb(Array.from({ length: 30 }, (_, i) => row(i)));
    db.failing = () => true;
    await db.run(10);
    await db.run(10);
    await db.run(10);
    expect(db.claims.flat()).toEqual(ids(0, 30));
  });

  it("成功で未判定の集合が縮んでも、位置で進むので取りこぼさない（offset ではずれない）", async () => {
    const db = new FakeDb(Array.from({ length: 30 }, (_, i) => row(i)));
    db.failing = (v) => num(v) >= 10; // 先頭 10 件だけ成功する
    await db.run(10);
    expect(db.pendingIds()).toHaveLength(20);
    await db.run(10);
    // offset 方式なら t0020 から始まって t0010〜t0019 を飛ばす。位置方式は t0010 から
    expect(db.claims.flat().slice(10, 20)).toEqual(ids(10, 10));
  });

  it("同じ日付が多数あっても (txn_date, id) の順で、ページ境界を跨いで重複も欠落もない", async () => {
    // 同日 23 件に別の日付を混ぜ、id の並びと日付の並びが一致しない状態にする
    const rows = [...Array.from({ length: 23 }, (_, i) => row(i + 100, "2026-10-05")), row(5, "2026-10-06"), row(900, "2026-10-04")];
    const db = new FakeDb(rows);
    for (let i = 0; i < 3; i++) await db.run(10);

    const flat = db.claims.flat();
    expect(flat).toHaveLength(25);
    expect(new Set(flat).size).toBe(25);
    // 日付が最も古い t0900 が先頭、同日は id 昇順、最後が一番新しい日付の t0005
    expect(flat[0]).toBe("t0900");
    expect(flat.slice(1, 24)).toEqual(ids(100, 23));
    expect(flat[24]).toBe("t0005");
  });

  it("同じ日付の明細は挿入順に関わらず id 順に渡り、位置は渡した最後の明細に進む。折返し後は貸出し中の同日の明細だけを飛ばす", () => {
    const db = new FakeDb([row(3, "2026-10-05"), row(1, "2026-10-05"), row(2, "2026-10-05"), row(4, "2026-10-05")]);
    expect(db.claim(db.newOwner(), 1).map((r) => r.id)).toEqual(["t0001"]);
    expect(db.claim(db.newOwner(), 2).map((r) => r.id)).toEqual(["t0002", "t0003"]);
    expect(db.cursor).toEqual({ txnDate: "2026-10-05", id: "t0003" });
    expect(db.claim(db.newOwner(), 2).map((r) => r.id)).toEqual(["t0004"]); // 末尾 → 位置は先頭へ
    expect(db.cursor).toBeUndefined();
    // t0001〜t0004 はすべて貸出し中（期限内）。期限後に同日の id 順で再び渡る
    expect(db.claim(db.newOwner(), 10)).toEqual([]);
    db.clock += TTL_MS;
    expect(db.claim(db.newOwner(), 10).map((r) => r.id)).toEqual(["t0001", "t0002", "t0003", "t0004"]);
  });

  it("空: 未判定が無ければ何も試みず、位置は先頭のまま", async () => {
    const db = new FakeDb([]);
    const result = await db.run();
    expect(result).toEqual({ processed: 0, byConfidence: { high: 0, medium: 0, low: 0 }, failures: [], attempted: 0, truncated: false });
    expect(db.cursor).toBeUndefined();
  });

  it("末尾: 上限未満で終わると位置は先頭に戻り、truncated にならない", async () => {
    const db = new FakeDb(Array.from({ length: 7 }, (_, i) => row(i)));
    const result = await db.run(10);
    expect(result).toMatchObject({ attempted: 7, processed: 7, truncated: false });
    expect(db.cursor).toBeUndefined();
  });

  it("末尾: ちょうど上限で終わった次の実行は、空振りにならず先頭に戻って取り直す", async () => {
    const db = new FakeDb(Array.from({ length: 20 }, (_, i) => row(i)));
    db.failing = () => true;
    await db.run(10);
    await db.run(10); // ちょうど 20 件目で位置は t0019
    expect(db.cursor).toEqual({ txnDate: "2026-10-01", id: "t0019" });
    const wrapped = await db.run(10);
    expect(db.claims.flat()[20]).toBe("t0000");
    expect(wrapped.attempted).toBe(10);
  });

  it("末尾の位置の後ろに全て無くなっていれば、全件処理済みの空の実行で位置が戻る", async () => {
    const db = new FakeDb(Array.from({ length: 10 }, (_, i) => row(i)));
    const first = await db.run(10);
    expect(first).toMatchObject({ processed: 10, truncated: true });
    const second = await db.run(10);
    expect(second).toMatchObject({ attempted: 0, truncated: false });
    expect(db.cursor).toBeUndefined();
  });

  it("後から取り込まれた古い日付の明細は、位置より前でも次の巡回で拾われる", async () => {
    const db = new FakeDb(Array.from({ length: 20 }, (_, i) => row(i, "2026-10-10")));
    db.failing = () => true;
    await db.run(10);
    db.add(row(500, "2026-09-01")); // 位置より前に入る
    await db.run(10); // 位置の後ろの残り
    await db.run(10); // 先頭に戻る
    expect(db.claims.flat()[20]).toBe("t0500");
  });
});

describe("runProposalJob: 並行する実行と貸出し", () => {
  it("同時に走る実行は重ならない範囲を受け取り、位置は後戻りしない", async () => {
    const db = new FakeDb(Array.from({ length: 40 }, (_, i) => row(i)));
    db.failing = () => true; // 位置が進むことだけを見る
    await Promise.all([db.run(10), db.run(10), db.run(10), db.run(10)]);

    const flat = db.claims.flat();
    expect(flat).toHaveLength(40);
    expect(new Set(flat).size).toBe(40);
    // 位置の履歴は単調に増える（古い位置で上書きされない）。最後の 1 回だけ末尾で上限ちょうどのため t0039
    const defined = db.cursorHistory.filter((c) => c !== undefined).map((c) => c!.id);
    expect(defined).toEqual([...defined].sort());
    expect(db.cursor).toEqual({ txnDate: "2026-10-01", id: "t0039" });
  });

  it("位置が末尾で折り返した直後の別の実行は、記録前（AI 呼出し中）の明細を受け取らず、AI は 1 明細につき 1 回だけ", async () => {
    // 5 件 < 上限 10: 1 つ目の実行の claim で位置は先頭に戻る。2 つ目が同じ 5 件を受け取ると AI が二重に呼ばれる
    const db = new FakeDb(Array.from({ length: 5 }, (_, i) => aiRow(i)));
    const ai = countingAi();
    const [a, b] = await Promise.all([db.run(10, ai), db.run(10, ai)]);
    // 2 つの実行は 1 件ずつ交互に借りるので、重ならずに 5 件を分け合う
    const flat = db.claims.flat();
    expect([...flat].sort()).toEqual(ids(0, 5));
    expect(a.processed + b.processed).toBe(5);
    expect(ai).toHaveBeenCalledTimes(5);
    expect(db.recorded.sort()).toEqual(ids(0, 5));
  });

  it("一部だけ貸出し中のとき（部分バッチ）、別の実行は貸出し中を除いた残りだけを受け取る", () => {
    const db = new FakeDb(Array.from({ length: 6 }, (_, i) => row(i)));
    const a = db.newOwner();
    expect(db.claim(a, 3).map((r) => r.id)).toEqual(ids(0, 3)); // 位置は t0002
    db.cursor = undefined; // 折り返した後の状態（別の実行が先頭から来る）
    expect(db.claim(db.newOwner(), 10).map((r) => r.id)).toEqual(ids(3, 3)); // t0000〜t0002 は貸出し中
    expect(db.claim(db.newOwner(), 10)).toEqual([]); // 全て貸出し中
  });

  it("受け取った後に保留にされた明細は、AI を呼ばずに見送られ、保留のまま残る", async () => {
    const db = new FakeDb([aiRow(1), aiRow(2)]);
    const store = db.store();
    const ai = countingAi();
    const result = await runProposalJob({
      store: {
        ...store,
        claimPendingBatch: async (limit) => {
          const batch = await store.claimPendingBatch(limit);
          db.status.set("t0001", "on_hold"); // 受け取った後、担当者が保留にした
          return batch;
        },
      },
      ai,
      today: TODAY,
    });
    expect(result.processed).toBe(1);
    expect(result.failures).toEqual([{ bankTransactionId: "t0001", error: expect.stringContaining("貸出し") }]);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(db.status.get("t0001")).toBe("on_hold");
    expect(db.recorded).toEqual(["t0002"]);
  });

  it("所有の確認のあとに保留にされたら、記録は DB が拒否し、保留のまま残る（貸出しは返される）", async () => {
    const db = new FakeDb([aiRow(1)]);
    const store = db.store();
    const result = await runProposalJob({
      store: {
        ...store,
        confirmClaim: async (txnId) => {
          const ok = await store.confirmClaim(txnId);
          db.status.set(txnId, "on_hold"); // 確認の直後、AI を呼んでいる間に担当者が保留にした
          return ok;
        },
      },
      ai: countingAi(),
      today: TODAY,
    });
    expect(result.processed).toBe(0);
    expect(result.failures).toEqual([{ bankTransactionId: "t0001", error: expect.stringContaining("not waiting for a proposal") }]);
    expect(db.status.get("t0001")).toBe("on_hold");
    expect(db.recorded).toEqual([]);
    expect(db.leasedIds()).toEqual([]);
  });
});

describe("runProposalJob: 所有者の喪失と期限切れ", () => {
  it("期限内は他の実行に渡らず、期限が切れた貸出しだけが次の実行に渡る", () => {
    const db = new FakeDb([row(1)]);
    expect(db.claim(db.newOwner(), 10).map((r) => r.id)).toEqual(["t0001"]);
    db.clock += TTL_MS - 1;
    expect(db.claim(db.newOwner(), 10)).toEqual([]);
    db.clock += 1;
    expect(db.claim(db.newOwner(), 10).map((r) => r.id)).toEqual(["t0001"]);
  });

  it("期限切れで他の実行に奪われた古い実行は、AI を呼ばず、記録もせず、奪った側の貸出しを消さない", async () => {
    const db = new FakeDb([aiRow(1)]);
    const stale = db.store();
    const rowsOfStale = await stale.claimPendingBatch(10);
    /** 古い実行が最初に借りた行を 1 回だけ返すストア（以降は空） */
    const handOver = (rows: BankTransaction[]) => {
      const pending = [...rows];
      return async () => pending.splice(0);
    };
    db.clock += TTL_MS; // 期限切れ
    const fresh = db.store();
    expect((await fresh.claimPendingBatch(10)).map((r) => r.id)).toEqual(["t0001"]);

    const ai = countingAi();
    const result = await runProposalJob({ store: { ...stale, claimPendingBatch: handOver(rowsOfStale) }, ai, today: TODAY });
    expect(ai).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(db.recorded).toEqual([]);
    expect(db.leases.get("t0001")?.owner).toBe(fresh.owner); // 古い実行の返却は奪った側に影響しない

    // 奪った側は通常どおり処理できる
    const freshResult = await runProposalJob({ store: { ...fresh, claimPendingBatch: handOver(rowsOfStale) }, ai, today: TODAY });
    expect(freshResult.processed).toBe(1);
    expect(db.recorded).toEqual(["t0001"]);
  });

  it("文脈の読込の間に期限が切れて奪われたら、AI を呼ばず、記録もせず、人の状態も奪った側の貸出しも変えない", async () => {
    const db = new FakeDb([aiRow(1)]);
    const stale = db.store();
    const fresh = db.store();
    let takenOver: string[] = [];
    const ai = countingAi();
    const result = await runProposalJob({
      store: {
        ...stale,
        // 文脈の読込が遅い間に、期限が切れて別の実行が同じ明細を借りる
        loadCustomerContext: async (...args) => {
          db.clock += TTL_MS;
          takenOver = (await fresh.claimPendingBatch(10)).map((r) => r.id);
          return stale.loadCustomerContext(...args);
        },
      },
      ai,
      today: TODAY,
    });
    expect(takenOver).toEqual(["t0001"]);
    expect(ai).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.failures).toEqual([{ bankTransactionId: "t0001", error: expect.stringContaining("他の実行") }]);
    expect(db.recorded).toEqual([]);
    expect(db.status.get("t0001")).toBe("new");
    expect(db.leases.get("t0001")?.owner).toBe(fresh.owner);
  });

  it("文脈の読込の間に時間の予算が尽きたら、AI を呼ばず、貸出しを返して打ち切る（失敗には数えない）", async () => {
    const db = new FakeDb([aiRow(1)]);
    const store = db.store();
    let t = 0;
    const ai = countingAi();
    const result = await runProposalJob({
      store: {
        ...store,
        loadCustomerContext: async (...args) => {
          t += 1000; // 読込が遅く、予算（500ms）を超えた
          return store.loadCustomerContext(...args);
        },
      },
      ai,
      today: TODAY,
      now: () => t,
      budgetMs: 500,
    });
    expect(ai).not.toHaveBeenCalled();
    expect(result).toMatchObject({ processed: 0, attempted: 1, truncated: true, failures: [] });
    expect(db.status.get("t0001")).toBe("new");
    expect(db.leasedIds()).toEqual([]);
  });

  it("AI の呼出し中に期限が切れて奪われたら、古い実行の記録は拒否される（AI の二重呼出しは起こりうるが、記録は 1 回だけ）", async () => {
    const db = new FakeDb([aiRow(1)]);
    const stale = db.store();
    const fresh = db.store();
    // 古い実行の AI が遅い間に、期限が切れて別の実行が同じ明細を借りる
    const slowAi = vi.fn<JournalAi>(async () => {
      db.clock += TTL_MS;
      expect((await fresh.claimPendingBatch(10)).map((r) => r.id)).toEqual(["t0001"]);
      return okResult;
    });
    const staleResult = await runProposalJob({ store: stale, ai: slowAi, today: TODAY });
    expect(staleResult.processed).toBe(0);
    expect(staleResult.failures).toEqual([{ bankTransactionId: "t0001", error: expect.stringContaining("not held by this owner") }]);
    expect(db.leases.get("t0001")?.owner).toBe(fresh.owner);

    let handed = false;
    const freshResult = await runProposalJob({
      store: { ...fresh, claimPendingBatch: async () => (handed ? [] : ((handed = true), [aiRow(1)])) },
      ai: countingAi(),
      today: TODAY,
    });
    expect(freshResult.processed).toBe(1);
    expect(db.recorded).toEqual(["t0001"]); // 記録は 1 回
  });

  it("期限が切れても誰にも奪われていなければ、元の実行は記録できる（AI の費用を無駄にしない）", async () => {
    const db = new FakeDb([aiRow(1)]);
    const ai = vi.fn<JournalAi>(async () => {
      db.clock += TTL_MS * 2; // 期限切れ。ただし他の実行は来ていない
      return okResult;
    });
    const result = await db.run(10, ai);
    expect(result.processed).toBe(1);
    expect(db.recorded).toEqual(["t0001"]);
  });
});

describe("runProposalJob: 失敗・中止・クラッシュ", () => {
  it("失敗した明細は貸出しを返して new のまま残り、他の明細は続けて処理される", async () => {
    const db = new FakeDb([row(1), row(2), row(3)]);
    db.failing = (v) => v === "t0002";
    const result = await db.run(10);
    expect(result).toMatchObject({ processed: 2, attempted: 3 });
    expect(result.failures).toEqual([{ bankTransactionId: "t0002", error: "persistent failure" }]);
    expect(db.status.get("t0002")).toBe("new");
    expect(db.leasedIds()).toEqual([]);
  });

  it("文脈の読込が失敗した明細も、AI を呼ばずに貸出しを返す", async () => {
    const db = new FakeDb([aiRow(1)]);
    const store = db.store();
    const ai = countingAi();
    const result = await runProposalJob({
      store: {
        ...store,
        loadCustomerContext: async () => {
          throw new Error("master read failed");
        },
      },
      ai,
      today: TODAY,
    });
    expect(result.failures).toEqual([{ bankTransactionId: "t0001", error: "master read failed" }]);
    expect(ai).not.toHaveBeenCalled();
    expect(db.leasedIds()).toEqual([]);
  });

  it("実行が途中の例外で中断されても、未処理の貸出しを返してから例外を伝える（中止）", async () => {
    const db = new FakeDb([row(1), row(2), row(3)]);
    // 時計の呼出し回数ではなく進捗で中断する: 1件目の記録が終わった後の最初の時計の読み取り（2件目の借りる前の予算確認）で投げる
    const now = () => {
      if (db.recorded.length >= 1) throw new Error("cancelled");
      return 0;
    };
    await expect(db.run(10, unusedAi(), { now })).rejects.toThrow("cancelled");
    expect(db.recorded).toEqual(["t0001"]);
    expect(db.leasedIds()).toEqual([]); // 明細は1件ずつ借りるので、t0002・t0003 は借りられておらず、貸出しは残っていない
    expect(db.pendingIds()).toEqual(["t0002", "t0003"]);
  });

  it("貸出しの返却が失敗しても、実行の結果は隠れない。返せなかった貸出しは期限で切れて再び渡る", async () => {
    const db = new FakeDb([row(1), row(2)]);
    db.failing = (v) => v === "t0001";
    const store = db.store();
    const result = await runProposalJob({
      store: {
        ...store,
        releaseClaims: async () => {
          throw new Error("release failed");
        },
      },
      ai: unusedAi(),
      today: TODAY,
    });
    expect(result.processed).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(db.claim(db.newOwner(), 10)).toEqual([]); // 期限内は渡らない
    db.clock += TTL_MS;
    expect(db.claim(db.newOwner(), 10).map((r) => r.id)).toEqual(["t0001"]);
  });

  it("受け取った直後に実行が落ちても、貸出しの期限までは二重に渡らず、期限後の巡回で処理される（クラッシュ）", async () => {
    const db = new FakeDb(Array.from({ length: 5 }, (_, i) => row(i)));
    db.claim(db.newOwner(), 10); // 受け取った（位置は先頭に戻った）が、処理も返却もせずに落ちた
    expect(db.pendingIds()).toHaveLength(5);

    const during = await db.run(10);
    expect(during).toMatchObject({ attempted: 0, processed: 0 });
    expect(db.pendingIds()).toHaveLength(5);

    db.clock += TTL_MS; // 落ちた実行の貸出しが切れる
    const after = await db.run(10);
    expect(after).toMatchObject({ attempted: 5, processed: 5 });
    expect(db.pendingIds()).toHaveLength(0);
    expect(db.leasedIds()).toEqual([]);
  });

  it("取得が失敗したら実行全体が失敗する（黙って成功扱いにしない）", async () => {
    const store: ProposalStore = {
      claimPendingBatch: async () => {
        throw new Error("db down");
      },
      confirmClaim: async () => true,
      releaseClaims: async () => undefined,
      loadCustomerContext: async () => sampleContext(),
      recordDecision: async () => "d",
    };
    await expect(runProposalJob({ store, ai: unusedAi(), today: TODAY })).rejects.toThrow("db down");
  });
});

describe("runProposalJob: 時間の上限", () => {
  it("1件の判定が待ち時間の上限を超えたら待つのをやめ、遅れた結果は記録せず、貸出しは期限まで返さない", async () => {
    const db = new FakeDb([aiRow(1), row(2)]);
    let finishLate: (r: AiCallResult) => void = () => undefined;
    const hanging = vi.fn<JournalAi>(() => new Promise<AiCallResult>((resolve) => (finishLate = resolve)));
    const store = db.store();
    const result = await runProposalJob({ store, ai: hanging, today: TODAY, aiTimeoutMs: 10 });

    // t0001 は待ちきれず失敗、t0002（ルール一致で AI なし）は続けて処理される
    expect(result.failures).toEqual([{ bankTransactionId: "t0001", error: expect.stringContaining("終わりませんでした") }]);
    expect(result.processed).toBe(1);
    // 呼出しが続いているかもしれないので、貸出しは自分のまま残り、他の実行には渡らない
    expect(db.leases.get("t0001")?.owner).toBe(store.owner);
    expect(db.claim(db.newOwner(), 10)).toEqual([]);

    // 遅れて届いた結果は、どこにも記録されない
    finishLate(okResult);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(db.recorded).toEqual(["t0002"]);

    // 期限が切れれば次の実行が引き受ける
    db.clock += TTL_MS;
    expect(db.claim(db.newOwner(), 10).map((r) => r.id)).toEqual(["t0001"]);
  });

  it("待ちきれなかった後に元の処理が失敗しても、未処理の拒否として落ちない", async () => {
    const db = new FakeDb([aiRow(1)]);
    let failLate: (e: Error) => void = () => undefined;
    const hanging = vi.fn<JournalAi>(() => new Promise<AiCallResult>((_, reject) => (failLate = reject)));
    const result = await db.run(10, hanging, { aiTimeoutMs: 5 });
    expect(result.failures).toHaveLength(1);
    failLate(new Error("late failure"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  });

  it("時間の予算を超えたら新しい判定を始めず、残りの貸出しを返して truncated にする", async () => {
    const db = new FakeDb(Array.from({ length: 5 }, (_, i) => aiRow(i)));
    let t = 0;
    const ai = vi.fn<JournalAi>(async () => {
      t += 100; // 1件ごとに 100ms かかる
      return okResult;
    });
    const result = await db.run(10, ai, { now: () => t, budgetMs: 250 });
    expect(result).toMatchObject({ attempted: 3, processed: 3, truncated: true });
    expect(ai).toHaveBeenCalledTimes(3);
    expect(db.recorded).toEqual(ids(0, 3));
    expect(db.leasedIds()).toEqual([]); // 未着手の 2 件は返された
    expect(db.pendingIds()).toEqual(ids(3, 2));
  });

  describe("所有確認（confirmClaim）が遅く予算を使い切ったとき", () => {
    const BUDGET = 500;
    /** confirmClaim の成否はそのまま返し、返す直前に合成時計を elapsed まで進める。releaseClaims の引数を記録する */
    function slowConfirm(db: FakeDb, elapsed: number, forceResult?: boolean) {
      const base = db.store();
      const clock = { t: 0 };
      const released: string[][] = [];
      const store: ProposalStore = {
        ...base,
        confirmClaim: async (txnId) => {
          const ok = await base.confirmClaim(txnId);
          clock.t = elapsed;
          return forceResult ?? ok;
        },
        releaseClaims: async (txnIds) => {
          released.push(txnIds);
          await base.releaseClaims(txnIds);
        },
      };
      return { store, clock, released };
    }

    it.each([BUDGET, BUDGET + 1])("確認が成功して経過が %i ms（予算以上）になったら、AI を呼ばず記録せず、貸出しを返して打ち切り、次の実行が処理できる", async (elapsed) => {
      const db = new FakeDb([aiRow(1)]);
      const { store, clock, released } = slowConfirm(db, elapsed);
      const ai = countingAi();
      const result = await runProposalJob({ store, ai, today: TODAY, now: () => clock.t, budgetMs: BUDGET });

      expect(ai).not.toHaveBeenCalled();
      expect(result).toMatchObject({ processed: 0, attempted: 1, truncated: true, failures: [] });
      expect(db.recorded).toEqual([]);
      expect(released).toEqual([["t0001"]]);
      expect(db.leasedIds()).toEqual([]);
      expect(db.status.get("t0001")).toBe("new");

      // 打ち切りは失敗ではなく、明細は残る。次の実行（別の所有者・予算内）が処理できる
      const next = await db.run(10, ai);
      expect(next).toMatchObject({ processed: 1, attempted: 1, failures: [] });
      expect(ai).toHaveBeenCalledTimes(1);
      expect(db.recorded).toEqual(["t0001"]);
    });

    it("確認が成功しても経過が予算内（予算 -1 ms）なら、従来どおり判定して記録する", async () => {
      const db = new FakeDb([aiRow(1)]);
      const { store, clock } = slowConfirm(db, BUDGET - 1);
      const ai = countingAi();
      const result = await runProposalJob({ store, ai, today: TODAY, now: () => clock.t, budgetMs: BUDGET });

      expect(ai).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ processed: 1, attempted: 1, failures: [] });
      expect(db.recorded).toEqual(["t0001"]);
      expect(db.leasedIds()).toEqual([]);
    });

    it("確認が失敗（奪われた）なら、予算超過でも従来どおり失敗として数え、AI は呼ばない", async () => {
      const db = new FakeDb([aiRow(1)]);
      const { store, clock } = slowConfirm(db, BUDGET + 1, false);
      const ai = countingAi();
      const result = await runProposalJob({ store, ai, today: TODAY, now: () => clock.t, budgetMs: BUDGET });

      expect(ai).not.toHaveBeenCalled();
      expect(result).toMatchObject({ processed: 0, attempted: 1, truncated: true });
      expect(result.failures).toEqual([{ bankTransactionId: "t0001", error: expect.stringContaining("他の実行") }]);
      expect(db.recorded).toEqual([]);
    });
  });

  it("時間の予算で止まる実行を繰り返しても、各ページの先頭の遅い失敗に健全な明細が飢えず、いずれ全件に届く（位置は判定を始めた分だけ進む）", async () => {
    // 10 件を 1 ページとし、各ページの先頭 4 件が遅く失敗し続ける（1 件 100ms）。健全な明細は 1ms。予算 250ms
    // 200 件を先に借りて位置を進める方式では、先頭の遅い失敗で予算が尽きると、残りの健全な明細を未着手のまま次のページへ飛ばし、
    // 一巡して先頭の遅い失敗でまた予算が尽きるため、健全な明細に永久に届かなかった
    const db = new FakeDb(Array.from({ length: 40 }, (_, i) => aiRow(i)));
    const slow = (v: string) => num(v) % 10 < 4;
    db.failing = slow;
    let t = 0;
    let current = "";
    const ai = vi.fn<JournalAi>(async () => {
      t += slow(current) ? 100 : 1;
      return okResult;
    });
    const healthy = ids(0, 40).filter((v) => !slow(v));

    let runs = 0;
    while (db.recorded.length < healthy.length && runs < 30) {
      runs++;
      const base = db.store();
      const seen: string[] = [];
      const result = await runProposalJob({
        store: {
          ...base,
          confirmClaim: async (v) => {
            current = v;
            seen.push(v);
            return base.confirmClaim(v);
          },
        },
        ai,
        today: TODAY,
        now: () => t,
        budgetMs: 250,
      });
      // 1 回の実行は少なくとも 1 件は判定を始め、同じ明細を 2 度は試みない（失敗は実行の終わりまで借りたまま）
      expect(result.attempted).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(seen.length);
      expect(db.leasedIds()).toEqual([]);
    }
    expect([...db.recorded].sort()).toEqual(healthy);
    // 遅い失敗は new のまま残り、消えたり承認されたりしない
    expect(db.pendingIds()).toEqual(ids(0, 40).filter(slow));
    expect(runs).toBeLessThanOrEqual(30);
  });
});

describe("runProposalJob: 1回の作業量の上限", () => {
  const stubStore = (claim: (limit: number) => BankTransaction[], extra: Partial<ProposalStore> = {}): ProposalStore => ({
    claimPendingBatch: async (limit) => claim(limit),
    confirmClaim: async () => true,
    releaseClaims: async () => undefined,
    loadCustomerContext: async () => sampleContext(),
    recordDecision: async () => "d",
    ...extra,
  });

  it("既定は 200 件。大きな指定や不正な指定でも 200 を超えて借りず、借りるのは常に 1 件ずつ", async () => {
    const limits: number[] = [];
    let n = 0;
    const store = stubStore((limit) => {
      limits.push(limit);
      return [row(n++)]; // 未判定が尽きない
    });
    const attempts: number[] = [];
    for (const size of [undefined, 5000, 0, Number.NaN, 50]) {
      const before = limits.length;
      await runProposalJob({ store, ai: unusedAi(), today: TODAY }, size);
      attempts.push(limits.length - before);
    }
    expect(attempts).toEqual([200, 200, 200, 200, 50]);
    expect(new Set(limits)).toEqual(new Set([1]));
  });

  it("ストアが 1 件を超えて返しても、判定するのは 1 件で、余分に借りた分の貸出しは返される", async () => {
    const many = Array.from({ length: 3 }, (_, i) => row(i));
    const recordDecision = vi.fn(async () => "d");
    const released: string[][] = [];
    let handed = false;
    const store = stubStore(() => (handed ? [] : ((handed = true), many)), {
      recordDecision,
      releaseClaims: async (v) => {
        released.push(v);
      },
    });
    const result = await runProposalJob({ store, ai: unusedAi(), today: TODAY });
    expect(result.attempted).toBe(1);
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(released).toEqual([ids(1, 2)]);
  });
});

describe("supabaseProposalStore（貸出しの RPC）", () => {
  function rpcClient(response: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn<(fn: string, args?: Record<string, unknown>) => Promise<typeof response>>(async () => response);
    const from = vi.fn();
    return { client: { rpc, from } as unknown as SupabaseClient, rpc, from };
  }
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("claim: service 専用の RPC を上限・所有者・貸出し期間つきで呼ぶだけで、表を直接読まず、位置を送らない", async () => {
    const { client, rpc, from } = rpcClient({ data: [], error: null });
    await supabaseProposalStore(client).claimPendingBatch(200);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("claim_pending_proposal_batch", {
      p_limit: 200,
      p_owner: expect.stringMatching(UUID_RE),
      p_lease_seconds: CLAIM_LEASE_SECONDS,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("貸出し期間は関数の最大実行時間（300 秒）より長く、DB 側の上限（3600 秒）以内", () => {
    expect(CLAIM_LEASE_SECONDS).toBeGreaterThan(300);
    expect(CLAIM_LEASE_SECONDS).toBeLessThanOrEqual(3600);
  });

  it("同じストアは claim・確認・返却・記録で同じ所有者を使い、別のストア（別の実行）は別の所有者を使う", async () => {
    const { client, rpc } = rpcClient({ data: true, error: null });
    const a = supabaseProposalStore(client);
    const b = supabaseProposalStore(client);
    await a.confirmClaim("t1");
    await a.releaseClaims(["t1", "t2"]);
    await b.confirmClaim("t1");
    const owners = rpc.mock.calls.map((c) => c[1]?.p_owner);
    expect(owners[0]).toBe(owners[1]);
    expect(owners[2]).not.toBe(owners[0]);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["renew_proposal_claim", "release_proposal_claims", "renew_proposal_claim"]);
    expect(rpc.mock.calls[1]![1]).toEqual({ p_owner: owners[0], p_ids: ["t1", "t2"] });
  });

  it("confirmClaim は renew の結果をそのまま返し、RPC のエラーや想定外の形は握りつぶさない", async () => {
    expect(await supabaseProposalStore(rpcClient({ data: false, error: null }).client).confirmClaim("t1")).toBe(false);
    await expect(supabaseProposalStore(rpcClient({ data: null, error: { message: "permission denied" } }).client).confirmClaim("t1")).rejects.toThrow("permission denied");
    await expect(supabaseProposalStore(rpcClient({ data: "yes", error: null }).client).confirmClaim("t1")).rejects.toThrow();
  });

  it("releaseClaims: 空なら RPC を呼ばず、エラーは投げる", async () => {
    const empty = rpcClient({ data: 0, error: null });
    await supabaseProposalStore(empty.client).releaseClaims([]);
    expect(empty.rpc).not.toHaveBeenCalled();
    await expect(supabaseProposalStore(rpcClient({ data: null, error: { message: "boom" } }).client).releaseClaims(["t1"])).rejects.toThrow("boom");
  });

  it("recordDecision: 所有者つきの記録専用 RPC を呼び、record_ai_decision を直接呼ばない", async () => {
    const decisionRow = toAiDecisionRow(await proposeForTransaction(sampleContext(), aiRow(1), countingAi()));
    const decisionId = "50000000-0000-4000-8000-000000000001";
    const { client, rpc } = rpcClient({ data: decisionId, error: null });
    const store = supabaseProposalStore(client);
    expect(await store.recordDecision(decisionRow)).toBe(decisionId);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_claimed_ai_decision", { p_owner: expect.stringMatching(UUID_RE), p_decision: decisionRow });
    await expect(supabaseProposalStore(rpcClient({ data: null, error: { message: "not held by this owner" } }).client).recordDecision(decisionRow)).rejects.toThrow(
      "not held by this owner",
    );
  });

  it("claim: 返った行を明細に変換し、余分な列は捨てる", async () => {
    const { client } = rpcClient({
      data: [
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          customer_id: "10000000-0000-4000-8000-000000000001",
          wallet_id: "20000000-0000-4000-8000-000000000001",
          import_id: "x",
          txn_date: "2026-10-05",
          amount: 9020,
          direction: "expense",
          description: "ｻﾝﾌﾟﾙ",
          dedupe_key: "secret-key",
          status: "new",
        },
      ],
      error: null,
    });
    const rows = await supabaseProposalStore(client).claimPendingBatch(10);
    expect(rows).toEqual([
      {
        id: "00000000-0000-4000-8000-0000000000a1",
        customerId: "10000000-0000-4000-8000-000000000001",
        walletId: "20000000-0000-4000-8000-000000000001",
        txnDate: "2026-10-05",
        amount: 9020,
        direction: "expense",
        description: "ｻﾝﾌﾟﾙ",
      },
    ]);
  });

  it("claim: RPC のエラーは握りつぶさず投げる。想定外の形の行は拒否する", async () => {
    await expect(supabaseProposalStore(rpcClient({ data: null, error: { message: "permission denied" } }).client).claimPendingBatch(10)).rejects.toThrow("permission denied");
    await expect(supabaseProposalStore(rpcClient({ data: [{ id: "a" }], error: null }).client).claimPendingBatch(10)).rejects.toThrow();
  });
});
