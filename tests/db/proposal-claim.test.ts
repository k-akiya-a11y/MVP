import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { applyShim, createDisposableDatabase, noop, openClient, validateBaseUrl, type DisposableDatabase } from "./disposable-db";
import { CUSTOMER_A, CUSTOMER_B, WALLET_A, asActor, expectQueryError } from "./helpers";

/**
 * supabase/migrations/20261024000100_proposal_scan_cursor.sql
 * （claim_pending_proposal_batch・renew_proposal_claim・release_proposal_claims・record_claimed_ai_decision・走査位置・貸出し）のテスト。
 * 注意: このファイルは書いただけで、まだどの DB にも実行していない（未実行）。実行は `npm run test:db` を許可された
 * ローカルの PostgreSQL に対して行う。
 * このファイル専用の使い捨て DB（disposable-db.ts。作った DB だけを削除する）を作り、現在の土台（shim）・マイグレーション・seed を適用し、
 * すべての接続をその DB にだけつなぐ。TEST_DATABASE_URL の共有 DB の行は読みも書きもしない。
 * 大半のテストは 1 トランザクション内で行いロールバックする（トランザクション内では now() が固定なので、期限切れは
 * lease_expires_at を直接書き換えて再現する）。末尾の「2 つの接続で確定する貸出し」だけは実際に commit し、テストごとに後始末する。
 * 判断ログは追記専用で消せないので、確定させて作ることはしない。
 */

const DB_PREFIX = "mvp_claim_test_";

let disposable: DisposableDatabase | undefined;
let client: Client;

/** 使い捨て DB への接続（接続・文・トランザクション内の待機に上限がある） */
const connect = (label: string): Promise<Client> => {
  if (!disposable) throw new Error("the disposable database is not ready");
  return openClient(disposable.url, label);
};

beforeAll(async () => {
  const base = validateBaseUrl();
  disposable = await createDisposableDatabase(base, DB_PREFIX);
  try {
    client = await connect("proposal-claim-test");
    await applyShim(client, readFileSync(join(process.cwd(), "tests/db/supabase-shim.sql"), "utf8"));
    for (const dir of ["supabase/migrations", "supabase/seed"]) {
      for (const name of readdirSync(join(process.cwd(), dir)).filter((n) => n.endsWith(".sql")).sort()) {
        await client.query(readFileSync(join(process.cwd(), dir, name), "utf8"));
      }
    }
  } catch (error) {
    await client?.end().catch(noop);
    await disposable.drop();
    throw error;
  }
}, 180_000);

afterAll(async () => {
  try {
    await client?.end().catch(noop);
  } finally {
    await disposable?.drop(); // 失敗は握りつぶさない
  }
}, 60_000);

const uuid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const num = (v: string) => Number(v.slice(-12));
const OWNER_A = "a0000000-0000-4000-8000-00000000000a";
const OWNER_B = "b0000000-0000-4000-8000-00000000000b";

/** 既存の未判定（seed など）を保留に退避し、位置を先頭に戻し、貸出しを空にする。ロールバックされるので他のテストに影響しない */
async function isolate(): Promise<string> {
  await client.query("reset role");
  await client.query("update public.bank_transactions set status = 'on_hold' where status = 'new'");
  await client.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null");
  await client.query("delete from public.proposal_leases");
  const imp = await client.query<{ id: string }>(
    `insert into public.statement_imports (customer_id, wallet_id, source, row_count, inserted_count)
     values ($1, $2, 'csv', 1, 1) returning id`,
    [CUSTOMER_A, WALLET_A],
  );
  return imp.rows[0]!.id;
}

async function addTxn(importId: string, n: number, date = "2026-10-01"): Promise<void> {
  await client.query("reset role");
  await client.query(
    `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
     values ($1, $2, $3, $4, $5, 100, 'expense', 'claim test', $6)`,
    [uuid(n), CUSTOMER_A, WALLET_A, importId, date, `claim-${n}`],
  );
}

/** service_role として fn を実行し、必ずロールを戻す（テーブル所有者の操作と混ぜない） */
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("reset role");
  await client.query("set local role service_role");
  try {
    return await fn();
  } finally {
    await client.query("reset role");
  }
}

async function claim(limit: number | null, owner: string | null = OWNER_A, leaseSeconds: number | null = 600): Promise<number[]> {
  const res = await asService(() =>
    client.query<{ id: string }>("select id from public.claim_pending_proposal_batch($1, $2, $3)", [limit, owner, leaseSeconds]),
  );
  return res.rows.map((r) => num(r.id));
}

async function renew(owner: string | null, n: number): Promise<boolean> {
  const res = await asService(() => client.query<{ ok: boolean }>("select public.renew_proposal_claim($1, $2, 600) as ok", [owner, uuid(n)]));
  return res.rows[0]!.ok;
}

async function release(owner: string | null, ns: number[] | null): Promise<number> {
  const res = await asService(() =>
    client.query<{ n: number }>("select public.release_proposal_claims($1, $2::uuid[]) as n", [owner, ns === null ? null : ns.map(uuid)]),
  );
  return res.rows[0]!.n;
}

const decision = (n: number, customer = CUSTOMER_A) =>
  JSON.stringify({
    customer_id: customer,
    bank_transaction_id: uuid(n),
    transaction_snapshot: { amount: 100 },
    proposal: { account_item_id: 101, tax_code: 21 },
    confidence: "high",
    confidence_breakdown: {},
    model: null,
    prompt_version: null,
  });

async function record(owner: string | null, n: number, customer = CUSTOMER_A): Promise<string> {
  const res = await asService(() =>
    client.query<{ id: string }>("select public.record_claimed_ai_decision($1, $2::jsonb) as id", [owner, decision(n, customer)]),
  );
  return res.rows[0]!.id;
}

async function recordFails(owner: string | null, n: number, customer = CUSTOMER_A): Promise<string> {
  return asService(() => expectQueryError(client, "select public.record_claimed_ai_decision($1, $2::jsonb)", [owner, decision(n, customer)]));
}

async function leases(): Promise<Array<{ n: number; owner: string }>> {
  await client.query("reset role");
  const res = await client.query<{ id: string; owner: string }>("select bank_transaction_id as id, owner from public.proposal_leases order by 1");
  return res.rows.map((r) => ({ n: num(r.id), owner: r.owner }));
}

/** 全ての貸出しの期限を切らす（トランザクション内の now() は固定なので、直接書き換える） */
async function expireAll(): Promise<void> {
  await client.query("reset role");
  await client.query("update public.proposal_leases set lease_expires_at = now() - interval '1 second'");
}

async function cursor(): Promise<number | null> {
  await client.query("reset role");
  const res = await client.query<{ last_id: string | null }>("select last_id from public.proposal_scan_cursor");
  return res.rows[0]!.last_id === null ? null : num(res.rows[0]!.last_id);
}

async function statusOf(n: number): Promise<string> {
  await client.query("reset role");
  return (await client.query<{ status: string }>("select status from public.bank_transactions where id = $1", [uuid(n)])).rows[0]!.status;
}

async function setStatus(n: number, status: string): Promise<void> {
  await client.query("reset role");
  await client.query("update public.bank_transactions set status = $2 where id = $1", [uuid(n), status]);
}

async function decisionCount(): Promise<number> {
  await client.query("reset role");
  return (await client.query<{ n: number }>("select count(*)::int as n from public.ai_decisions")).rows[0]!.n;
}

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    return await fn();
  } finally {
    await client.query("rollback");
  }
}

const FUNCTIONS = [
  "public.claim_pending_proposal_batch(integer, uuid, integer)",
  "public.renew_proposal_claim(uuid, uuid, integer)",
  "public.release_proposal_claims(uuid, uuid[])",
  "public.record_claimed_ai_decision(uuid, jsonb)",
];

describe("走査位置・貸出しとその関数: 権限", () => {
  it("anon・担当者（authenticated）は関数も 2 つの表も使えない。PUBLIC にも実行権限がない", async () => {
    for (const actor of [{ role: "anon" as const }, { role: "authenticated" as const, userId: "00000000-0000-4000-8000-000000000002" }]) {
      await asActor(client, actor, async () => {
        expect(await expectQueryError(client, "select * from public.claim_pending_proposal_batch(10, $1, 600)", [OWNER_A])).toMatch(/permission denied/);
        expect(await expectQueryError(client, "select public.renew_proposal_claim($1, $2, 600)", [OWNER_A, uuid(1)])).toMatch(/permission denied/);
        expect(await expectQueryError(client, "select public.release_proposal_claims($1, '{}')", [OWNER_A])).toMatch(/permission denied/);
        expect(await expectQueryError(client, "select public.record_claimed_ai_decision($1, $2::jsonb)", [OWNER_A, decision(1)])).toMatch(/permission denied/);
        for (const table of ["proposal_scan_cursor", "proposal_leases"]) {
          expect(await expectQueryError(client, `select * from public.${table}`)).toMatch(/permission denied/);
          expect(await expectQueryError(client, `delete from public.${table}`)).toMatch(/permission denied/);
        }
        expect(await expectQueryError(client, "update public.proposal_scan_cursor set last_id = null")).toMatch(/permission denied/);
      });
    }
    for (const fn of FUNCTIONS) {
      const acl = await client.query<{ proacl: string; anon: boolean; auth: boolean; svc: boolean; secdef: boolean }>(
        `select proacl::text,
                has_function_privilege('anon', oid, 'execute') as anon,
                has_function_privilege('authenticated', oid, 'execute') as auth,
                has_function_privilege('service_role', oid, 'execute') as svc,
                prosecdef as secdef
         from pg_proc where oid = $1::regprocedure`,
        [fn],
      );
      expect(acl.rows[0], fn).toMatchObject({ anon: false, auth: false, svc: true, secdef: false });
      expect(acl.rows[0]!.proacl, fn).not.toMatch(/(^\{|,)=X/); // PUBLIC への付与（空の被付与者）がない
    }
  });

  it("service_role は位置を読め・更新でき、貸出しを読み書きできるが、位置の行の削除や追加はできない（1 行のまま）", () =>
    inTx(async () => {
      await client.query("set local role service_role");
      expect((await client.query("select count(*)::int as n from public.proposal_scan_cursor")).rows[0]).toEqual({ n: 1 });
      expect(await expectQueryError(client, "delete from public.proposal_scan_cursor")).toMatch(/permission denied/);
      expect(await expectQueryError(client, "insert into public.proposal_scan_cursor (singleton) values (false)")).toMatch(/permission denied/);
      await client.query("select count(*) from public.proposal_leases");
    }));

  it("2 つの表とも RLS が有効でポリシーが無く、位置の表は 1 行だけを前提にした制約がある", async () => {
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(
      "select relname, relrowsecurity from pg_class where oid in ('public.proposal_scan_cursor'::regclass, 'public.proposal_leases'::regclass) order by relname",
    );
    expect(rls.rows).toEqual([
      { relname: "proposal_leases", relrowsecurity: true },
      { relname: "proposal_scan_cursor", relrowsecurity: true },
    ]);
    const policies = await client.query("select policyname from pg_policies where tablename in ('proposal_scan_cursor', 'proposal_leases')");
    expect(policies.rows).toEqual([]);
    expect((await client.query("select count(*)::int as n from public.proposal_scan_cursor")).rows[0]).toEqual({ n: 1 });
  });
});

describe("claim_pending_proposal_batch: 巡回", () => {
  it("(txn_date, id) の昇順で渡し、同日は id 順、日付が古いものが先。位置が進む", () =>
    inTx(async () => {
      const imp = await isolate();
      // 挿入順は逆。id の大きい n=1 でも日付が古ければ先
      await addTxn(imp, 6, "2026-10-02");
      await addTxn(imp, 5, "2026-10-02");
      await addTxn(imp, 4, "2026-10-02");
      await addTxn(imp, 3, "2026-10-02");
      await addTxn(imp, 9, "2026-10-01");
      expect(await claim(3)).toEqual([9, 3, 4]);
      expect(await cursor()).toBe(4);
      expect(await claim(3)).toEqual([5, 6]);
      // 末尾（上限未満）に届いたので先頭に戻る
      expect(await cursor()).toBeNull();
    }));

  it("渡すだけでは状態を変えず、判断ログも作らない。返却された（失敗した）明細は一巡後に再び渡される", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      const before = await decisionCount();
      expect(await claim(2)).toEqual([1, 2]);
      expect(await claim(2)).toEqual([3]);
      // 1〜3 を一度も処理していない（失敗相当）。貸出しを返すと、一巡後の次の実行で再び 1,2 が渡される
      expect(await release(OWNER_A, [1, 2, 3])).toBe(3);
      expect(await claim(2)).toEqual([1, 2]);
      expect([await statusOf(1), await statusOf(2), await statusOf(3)]).toEqual(["new", "new", "new"]);
      expect(await decisionCount()).toBe(before);
    }));

  it("成功で未判定が減っても、位置の後ろから続けて飛ばさない（offset ではない）", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3, 4, 5, 6]) await addTxn(imp, n);
      expect(await claim(2)).toEqual([1, 2]);
      await setStatus(1, "proposed");
      await setStatus(2, "proposed");
      expect(await claim(2)).toEqual([3, 4]); // offset 方式なら 5,6
    }));

  it("位置の後ろが 0 件で位置が先頭でないときは、その場で先頭から取り直す。全て処理済みなら空で先頭に戻る", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      expect(await claim(3)).toEqual([1, 2, 3]); // ちょうど上限。位置は 3
      expect(await cursor()).toBe(3);
      expect(await release(OWNER_A, [1, 2, 3])).toBe(3);
      expect(await claim(3)).toEqual([1, 2, 3]); // 後ろは 0 件 → 空振りにせず先頭から
      for (const n of [1, 2, 3]) await setStatus(n, "proposed");
      expect(await claim(3)).toEqual([]);
      expect(await cursor()).toBeNull();
    }));

  it("未判定が無ければ空を返し、位置は先頭のまま", () =>
    inTx(async () => {
      await isolate();
      expect(await claim(10)).toEqual([]);
      expect(await cursor()).toBeNull();
    }));

  it("後から入った位置より前の明細は、次の巡回で拾われる", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3, 4]) await addTxn(imp, n, "2026-10-10");
      expect(await claim(2)).toEqual([1, 2]);
      await addTxn(imp, 8, "2026-09-01");
      expect(await claim(2)).toEqual([3, 4]); // 位置の後ろ
      expect(await release(OWNER_A, [1, 2])).toBe(2);
      expect(await claim(2)).toEqual([8, 1]); // 先頭に戻って、古い日付の 8 から
    }));

  it("保留（on_hold）・候補作成済などの明細は渡さない", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3, 4]) await addTxn(imp, n);
      await setStatus(2, "on_hold");
      await setStatus(3, "proposed");
      expect(await claim(10)).toEqual([1, 4]);
    }));

  it("1回に渡す件数は 200 件まで（呼出元が大きな値を指定しても）", () =>
    inTx(async () => {
      const imp = await isolate();
      await client.query(
        `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
         select ('90000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, $2, $3, '2026-10-01', 100, 'expense', 'claim test', 'claim-bulk-' || g
         from generate_series(1, 205) g`,
        [CUSTOMER_A, WALLET_A, imp],
      );
      const first = await claim(1000);
      expect(first).toHaveLength(200);
      expect(first[0]).toBe(1);
      expect(first[199]).toBe(200);
      expect(await cursor()).toBe(200);
      expect(await leases()).toHaveLength(200);
      expect(await claim(1000)).toEqual([201, 202, 203, 204, 205]);
      expect(await cursor()).toBeNull();
    }));

  it("0・負・null の上限では何も渡さず、位置も貸出しも動かさない。所有者が null なら明示的に失敗する", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      expect(await claim(1)).toEqual([1]);
      for (const limit of [0, -5, null]) expect(await claim(limit)).toEqual([]);
      expect(await cursor()).toBe(1);
      expect(await leases()).toEqual([{ n: 1, owner: OWNER_A }]);
      expect(await asService(() => expectQueryError(client, "select * from public.claim_pending_proposal_batch(10, null, 600)"))).toMatch(/p_owner is required/);
    }));

  it("位置の行が無ければ明示的に失敗する（黙って先頭から始めない）", () =>
    inTx(async () => {
      await isolate();
      await client.query("delete from public.proposal_scan_cursor");
      await client.query("set local role service_role");
      expect(await expectQueryError(client, "select * from public.claim_pending_proposal_batch(10, $1, 600)", [OWNER_A])).toMatch(
        /proposal_scan_cursor row is missing/,
      );
    }));
});

describe("claim_pending_proposal_batch: 貸出し（同時実行・折返し・期限）", () => {
  it("貸出しは所有者と期限を持ち、期間は 60 秒〜3600 秒に収まる", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      await claim(1, OWNER_A, 600);
      await claim(1, OWNER_A, 1); // 短すぎる指定は 60 秒に切り上げ
      await claim(1, OWNER_A, 1_000_000); // 長すぎる指定は 3600 秒に切り下げ
      const res = await client.query<{ id: string; secs: number }>(
        "select bank_transaction_id as id, extract(epoch from lease_expires_at - claimed_at)::int as secs from public.proposal_leases order by 1",
      );
      expect(res.rows.map((r) => [num(r.id), r.secs])).toEqual([
        [1, 600],
        [2, 60],
        [3, 3600],
      ]);
    }));

  it("折返し（未判定が上限未満）の直後に別の所有者が来ても、貸出し中の明細は渡らない", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      expect(await claim(10, OWNER_A)).toEqual([1, 2, 3]); // 上限未満 → 位置は先頭に戻る
      expect(await cursor()).toBeNull();
      expect(await claim(10, OWNER_B)).toEqual([]); // 記録前の 1〜3 を二重に受け取らない
      expect(await claim(10, OWNER_A)).toEqual([]); // 同じ所有者でも再び渡さない（返却か期限まで）
      expect(await leases()).toEqual([1, 2, 3].map((n) => ({ n, owner: OWNER_A })));
    }));

  it("部分バッチ: 一部だけ貸出し中なら、別の所有者は貸出し中を除いた残りだけを (txn_date, id) 順に受け取る", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3, 4, 5]) await addTxn(imp, n, "2026-10-01");
      expect(await claim(2, OWNER_A)).toEqual([1, 2]); // 位置は 2
      await client.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null"); // 折返し後の状態
      expect(await claim(10, OWNER_B)).toEqual([3, 4, 5]);
      expect(await leases()).toEqual([
        { n: 1, owner: OWNER_A },
        { n: 2, owner: OWNER_A },
        { n: 3, owner: OWNER_B },
        { n: 4, owner: OWNER_B },
        { n: 5, owner: OWNER_B },
      ]);
    }));

  it("期限が切れた貸出しだけが別の所有者に渡り、貸出しは新しい所有者のものになる（期限の境界）", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2]) await addTxn(imp, n);
      expect(await claim(10, OWNER_A)).toEqual([1, 2]);
      await client.query("update public.proposal_leases set lease_expires_at = now() + interval '1 second' where bank_transaction_id = $1", [uuid(1)]);
      await client.query("update public.proposal_leases set lease_expires_at = now() where bank_transaction_id = $1", [uuid(2)]); // ちょうど期限
      expect(await claim(10, OWNER_B)).toEqual([2]);
      expect(await leases()).toEqual([
        { n: 1, owner: OWNER_A },
        { n: 2, owner: OWNER_B },
      ]);
    }));

  it("記録済・保留などで未判定でなくなった明細の貸出しは、次の claim で掃除される", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2]) await addTxn(imp, n);
      expect(await claim(10, OWNER_A)).toEqual([1, 2]);
      await setStatus(1, "on_hold");
      expect(await claim(10, OWNER_B)).toEqual([]);
      expect(await leases()).toEqual([{ n: 2, owner: OWNER_A }]);
    }));

  it("同じ日付が並ぶ明細は、期限切れ後の再取得でも id 順を保つ", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [4, 2, 3, 1]) await addTxn(imp, n, "2026-10-05");
      expect(await claim(10, OWNER_A)).toEqual([1, 2, 3, 4]);
      await expireAll();
      expect(await claim(3, OWNER_B)).toEqual([1, 2, 3]);
      expect(await claim(3, OWNER_B)).toEqual([4]);
    }));
});

describe("renew_proposal_claim（AI を呼ぶ直前の所有の確認）", () => {
  it("所有者なら true で期限を延ばす。別の所有者・貸出しなし・未判定でない明細は false", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      expect(await claim(2, OWNER_A)).toEqual([1, 2]);
      await client.query("update public.proposal_leases set lease_expires_at = now() + interval '90 seconds'");
      expect(await renew(OWNER_A, 1)).toBe(true);
      const secs = await client.query<{ secs: number }>(
        "select extract(epoch from lease_expires_at - now())::int as secs from public.proposal_leases where bank_transaction_id = $1",
        [uuid(1)],
      );
      expect(secs.rows[0]!.secs).toBe(600);
      expect(await renew(OWNER_B, 1)).toBe(false); // 別の所有者
      expect(await renew(null, 1)).toBe(false);
      expect(await renew(OWNER_A, 3)).toBe(false); // 貸出しなし
      await setStatus(2, "on_hold");
      expect(await renew(OWNER_A, 2)).toBe(false); // 未判定でない
    }));

  it("期限が切れていても奪われていなければ延長でき、奪われた後は false（古い所有者は AI を呼ばない）", () =>
    inTx(async () => {
      const imp = await isolate();
      await addTxn(imp, 1);
      expect(await claim(10, OWNER_A)).toEqual([1]);
      await expireAll();
      expect(await renew(OWNER_A, 1)).toBe(true); // 奪われていない
      await expireAll();
      expect(await claim(10, OWNER_B)).toEqual([1]); // 奪われた
      expect(await renew(OWNER_A, 1)).toBe(false);
      expect(await renew(OWNER_B, 1)).toBe(true);
    }));
});

describe("release_proposal_claims（失敗・中止・未着手の返却）", () => {
  it("自分の貸出しだけを返し、件数を返す。他の所有者の貸出し・null・空には触れない。明細は new のまま", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2, 3]) await addTxn(imp, n);
      expect(await claim(2, OWNER_A)).toEqual([1, 2]);
      expect(await claim(1, OWNER_B)).toEqual([3]);
      expect(await release(OWNER_B, [1, 2, 3])).toBe(1); // B が返せるのは自分の 3 だけ
      expect(await release(OWNER_A, null)).toBe(0);
      expect(await release(OWNER_A, [])).toBe(0);
      expect(await release(null, [1])).toBe(0);
      expect(await leases()).toEqual([
        { n: 1, owner: OWNER_A },
        { n: 2, owner: OWNER_A },
      ]);
      expect(await release(OWNER_A, [1])).toBe(1);
      expect(await release(OWNER_A, [1])).toBe(0); // 二重の返却は何もしない
      expect([await statusOf(1), await statusOf(2), await statusOf(3)]).toEqual(["new", "new", "new"]);
    }));

  it("返却後は、巡回が戻ったときに同じ明細が再び渡される（失敗の再試行）", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2]) await addTxn(imp, n);
      expect(await claim(10, OWNER_A)).toEqual([1, 2]);
      expect(await claim(10, OWNER_B)).toEqual([]);
      expect(await release(OWNER_A, [1, 2])).toBe(2);
      expect(await claim(10, OWNER_B)).toEqual([1, 2]);
    }));
});

describe("record_claimed_ai_decision（所有者だけが記録できる）", () => {
  it("所有者の記録は、判断ログを 1 行追加して明細を proposed にし、貸出しを終える", () =>
    inTx(async () => {
      const imp = await isolate();
      await addTxn(imp, 1);
      expect(await claim(10, OWNER_A)).toEqual([1]);
      const before = await decisionCount();
      const id = await record(OWNER_A, 1);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await statusOf(1)).toBe("proposed");
      expect(await decisionCount()).toBe(before + 1);
      expect(await leases()).toEqual([]);
      // 記録後の二重の記録は、貸出しが無いので拒否される（判断は 1 行のまま）
      expect(await recordFails(OWNER_A, 1)).toMatch(/is not held by this owner/);
      expect(await decisionCount()).toBe(before + 1);
    }));

  it("別の所有者・貸出しのない明細・null の所有者の記録は拒否され、状態も判断ログも変わらない", () =>
    inTx(async () => {
      const imp = await isolate();
      for (const n of [1, 2]) await addTxn(imp, n);
      expect(await claim(1, OWNER_A)).toEqual([1]);
      const before = await decisionCount();
      expect(await recordFails(OWNER_B, 1)).toMatch(/is not held by this owner/);
      expect(await recordFails(null, 1)).toMatch(/is not held by this owner/);
      expect(await recordFails(OWNER_A, 2)).toMatch(/is not held by this owner/); // 借りていない明細
      expect([await statusOf(1), await statusOf(2)]).toEqual(["new", "new"]);
      expect(await decisionCount()).toBe(before);
      expect(await leases()).toEqual([{ n: 1, owner: OWNER_A }]);
    }));

  it("期限が切れて別の所有者に奪われた古い所有者の記録は拒否され、奪った側は記録できる（記録は 1 回だけ）", () =>
    inTx(async () => {
      const imp = await isolate();
      await addTxn(imp, 1);
      expect(await claim(10, OWNER_A)).toEqual([1]);
      await expireAll();
      expect(await claim(10, OWNER_B)).toEqual([1]);
      const before = await decisionCount();
      expect(await recordFails(OWNER_A, 1)).toMatch(/is not held by this owner/);
      expect(await decisionCount()).toBe(before);
      await record(OWNER_B, 1);
      expect(await decisionCount()).toBe(before + 1);
      expect(await statusOf(1)).toBe("proposed");
    }));

  it("期限が切れていても奪われていなければ、元の所有者は記録できる", () =>
    inTx(async () => {
      const imp = await isolate();
      await addTxn(imp, 1);
      expect(await claim(10, OWNER_A)).toEqual([1]);
      await expireAll();
      await record(OWNER_A, 1);
      expect(await statusOf(1)).toBe("proposed");
    }));

  it("所有者でも、保留（on_hold）にされた明細には記録できず、保留は解除されない（record_ai_decision の確認を維持）", () =>
    inTx(async () => {
      const imp = await isolate();
      await addTxn(imp, 1);
      expect(await claim(10, OWNER_A)).toEqual([1]);
      await setStatus(1, "on_hold");
      const before = await decisionCount();
      expect(await recordFails(OWNER_A, 1)).toMatch(/is not waiting for a proposal/);
      expect(await statusOf(1)).toBe("on_hold");
      expect(await decisionCount()).toBe(before);
    }));

  it("別の顧客の ID で記録しようとしても拒否される（顧客をまたがない）", () =>
    inTx(async () => {
      const imp = await isolate();
      await addTxn(imp, 1);
      expect(await claim(10, OWNER_A)).toEqual([1]);
      const before = await decisionCount();
      expect(await recordFails(OWNER_A, 1, CUSTOMER_B)).toMatch(/is not waiting for a proposal/);
      expect(await statusOf(1)).toBe("new");
      expect(await decisionCount()).toBe(before);
    }));
});

describe("claim_pending_proposal_batch: 同時実行", () => {
  it("2つ目のセッションは、先のセッションの確定まで位置の行ロックで待つ", async () => {
    const a = await connect("claim-wait-a");
    const b = await connect("claim-wait-b");
    const observer = await connect("claim-wait-observer");
    let bDone: Promise<unknown> | undefined;
    try {
      await a.query("begin");
      await a.query("set local role service_role");
      await a.query("select id from public.claim_pending_proposal_batch(1, $1, 600)", [OWNER_A]); // 位置の行をロックしたまま確定しない

      await b.query("begin");
      await b.query("set local role service_role");
      await b.query("set local statement_timeout = '20s'");
      const bPid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const aPid = (await a.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;

      let bSettled = false;
      const pendingB = b.query("select id from public.claim_pending_proposal_batch(1, $1, 600)", [OWNER_B]).finally(() => {
        bSettled = true;
      });
      pendingB.catch(noop); // アサーションが先に失敗しても、未処理の拒否にしない（結果は下の await で確かめる）
      bDone = pendingB;

      // sleep ではなく、b が a に待たされている状態を観測する
      let blockedByA = false;
      for (let i = 0; i < 100 && !blockedByA; i++) {
        const res = await observer.query<{ blockers: number[] }>("select pg_blocking_pids($1) as blockers", [bPid]);
        blockedByA = res.rows[0]!.blockers.includes(aPid);
        if (!blockedByA) await delay(100);
      }
      expect(blockedByA).toBe(true);
      expect(bSettled).toBe(false);

      await a.query("rollback"); // 先の実行が終わると、後の実行が進む（貸出しも位置も a の分は残らない）
      await bDone;
      expect(bSettled).toBe(true);
    } finally {
      // a を先に終えて b の待ちを解き、b の問合せが決着してから b を終える
      await a.query("rollback").catch(noop);
      await bDone?.catch(noop);
      await b.query("rollback").catch(noop);
      await Promise.all([a.end().catch(noop), b.end().catch(noop), observer.end().catch(noop)]);
    }
  }, 40_000);
});

/**
 * 実際に確定（commit）する 2 つの接続での貸出し。ロールバックだけのテストでは見えない「確定済みの貸出し・位置を、
 * 別の接続が読む」振る舞い（部分バッチ・折返し・期限切れの引取り）を確かめる。
 * 使い捨て DB 専用の後始末つき: 作った明細・取込・貸出しを消し、退避した未判定を new に戻し、位置を先頭に戻す。
 * 判断ログ（追記専用で消せない）は作らない: 記録の成功側は、確定せずロールバックする接続で確かめる。
 */
describe("claim_pending_proposal_batch: 2 つの接続で確定する貸出し", () => {
  let a: Client;
  let b: Client;
  let importId: string;
  let shelved: string[] = [];
  const created: string[] = [];

  /** 後始末の前に、a・b の開いたトランザクションを必ず終える（開いたままだと、位置の行ロックで後始末が待たされる） */
  async function settleConnections(): Promise<void> {
    await a.query("rollback").catch(noop);
    await b.query("rollback").catch(noop);
  }

  /** 失敗しても握りつぶさない（次のテストに汚れた状態を持ち越さないため）。先に a・b を終える */
  async function cleanup(): Promise<void> {
    await settleConnections();
    await client.query("reset role");
    await client.query("delete from public.proposal_leases");
    if (created.length > 0) await client.query("delete from public.bank_transactions where id = any ($1::uuid[])", [created]);
    if (importId) await client.query("delete from public.statement_imports where id = $1", [importId]);
    if (shelved.length > 0) await client.query("update public.bank_transactions set status = 'new' where id = any ($1::uuid[])", [shelved]);
    await client.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null");
    created.length = 0;
    shelved = [];
  }

  /** 確定済みのデータで始める。既存の未判定は退避し、n 件（1..n、同日）の明細を作る */
  async function setup(n: number): Promise<void> {
    shelved = (await client.query<{ id: string }>("select id from public.bank_transactions where status = 'new'")).rows.map((r) => r.id);
    await client.query("update public.bank_transactions set status = 'on_hold' where id = any ($1::uuid[])", [shelved]);
    await client.query("update public.proposal_scan_cursor set last_txn_date = null, last_id = null");
    await client.query("delete from public.proposal_leases");
    importId = (
      await client.query<{ id: string }>(
        `insert into public.statement_imports (customer_id, wallet_id, source, row_count, inserted_count)
         values ($1, $2, 'csv', $3, $3) returning id`,
        [CUSTOMER_A, WALLET_A, n],
      )
    ).rows[0]!.id;
    for (let i = 1; i <= n; i++) {
      created.push(uuid(i));
      await client.query(
        `insert into public.bank_transactions (id, customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
         values ($1, $2, $3, $4, '2026-10-01', 100, 'expense', 'committed claim test', $5)`,
        [uuid(i), CUSTOMER_A, WALLET_A, importId, `committed-claim-${i}`],
      );
    }
  }

  /** conn で service_role として 1 回のトランザクションを実行して確定する */
  async function committed<T>(conn: Client, fn: () => Promise<T>): Promise<T> {
    await conn.query("begin");
    try {
      await conn.query("set local role service_role");
      const out = await fn();
      await conn.query("commit");
      return out;
    } catch (error) {
      await conn.query("rollback");
      throw error;
    }
  }
  const claimOn = (conn: Client, limit: number, owner: string) =>
    committed(conn, async () =>
      (await conn.query<{ id: string }>("select id from public.claim_pending_proposal_batch($1, $2, 600)", [limit, owner])).rows.map((r) => num(r.id)),
    );
  const renewOn = (conn: Client, owner: string, n: number) =>
    committed(conn, async () => (await conn.query<{ ok: boolean }>("select public.renew_proposal_claim($1, $2, 600) as ok", [owner, uuid(n)])).rows[0]!.ok);
  const releaseOn = (conn: Client, owner: string, ns: number[]) =>
    committed(conn, async () => (await conn.query<{ n: number }>("select public.release_proposal_claims($1, $2::uuid[]) as n", [owner, ns.map(uuid)])).rows[0]!.n);

  beforeAll(async () => {
    a = await connect("claim-commit-a");
    try {
      b = await connect("claim-commit-b");
    } catch (error) {
      await a.end().catch(noop);
      throw error;
    }
  });
  afterAll(async () => {
    // 接続は必ず閉じる。後始末の失敗は握りつぶさず、閉じたあとに伝える（DB 自体は外側の afterAll が削除する）
    try {
      await cleanup();
    } finally {
      await Promise.all([a.end().catch(noop), b.end().catch(noop)]);
    }
  });

  it("部分バッチと折返し: 別の接続は、確定済みの貸出しを除いた残りだけを受け取り、位置は後戻りしない", async () => {
    try {
      await setup(5);
      expect(await claimOn(a, 2, OWNER_A)).toEqual([1, 2]); // 確定。位置は 2
      expect(await cursor()).toBe(2);
      expect(await claimOn(b, 1, OWNER_B)).toEqual([3]); // a の確定済みの位置から続く（重ならない）
      expect(await cursor()).toBe(3);
      expect(await claimOn(a, 10, OWNER_A)).toEqual([4, 5]); // 上限未満で末尾に届き、位置は先頭へ
      expect(await cursor()).toBeNull();
      // 折返し直後でも、確定済みの貸出し中（1〜5）は誰にも渡らない
      expect(await claimOn(b, 10, OWNER_B)).toEqual([]);
      // 返却（確定）すると、折返した位置の先頭から再び渡る。他人の分は返せない
      expect(await releaseOn(b, OWNER_B, [1, 2])).toBe(0);
      expect(await releaseOn(a, OWNER_A, [1, 2])).toBe(2);
      expect(await claimOn(b, 10, OWNER_B)).toEqual([1, 2]);
      expect(await leases()).toEqual([
        { n: 1, owner: OWNER_B },
        { n: 2, owner: OWNER_B },
        { n: 3, owner: OWNER_B },
        { n: 4, owner: OWNER_A },
        { n: 5, owner: OWNER_A },
      ]);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("期限切れの引取り: 確定済みの貸出しを別の接続が奪うと、古い所有者は確認も記録もできず、奪った側は記録できる", async () => {
    try {
      await setup(1);
      expect(await claimOn(a, 10, OWNER_A)).toEqual([1]);
      expect(await claimOn(b, 10, OWNER_B)).toEqual([]); // 期限内は奪えない
      await client.query("update public.proposal_leases set lease_expires_at = now() - interval '1 second'"); // 確定
      expect(await claimOn(b, 10, OWNER_B)).toEqual([1]); // 引取り（確定）

      // a から見ても、奪われたことが確定済みの状態として見える
      expect(await renewOn(a, OWNER_A, 1)).toBe(false);
      await a.query("begin");
      await a.query("set local role service_role");
      expect(await expectQueryError(a, "select public.record_claimed_ai_decision($1, $2::jsonb)", [OWNER_A, decision(1)])).toMatch(/is not held by this owner/);
      await a.query("rollback");
      expect(await renewOn(b, OWNER_B, 1)).toBe(true);

      // 奪った側の記録は成功するが、判断ログは消せないので確定せずロールバックする（明細は new のまま残る）
      await b.query("begin");
      await b.query("set local role service_role");
      const recorded = await b.query<{ id: string }>("select public.record_claimed_ai_decision($1, $2::jsonb) as id", [OWNER_B, decision(1)]);
      expect(recorded.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      await b.query("rollback");
      expect(await statusOf(1)).toBe("new");
      expect(await leases()).toEqual([{ n: 1, owner: OWNER_B }]);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it("確定を待つ 2 つ目の接続は、先の接続が commit すると、その貸出しと位置を読んで重ならない明細を受け取る", async () => {
    const observer = await connect("claim-commit-observer");
    let bClaim: Promise<unknown> | undefined;
    try {
      await setup(3);
      await a.query("begin");
      await a.query("set local role service_role");
      const aPid = (await a.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      expect((await a.query<{ id: string }>("select id from public.claim_pending_proposal_batch(1, $1, 600)", [OWNER_A])).rows.map((r) => num(r.id))).toEqual([1]);

      await b.query("begin");
      await b.query("set local role service_role");
      await b.query("set local statement_timeout = '20s'");
      const bPid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
      const pendingClaim = b.query<{ id: string }>("select id from public.claim_pending_proposal_batch(1, $1, 600)", [OWNER_B]);
      pendingClaim.catch(noop); // アサーションが先に失敗しても、未処理の拒否にしない（結果は下の await で確かめる）
      bClaim = pendingClaim;

      let blockedByA = false;
      for (let i = 0; i < 100 && !blockedByA; i++) {
        const res = await observer.query<{ blockers: number[] }>("select pg_blocking_pids($1) as blockers", [bPid]);
        blockedByA = res.rows[0]!.blockers.includes(aPid);
        if (!blockedByA) await delay(100);
      }
      expect(blockedByA).toBe(true);

      await a.query("commit"); // a の貸出しと位置が確定する
      expect((await pendingClaim).rows.map((r) => num(r.id))).toEqual([2]); // 同じ 1 を二重に受け取らず、位置の続きから
      await b.query("commit");
      expect(await cursor()).toBe(2);
      expect(await leases()).toEqual([
        { n: 1, owner: OWNER_A },
        { n: 2, owner: OWNER_B },
      ]);
    } finally {
      // a を先に終えて b の待ちを解き、b の問合せが決着してから、後始末（cleanup が a・b を終えてから行う）
      await a.query("rollback").catch(noop);
      await bClaim?.catch(noop);
      try {
        await cleanup();
      } finally {
        await observer.end().catch(noop);
      }
    }
  }, 40_000);
});
