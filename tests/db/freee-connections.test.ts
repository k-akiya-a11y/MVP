import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { ADMIN_ID, CUSTOMER_A, CUSTOMER_B, STAFF_ID, asActor, connect, expectQueryError } from "./helpers";

// supabase/migrations/20261125000100_freee_connections.sql。トークンは架空の文字列
const OWNER_1 = "00000000-0000-4000-8000-0000000000a1";
const OWNER_2 = "00000000-0000-4000-8000-0000000000a2";

let client: Client;
beforeAll(async () => {
  client = await connect();
});
afterAll(async () => {
  await client.end();
});

/** service_role で接続を保存する（顧客Aの事業所は seed で 900001） */
async function saveConnection(companyId = 900001, connectedBy = ADMIN_ID) {
  await client.query(
    "select public.save_freee_connection($1, $2, 'fake-access-1', 'fake-refresh-1', now() + interval '6 hours', $3)",
    [CUSTOMER_A, companyId, connectedBy],
  );
}

describe("freee の接続: トークンは Vault に入り、service_role の関数だけで扱う", () => {
  it("保存すると、表には Vault の ID だけが入り、関数でだけトークンを読める", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      await saveConnection();
      const row = await client.query("select * from public.freee_connections where customer_id = $1", [CUSTOMER_A]);
      expect(JSON.stringify(row.rows[0])).not.toContain("fake-access-1");
      const t = await client.query("select * from public.get_freee_access_token($1)", [CUSTOMER_A]);
      expect(t.rows[0]).toMatchObject({ freee_company_id: "900001", status: "active", access_token: "fake-access-1" });
      expect(await expectQueryError(client, "select * from vault.secrets")).toMatch(/permission denied/);
    });
  });

  it("事業所が顧客と違う・接続する人が管理者でないときは保存しない", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      expect(
        await expectQueryError(
          client,
          "select public.save_freee_connection($1, 999999, 'a', 'r', now(), $2)",
          [CUSTOMER_A, ADMIN_ID],
        ),
      ).toContain("事業所と一致しません");
      expect(
        await expectQueryError(client, "select public.save_freee_connection($1, 900001, 'a', 'r', now(), $2)", [CUSTOMER_A, STAFF_ID]),
      ).toContain("管理者だけ");
      const n = await client.query("select count(*)::int as n from public.freee_connections");
      expect(n.rows[0].n).toBe(0);
    });
  });

  it("service_role でも接続の表に直接は書けない（関数だけを通す）", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      expect(
        await expectQueryError(
          client,
          `insert into public.freee_connections (customer_id, freee_company_id, status, access_token_secret_id, refresh_token_secret_id,
             access_token_expires_at, connected_by) values ($1, 900001, 'active', gen_random_uuid(), gen_random_uuid(), now(), $2)`,
          [CUSTOMER_A, ADMIN_ID],
        ),
      ).toMatch(/permission denied/);
    });
  });

  it("担当者・管理者は秘密でない列だけを、担当顧客の分だけ読める。関数は実行できない", async () => {
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await saveConnection();
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
      await client.query("set local role authenticated");
      const ok = await client.query("select status, freee_company_id from public.freee_connections");
      expect(ok.rows).toEqual([{ status: "active", freee_company_id: "900001" }]);
      expect(await expectQueryError(client, "select access_token_secret_id from public.freee_connections")).toMatch(/permission denied/);
      expect(await expectQueryError(client, "select refresh_lock_owner from public.freee_connections")).toMatch(/permission denied/);
      for (const sql of [
        "select * from public.get_freee_access_token($1)",
        "select * from public.begin_freee_token_refresh($1, gen_random_uuid(), 60)",
        "select public.fail_freee_token_refresh($1, gen_random_uuid(), false)",
        "select public.save_freee_connection($1, 900001, 'a', 'r', now(), auth.uid())",
        "select * from public.sync_freee_masters($1, '[]'::jsonb)",
        "select public.apply_freee_past_entries($1, '[]'::jsonb, null, null, null, false)",
      ]) {
        expect(await expectQueryError(client, sql, [CUSTOMER_A])).toMatch(/permission denied/);
      }
    } finally {
      await client.query("rollback");
    }
    // 担当外の顧客の接続は見えない
    await client.query("begin");
    try {
      await client.query(
        "update public.customers set freee_company_id = 900002 where id = $1 and freee_company_id is null",
        [CUSTOMER_B],
      );
      await client.query("set local role service_role");
      await client.query("select public.save_freee_connection($1, (select freee_company_id from public.customers where id = $1), 'a', 'r', now(), $2)", [
        CUSTOMER_B,
        ADMIN_ID,
      ]);
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
      await client.query("set local role authenticated");
      const rows = await client.query("select customer_id from public.freee_connections where customer_id = $1", [CUSTOMER_B]);
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("freee のトークン更新のロック", () => {
  it("ロックを持つ処理だけがリフレッシュトークンを受け取り、保存できる。他の処理は0行", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      await saveConnection();
      const first = await client.query("select * from public.begin_freee_token_refresh($1, $2, 60)", [CUSTOMER_A, OWNER_1]);
      expect(first.rows).toEqual([{ refresh_token: "fake-refresh-1" }]);
      const second = await client.query("select * from public.begin_freee_token_refresh($1, $2, 60)", [CUSTOMER_A, OWNER_2]);
      expect(second.rows).toEqual([]);
      expect(
        await expectQueryError(
          client,
          "select public.complete_freee_token_refresh($1, $2, 'fake-access-2', 'fake-refresh-2', now() + interval '6 hours')",
          [CUSTOMER_A, OWNER_2],
        ),
      ).toContain("ロックを持っていません");
      await client.query(
        "select public.complete_freee_token_refresh($1, $2, 'fake-access-2', 'fake-refresh-2', now() + interval '6 hours')",
        [CUSTOMER_A, OWNER_1],
      );
      const t = await client.query("select access_token from public.get_freee_access_token($1)", [CUSTOMER_A]);
      expect(t.rows[0].access_token).toBe("fake-access-2");
      const lock = await client.query("select refresh_lock_owner from public.freee_connections where customer_id = $1", [CUSTOMER_A]);
      expect(lock.rows[0].refresh_lock_owner).toBeNull();
    });
  });

  it("期限切れのロックは次の処理が引き継げる。古い所有者は保存できない", async () => {
    await client.query("begin");
    try {
      await client.query("set local role service_role");
      await saveConnection();
      await client.query("select * from public.begin_freee_token_refresh($1, $2, 60)", [CUSTOMER_A, OWNER_1]);
      await client.query("reset role");
      await client.query("update public.freee_connections set refresh_lock_until = now() - interval '1 second' where customer_id = $1", [
        CUSTOMER_A,
      ]);
      await client.query("set local role service_role");
      const taken = await client.query("select * from public.begin_freee_token_refresh($1, $2, 60)", [CUSTOMER_A, OWNER_2]);
      expect(taken.rowCount).toBe(1);
      expect(
        await expectQueryError(client, "select public.complete_freee_token_refresh($1, $2, 'x', 'y', now())", [CUSTOMER_A, OWNER_1]),
      ).toContain("ロックを持っていません");
    } finally {
      await client.query("rollback");
    }
  });

  it("freee が更新を断ったら再認可待ちにし、以後はロックも取れない", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      await saveConnection();
      await client.query("select * from public.begin_freee_token_refresh($1, $2, 60)", [CUSTOMER_A, OWNER_1]);
      await client.query("select public.fail_freee_token_refresh($1, $2, true)", [CUSTOMER_A, OWNER_1]);
      const s = await client.query("select status, refresh_lock_owner from public.freee_connections where customer_id = $1", [CUSTOMER_A]);
      expect(s.rows[0]).toEqual({ status: "needs_reauth", refresh_lock_owner: null });
      expect(await expectQueryError(client, "select * from public.begin_freee_token_refresh($1, $2, 60)", [CUSTOMER_A, OWNER_2])).toContain(
        "再認可が必要",
      );
    });
  });
});

describe("マスタと過去仕訳の同期の書込", () => {
  it("マスタは freee の値で更新し、人が付けた attrs（fixed_asset）は残し、freee になくなった行は使用不可にする", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      await saveConnection();
      const rows = [
        { kind: "account_item", freee_id: 108, name: "工具器具備品（新）", available: true, attrs: { default_tax_code: 21 } },
        { kind: "account_item", freee_id: 9001, name: "新しい科目", available: true, attrs: {} },
      ];
      const r = await client.query("select * from public.sync_freee_masters($1, $2::jsonb)", [CUSTOMER_A, JSON.stringify(rows)]);
      expect(r.rows[0].upserted).toBe(2);
      expect(r.rows[0].made_unavailable).toBeGreaterThan(0);
      const m = await client.query(
        "select freee_id::int as id, name, attrs, available from public.freee_masters where customer_id = $1 and kind = 'account_item' and freee_id in (101, 108, 9001) order by freee_id",
        [CUSTOMER_A],
      );
      expect(m.rows).toEqual([
        { id: 101, name: "通信費", attrs: { default_tax_code: 21 }, available: false },
        { id: 108, name: "工具器具備品（新）", attrs: { default_tax_code: 21, fixed_asset: true }, available: true },
        { id: 9001, name: "新しい科目", attrs: {}, available: true },
      ]);
      const s = await client.query("select masters_synced_at is not null as ok from public.freee_sync_state where customer_id = $1", [CUSTOMER_A]);
      expect(s.rows[0].ok).toBe(true);
    });
  });

  it("接続していない顧客のマスタ・過去仕訳は書けない", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      expect(await expectQueryError(client, "select * from public.sync_freee_masters($1, '[]'::jsonb)", [CUSTOMER_B])).toContain("接続していない");
      expect(
        await expectQueryError(client, "select public.apply_freee_past_entries($1, '[]'::jsonb, null, null, null, false)", [CUSTOMER_B]),
      ).toContain("接続していない");
    });
  });

  it("過去仕訳は freee の取引ごとに上書きし、進み具合を同じトランザクションで保存する", async () => {
    await asActor(client, { role: "service_role" }, async () => {
      await saveConnection();
      const row = {
        freee_source_id: 777001,
        entry_date: "2026-10-01",
        amount: 165000,
        direction: "expense",
        bank_description: "ｶ)ｹﾝｼｮｳﾌﾄﾞｳｻﾝ",
        bank_description_source: "wallet_txn",
        partner_key: "ケンシヨウフドウサン",
        partner_id: 311,
        account_item_id: 105,
        tax_code: 21,
        item_id: null,
        section_id: 401,
        tag_ids: [501],
        description: "10月分 家賃",
      };
      const apply = (rows: unknown[], completed: boolean) =>
        client.query("select public.apply_freee_past_entries($1, $2::jsonb, '2024-12-01', '2026-11-01', '2026-11-01', $3) as n", [
          CUSTOMER_A,
          JSON.stringify(rows),
          completed,
        ]);
      expect((await apply([row], false)).rows[0].n).toBe(1);
      expect((await apply([{ ...row, description: "10月分 家賃（修正）" }], true)).rows[0].n).toBe(1);
      const p = await client.query(
        "select count(*)::int as n, max(description) as d, max(bank_description_source) as src from public.past_journal_entries where customer_id = $1 and source = 'freee_deal' and freee_source_id = 777001",
        [CUSTOMER_A],
      );
      expect(p.rows[0]).toEqual({ n: 1, d: "10月分 家賃（修正）", src: "wallet_txn" });
      const s = await client.query(
        "select past_entries_next_month::text as next, past_entries_completed_at is not null as done from public.freee_sync_state where customer_id = $1",
        [CUSTOMER_A],
      );
      expect(s.rows[0]).toEqual({ next: "2026-11-01", done: true });
    });
  });
});
