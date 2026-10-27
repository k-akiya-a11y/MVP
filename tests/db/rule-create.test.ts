import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asActor, connect, CUSTOMER_A, CUSTOMER_B, STAFF_ID } from "./helpers";

/**
 * create_rule_from_past_candidate（20261023000300）の実 Postgres 検証。架空データ（seed と各テスト内の合成行）だけを使い、
 * 各テストは asActor のトランザクションで最後にロールバックする（テスト用のトリガー・関数・行も残らない）。
 * seed: サンプル商事（CUSTOMER_A）の「サンプルツウシン」出金は科目101が3件、税区分 21 / 2 が有効。担当者は A だけを担当する。
 */

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

const RULE_1 = "60000000-0000-4000-8000-000000000001";
const RULE_2 = "60000000-0000-4000-8000-000000000002";
const SEED_RULE = "30000000-0000-4000-8000-000000000001";
const SQL = "select public.create_rule_from_past_candidate($1, $2, $3, $4, $5, $6, $7) as id";

type Args = [customer: string, rule: string, key: string, direction: string, account: number, tax: number, priority: number];
const args = (o: Partial<Record<"customer" | "rule" | "key" | "direction" | "account" | "tax" | "priority", string | number>> = {}): Args => [
  String(o.customer ?? CUSTOMER_A),
  String(o.rule ?? RULE_1),
  String(o.key ?? "サンプルツウシン"),
  String(o.direction ?? "expense"),
  Number(o.account ?? 101),
  Number(o.tax ?? 21),
  Number(o.priority ?? 50),
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

let freeeId = 90_000;
async function addEntry(key: string | null, account: number, direction = "expense", customer = CUSTOMER_A) {
  await asSuperuser(() =>
    client.query(
      `insert into public.past_journal_entries (customer_id, source, freee_source_id, entry_date, amount, direction, partner_key, account_item_id, tax_code)
       values ($1, 'freee_deal', $2, '2026-09-01', 1000, $3, $4, $5, 21)`,
      [customer, ++freeeId, direction, key, account],
    ),
  );
}

const counts = async (rule: string) => {
  const r = await client.query<{ parents: string; versions: string }>(
    `select (select count(*) from public.journal_rules where id = $1) as parents,
            (select count(*) from public.journal_rule_versions where rule_id = $1) as versions`,
    [rule],
  );
  return { parents: Number(r.rows[0]!.parents), versions: Number(r.rows[0]!.versions) };
};

describe("create_rule_from_past_candidate: 成功", () => {
  it("割り当て済みの担当者が、親と版1（提案中・past_entries・作成者=本人・他の項目は空）を1回で作る", async () => {
    await asStaff(async () => {
      const res = await client.query<{ id: string }>(SQL, args());
      expect(res.rows[0]!.id).toBe(RULE_1);
      expect(await counts(RULE_1)).toEqual({ parents: 1, versions: 1 });

      const parent = await client.query("select customer_id, created_by from public.journal_rules where id = $1", [RULE_1]);
      expect(parent.rows).toEqual([{ customer_id: CUSTOMER_A, created_by: STAFF_ID }]);

      const v = await client.query("select * from public.journal_rule_versions where rule_id = $1", [RULE_1]);
      expect(v.rows).toHaveLength(1);
      expect(v.rows[0]).toMatchObject({
        version: 1,
        customer_id: CUSTOMER_A,
        priority: 50,
        status: "proposed",
        source: "past_entries",
        created_by: STAFF_ID,
        cond_partner_key: "サンプルツウシン",
        cond_direction: "expense",
        cond_description_keyword: null,
        cond_amount_min: null,
        cond_amount_max: null,
        cond_wallet_id: null,
        account_item_id: "101",
        tax_code: 21,
        partner_id: null,
        item_id: null,
        section_id: null,
        tag_ids: [],
        description_template: null,
        valid_from: null,
        valid_to: null,
      });
    });
  });

  it("選んだ税区分 0 もマスタにあれば保存でき、優先順位 0 もそのまま入る", async () => {
    await asStaff(async () => {
      await asSuperuser(() =>
        client.query("insert into public.freee_masters (customer_id, kind, freee_id, name) values ($1, 'tax', 0, '対象外（合成）')", [CUSTOMER_A]),
      );
      await client.query(SQL, args({ tax: 0, priority: 0 }));
      const v = await client.query("select tax_code, priority from public.journal_rule_versions where rule_id = $1", [RULE_1]);
      expect(v.rows).toEqual([{ tax_code: 0, priority: 0 }]);
    });
  });

  it("件数の下限はない（1件だけの履歴でも、すべてが同じ科目なら作れる）", async () => {
    await asStaff(async () => {
      await addEntry("合成ソロ", 102);
      await client.query(SQL, args({ key: "合成ソロ", account: 102 }));
      expect(await counts(RULE_1)).toEqual({ parents: 1, versions: 1 });
    });
  });
});

describe("create_rule_from_past_candidate: 権限と引数", () => {
  it("担当外の顧客・匿名は拒否し、何も作らない", async () => {
    await asStaff(async () => {
      const r = await expectFailure(SQL, args({ customer: CUSTOMER_B }));
      expect(r.code).toBe("42501");
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
    });
    await asActor(client, { role: "anon" }, async () => {
      const r = await expectFailure(SQL, args());
      expect(r.code).toBe("42501");
      expect(r.message).toMatch(/permission denied/);
    });
  });

  it("関数の実行権限は authenticated だけ。引数は7つで、状態・作成者・作成元・版は渡せない", async () => {
    const f = await client.query<{ nargs: number; anon: boolean; auth: boolean; svc: boolean; pub: boolean; definer: boolean }>(
      `select p.pronargs as nargs,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('service_role', p.oid, 'execute') as svc,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0) as pub,
              p.prosecdef as definer
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'create_rule_from_past_candidate'`,
    );
    expect(f.rows).toEqual([{ nargs: 7, anon: false, auth: true, svc: false, pub: false, definer: false }]);
    await asStaff(async () => {
      const r = await expectFailure(
        "select public.create_rule_from_past_candidate($1, $2, $3, $4, $5, $6, $7, 'active')",
        args(),
      );
      expect(r.code).toBe("42883");
    });
  });

  it("null・空白だけのキー・不正な向き・0以下の科目は拒否する", async () => {
    await asStaff(async () => {
      for (const bad of [
        { key: "   " },
        { key: "　" },
        { direction: "both" },
        { account: 0 },
        { account: -1 },
      ]) {
        const r = await expectFailure(SQL, args(bad));
        expect(r.code, JSON.stringify(bad)).toMatch(/^22/);
      }
      for (let i = 0; i < 7; i++) {
        const params: (string | number | null)[] = args();
        params[i] = null;
        const r = await expectFailure(SQL, params);
        expect(r.code, `null at ${i}`).toBe("22004");
      }
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });
});

describe("create_rule_from_past_candidate: 空白だけのキーの判定", () => {
  it("垂直タブ・JS の trim が削る空白だけのキーは 22023 で拒否する", async () => {
    await asStaff(async () => {
      for (const key of ["\u000b", " \u000b\t", "\u00a0\ufeff\u2028\u2029", "\u2003\u3000"]) {
        const r = await expectFailure(SQL, args({ key }));
        expect(r.code, JSON.stringify(key)).toBe("22023");
        expect(r.message).toMatch(/blank/);
      }
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });

  it("文字 v（E'\\v' を v と取り違えた場合に削られる文字）を含むキーは空白扱いにならず、そのまま完全一致で保存できる", async () => {
    await asStaff(async () => {
      await addEntry("v", 102);
      await addEntry("vv ", 102);
      await client.query(SQL, args({ key: "v", account: 102 }));
      const v = await client.query("select cond_partner_key from public.journal_rule_versions where rule_id = $1", [RULE_1]);
      expect(v.rows).toEqual([{ cond_partner_key: "v" }]);
      // 前後の空白は削らず、"vv " は "vv " のまま照合される
      await client.query(SQL, args({ rule: RULE_2, key: "vv ", account: 102 }));
      const w = await client.query("select cond_partner_key from public.journal_rule_versions where rule_id = $1", [RULE_2]);
      expect(w.rows).toEqual([{ cond_partner_key: "vv " }]);
    });
  });

  it("空白で挟まれた非空白（\"\\v\" + \"x\"）は空白扱いにならず、過去仕訳がなければ P0001", async () => {
    await asStaff(async () => {
      const r = await expectFailure(SQL, args({ key: "\u000bx\u000b" }));
      expect(r.code).toBe("P0001");
    });
  });
});

describe("create_rule_from_past_candidate: 過去仕訳の検証", () => {
  it("該当する過去仕訳がない（キーの違い・向きの違い・前後の空白・他の顧客）は拒否する", async () => {
    await asStaff(async () => {
      await addEntry("合成キー", 101, "expense", CUSTOMER_B);
      for (const bad of [{ key: "サンプルツウシン " }, { key: "存在しない" }, { direction: "income" }, { key: "合成キー" }]) {
        const r = await expectFailure(SQL, args(bad));
        expect(r.code, JSON.stringify(bad)).toBe("P0001");
      }
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });

  it("同じキー・向きの過去仕訳に別の科目が1件でもあれば拒否する（指定の科目が最多でも）", async () => {
    await asStaff(async () => {
      await addEntry("サンプルツウシン", 102);
      const r = await expectFailure(SQL, args());
      expect(r.code).toBe("P0001");
      expect(r.message).toMatch(/other accounts/);
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });

  it("向きが違う過去仕訳の科目は影響しない（同じキーでも別のグループ）", async () => {
    await asStaff(async () => {
      await addEntry("サンプルツウシン", 102, "income");
      await client.query(SQL, args());
      expect(await counts(RULE_1)).toEqual({ parents: 1, versions: 1 });
    });
  });
});

describe("create_rule_from_past_candidate: マスタの検証", () => {
  it("勘定科目・税区分がマスタにない／available=false なら拒否する", async () => {
    await asStaff(async () => {
      await addEntry("合成999", 999);
      expect((await expectFailure(SQL, args({ key: "合成999", account: 999 }))).code).toBe("P0001");
      expect((await expectFailure(SQL, args({ tax: 999 }))).code).toBe("P0001");

      await asSuperuser(() =>
        client.query("update public.freee_masters set available = false where customer_id = $1 and kind = 'account_item' and freee_id = 101", [CUSTOMER_A]),
      );
      expect((await expectFailure(SQL, args())).code).toBe("P0001");

      await asSuperuser(() =>
        client.query("update public.freee_masters set available = false where customer_id = $1 and kind = 'tax' and freee_id = 21", [CUSTOMER_A]),
      );
      await asSuperuser(() =>
        client.query("update public.freee_masters set available = true where customer_id = $1 and kind = 'account_item' and freee_id = 101", [CUSTOMER_A]),
      );
      expect((await expectFailure(SQL, args())).code).toBe("P0001");
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
    });
  });

  it("別の顧客のマスタにしかない科目・税区分は使えない", async () => {
    await asStaff(async () => {
      await asSuperuser(() =>
        client.query("insert into public.freee_masters (customer_id, kind, freee_id, name) values ($1, 'tax', 777, '他社の税区分（合成）')", [CUSTOMER_B]),
      );
      expect((await expectFailure(SQL, args({ tax: 777 }))).code).toBe("P0001");
    });
  });
});

describe("create_rule_from_past_candidate: 重複と原子性", () => {
  it("同じ依頼IDの2回目は 23505 で拒否し、親・版の件数も内容も変わらない", async () => {
    await asStaff(async () => {
      await client.query(SQL, args({ priority: 50 }));
      const before = await client.query("select * from public.journal_rule_versions where rule_id = $1", [RULE_1]);
      const r = await expectFailure(SQL, args({ priority: 7, tax: 2 }));
      expect(r.code).toBe("23505");
      expect(await counts(RULE_1)).toEqual({ parents: 1, versions: 1 });
      const after = await client.query("select * from public.journal_rule_versions where rule_id = $1", [RULE_1]);
      expect(after.rows).toEqual(before.rows);
    });
  });

  it("既存ルールのIDを依頼IDにしても上書きせず、既存の親・版は変わらない", async () => {
    await asStaff(async () => {
      const before = await counts(SEED_RULE);
      const versionsBefore = await client.query("select * from public.journal_rule_versions where rule_id = $1 order by version", [SEED_RULE]);
      expect((await expectFailure(SQL, args({ rule: SEED_RULE }))).code).toBe("23505");
      expect(await counts(SEED_RULE)).toEqual(before);
      const versionsAfter = await client.query("select * from public.journal_rule_versions where rule_id = $1 order by version", [SEED_RULE]);
      expect(versionsAfter.rows).toEqual(versionsBefore.rows);
    });
  });

  it("同じ内容の別IDは別のルールになる（既存と同じ意味のルールを重複として弾かない）", async () => {
    await asStaff(async () => {
      await client.query(SQL, args({ rule: RULE_1 }));
      await client.query(SQL, args({ rule: RULE_2 }));
      expect(await counts(RULE_1)).toEqual({ parents: 1, versions: 1 });
      expect(await counts(RULE_2)).toEqual({ parents: 1, versions: 1 });
    });
  });

  it("版1の INSERT が失敗したら、親の INSERT も巻き戻る（テスト専用のトリガーで強制）", async () => {
    await asStaff(async () => {
      await asSuperuser(async () => {
        await client.query(`
          create function public.test_force_version_failure() returns trigger language plpgsql as $$
          begin
            if new.rule_id = '${RULE_1}' then raise exception 'forced failure for test' using errcode = 'P0001'; end if;
            return new;
          end $$`);
        await client.query(`
          create trigger test_force_version_failure before insert on public.journal_rule_versions
          for each row execute function public.test_force_version_failure()`);
      });
      const r = await expectFailure(SQL, args());
      expect(r.message).toMatch(/forced failure for test/);
      expect(await counts(RULE_1)).toEqual({ parents: 0, versions: 0 });
      // 失敗のあとも、別のIDなら通常どおり作れる（トリガーは対象IDにだけ働く）
      await client.query(SQL, args({ rule: RULE_2 }));
      expect(await counts(RULE_2)).toEqual({ parents: 1, versions: 1 });
    });
    // ロールバック後にテスト用の関数が残っていない
    const left = await client.query("select 1 from pg_proc where proname = 'test_force_version_failure'");
    expect(left.rows).toHaveLength(0);
  });
});
