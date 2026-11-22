import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, connect, CUSTOMER_A, CUSTOMER_B, STAFF_ID } from "./helpers";

/**
 * create_customer_note（20261023000400）の実 Postgres 検証。架空データ（seed と各テスト内の合成行）だけを使い、
 * 各テストは asActor のトランザクションで最後にロールバックする（テスト用のトリガー・関数・行も残らない）。
 * seed: サンプル商事（CUSTOMER_A）に有効なメモ SEED_NOTE（版1）が1つある。担当者は A だけを担当する。
 */

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

const NOTE_1 = "70000000-0000-4000-8000-000000000001";
const NOTE_2 = "70000000-0000-4000-8000-000000000002";
const SEED_NOTE = "31000000-0000-4000-8000-000000000001";
const NOT_STAFF = "00000000-0000-4000-8000-0000000000ff";
const SQL = "select public.create_customer_note($1, $2, $3, $4) as id";

type Args = [customer: string, note: string, title: string, body: string];
const args = (o: Partial<Record<"customer" | "note" | "title" | "body", string>> = {}): Args => [
  o.customer ?? CUSTOMER_A,
  o.note ?? NOTE_1,
  o.title ?? "合成タイトル",
  o.body ?? "合成本文",
];

const asStaff = <T>(fn: () => Promise<T>) => asActor(client, { role: "authenticated", userId: STAFF_ID }, fn);

/** 失敗を期待する呼出し。セーブポイントで包み、エラーコードとメッセージを返す */
async function expectFailure(sql: string, params: unknown[]): Promise<{ code: string | undefined; message: string }> {
  await client.query("savepoint expect_failure");
  try {
    await client.query(sql, params);
  } catch (error) {
    await client.query("rollback to savepoint expect_failure");
    const e = error as { code?: string; message?: string };
    return { code: e.code, message: e.message ?? "" };
  }
  await client.query("release savepoint expect_failure");
  throw new Error(`expected failure: ${sql}`);
}

/** テーブルを直接作る権限のあるロールで合成データを足し、担当者のロールに戻す（トランザクション内なのでロールバックされる） */
async function asSuperuser<T>(fn: () => Promise<T>): Promise<T> {
  await client.query("reset role");
  try {
    return await fn();
  } finally {
    await client.query("set local role authenticated");
  }
}

const counts = async (note: string) => {
  const r = await client.query<{ parents: string; versions: string }>(
    `select (select count(*) from public.customer_notes where id = $1) as parents,
            (select count(*) from public.customer_note_versions where note_id = $1) as versions`,
    [note],
  );
  return { parents: Number(r.rows[0]!.parents), versions: Number(r.rows[0]!.versions) };
};

describe("create_customer_note: 成功", () => {
  it("割り当て済みの担当者が、親と版1（無効・作成者=本人）を1回で作り、タイトル・本文は入力のまま入る", async () => {
    await asStaff(async () => {
      const title = " 題名 ";
      const body = "\r\n一行目\n  二行目 \n";
      const res = await client.query<{ id: string }>(SQL, args({ title, body }));
      expect(res.rows[0]!.id).toBe(NOTE_1);
      expect(await counts(NOTE_1)).toEqual({ parents: 1, versions: 1 });

      const parent = await client.query("select customer_id, created_by from public.customer_notes where id = $1", [NOTE_1]);
      expect(parent.rows).toEqual([{ customer_id: CUSTOMER_A, created_by: STAFF_ID }]);

      const v = await client.query("select * from public.customer_note_versions where note_id = $1", [NOTE_1]);
      expect(v.rows).toHaveLength(1);
      expect(v.rows[0]).toMatchObject({ version: 1, customer_id: CUSTOMER_A, status: "inactive", title, body, created_by: STAFF_ID });

      // 現在の版として一覧に出て、状態は無効
      const cur = await client.query("select version, status from public.current_customer_notes where note_id = $1", [NOTE_1]);
      expect(cur.rows).toEqual([{ version: 1, status: "inactive" }]);
    });
  });

  it("空白以外を含めば、JS の trim が削る文字に挟まれていても、文字 v だけでも保存できる", async () => {
    await asStaff(async () => {
      await client.query(SQL, args({ title: "\u000bx\u000b", body: "v" }));
      const v = await client.query("select title, body from public.customer_note_versions where note_id = $1", [NOTE_1]);
      expect(v.rows).toEqual([{ title: "\u000bx\u000b", body: "v" }]);
    });
  });

  it("既存のメモがあっても、別のIDなら別のメモとして作れ、既存の親・版は変わらない", async () => {
    await asStaff(async () => {
      const before = await client.query("select * from public.customer_note_versions where note_id = $1 order by version", [SEED_NOTE]);
      await client.query(SQL, args());
      await client.query(SQL, args({ note: NOTE_2 }));
      expect(await counts(NOTE_1)).toEqual({ parents: 1, versions: 1 });
      expect(await counts(NOTE_2)).toEqual({ parents: 1, versions: 1 });
      const after = await client.query("select * from public.customer_note_versions where note_id = $1 order by version", [SEED_NOTE]);
      expect(after.rows).toEqual(before.rows);
    });
  });
});

describe("create_customer_note: 権限と引数", () => {
  it("担当外の顧客・担当者でないログイン・匿名は拒否し、何も作らない", async () => {
    await asStaff(async () => {
      const r = await expectFailure(SQL, args({ customer: CUSTOMER_B }));
      expect(r.code).toBe("42501");
      expect(await counts(NOTE_1)).toEqual({ parents: 0, versions: 0 });
    });
    await asActor(client, { role: "authenticated", userId: NOT_STAFF }, async () => {
      const r = await expectFailure(SQL, args());
      expect(r.code).toBe("42501");
      expect(await counts(NOTE_1)).toEqual({ parents: 0, versions: 0 });
    });
    await asActor(client, { role: "anon" }, async () => {
      const r = await expectFailure(SQL, args());
      expect(r.code).toBe("42501");
      expect(r.message).toMatch(/permission denied/);
    });
  });

  it("関数の実行権限は authenticated だけ。SECURITY INVOKER で、引数は4つ（状態・作成者・版は渡せない）", async () => {
    const f = await client.query<{ nargs: number; anon: boolean; auth: boolean; svc: boolean; pub: boolean; definer: boolean; config: string[] }>(
      `select p.pronargs as nargs,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as pub,
              p.prosecdef as definer,
              p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_customer_note'`,
    );
    expect(f.rows).toEqual([{ nargs: 4, anon: false, auth: true, svc: false, pub: false, definer: false, config: ["search_path=\"\""] }]);
    await asStaff(async () => {
      for (const sql of [
        "select public.create_customer_note($1, $2, $3, $4, 'active')",
        "select public.create_customer_note($1, $2, $3, $4, 1)",
      ]) {
        expect((await expectFailure(sql, args())).code, sql).toBe("42883");
      }
    });
  });

  it("null は 22004、空・空白だけのタイトル／本文は 22023 で拒否し、何も作らない", async () => {
    await asStaff(async () => {
      for (let i = 0; i < 4; i++) {
        const params: (string | null)[] = args();
        params[i] = null;
        const r = await expectFailure(SQL, params);
        expect(r.code, `null at ${i}`).toBe("22004");
      }
      for (const blank of ["", " ", "　", "\n\t\r", "\u000b", " \u000b\t", " ﻿  ", " 　"]) {
        for (const field of ["title", "body"] as const) {
          const r = await expectFailure(SQL, args({ [field]: blank }));
          expect(r.code, `${field} ${JSON.stringify(blank)}`).toBe("22023");
          expect(r.message).toMatch(/blank/);
        }
      }
      expect(await counts(NOTE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });

  it("NUL 文字は PostgreSQL の text に入らず（ドライバーまたはサーバーが拒否）、何も作らない", async () => {
    await asStaff(async () => {
      // 拒否の主体（クライアントのドライバーか、サーバーの 22021）には依存せず、失敗して何も作られないことだけを見る
      await expectFailure(SQL, args({ body: "a\u0000b" }));
      expect(await counts(NOTE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });
});

describe("create_customer_note: 重複と原子性", () => {
  it("同じ依頼IDの2回目は 23505 で拒否し、親・版の件数も内容も変わらない", async () => {
    await asStaff(async () => {
      await client.query(SQL, args({ title: "最初", body: "最初の本文" }));
      const before = await client.query("select * from public.customer_note_versions where note_id = $1", [NOTE_1]);
      const r = await expectFailure(SQL, args({ title: "二度目", body: "二度目の本文" }));
      expect(r.code).toBe("23505");
      expect(await counts(NOTE_1)).toEqual({ parents: 1, versions: 1 });
      const after = await client.query("select * from public.customer_note_versions where note_id = $1", [NOTE_1]);
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("既存メモのIDを依頼IDにしても上書きせず、既存の親・版は変わらない", async () => {
    await asStaff(async () => {
      const before = await counts(SEED_NOTE);
      const parentBefore = await client.query("select * from public.customer_notes where id = $1", [SEED_NOTE]);
      const versionsBefore = await client.query("select * from public.customer_note_versions where note_id = $1 order by version", [SEED_NOTE]);
      expect((await expectFailure(SQL, args({ note: SEED_NOTE }))).code).toBe("23505");
      expect(await counts(SEED_NOTE)).toEqual(before);
      expect((await client.query("select * from public.customer_notes where id = $1", [SEED_NOTE])).rows).toEqual(parentBefore.rows);
      const versionsAfter = await client.query("select * from public.customer_note_versions where note_id = $1 order by version", [SEED_NOTE]);
      expect(versionsAfter.rows).toEqual(versionsBefore.rows);
    });
  });

  it("版1の INSERT が失敗したら、親の INSERT も巻き戻る（テスト専用のトリガーで強制）", async () => {
    await asStaff(async () => {
      await asSuperuser(async () => {
        await client.query(`
          create function public.test_force_note_version_failure() returns trigger language plpgsql as $$
          begin
            if new.note_id = '${NOTE_1}' then raise exception 'forced failure for test' using errcode = 'P0001'; end if;
            return new;
          end $$`);
        await client.query(`
          create trigger test_force_note_version_failure before insert on public.customer_note_versions
          for each row execute function public.test_force_note_version_failure()`);
      });
      const r = await expectFailure(SQL, args());
      expect(r.message).toMatch(/forced failure for test/);
      expect(await counts(NOTE_1)).toEqual({ parents: 0, versions: 0 });
      // 失敗のあとも、別のIDなら通常どおり作れる（トリガーは対象IDにだけ働く）
      await client.query(SQL, args({ note: NOTE_2 }));
      expect(await counts(NOTE_2)).toEqual({ parents: 1, versions: 1 });
    });
    // ロールバック後にテスト用の関数が残っていない
    const left = await client.query("select 1 from pg_proc where proname = 'test_force_note_version_failure'");
    expect(left.rows).toHaveLength(0);
  });
});
