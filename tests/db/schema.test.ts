import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  ADMIN_ID,
  CUSTOMER_A,
  CUSTOMER_B,
  STAFF_ID,
  WALLET_A,
  asActor,
  connect,
  expectQueryError,
  insertSampleDecision,
} from "./helpers";

let client: Client;

beforeAll(async () => {
  client = await connect();
});

afterAll(async () => {
  await client.end();
});

describe("RLS: 閲覧範囲", () => {
  it("担当者は割り当てられた顧客だけ見える", async () => {
    const ids = await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const res = await client.query<{ id: string }>("select id from public.customers order by id");
      return res.rows.map((r) => r.id);
    });
    expect(ids).toEqual([CUSTOMER_A]);
  });

  it("管理者は全顧客が見える", async () => {
    const count = await asActor(client, { role: "authenticated", userId: ADMIN_ID }, async () => {
      const res = await client.query<{ n: string }>("select count(*) as n from public.customers");
      return Number(res.rows[0]!.n);
    });
    expect(count).toBe(2);
  });

  it("未ログイン（anon）はどの表も読めない", async () => {
    await asActor(client, { role: "anon" }, async () => {
      const message = await expectQueryError(client, "select * from public.customers");
      expect(message).toMatch(/permission denied/);
    });
  });

  it("担当外の顧客の過去仕訳・マスタは見えない", async () => {
    await client.query("begin");
    try {
      await client.query(
        `insert into public.freee_masters (customer_id, kind, freee_id, name) values ($1, 'account_item', 999, '担当外の科目')`,
        [CUSTOMER_B],
      );
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
      await client.query("set local role authenticated");
      const res = await client.query("select * from public.freee_masters where customer_id = $1", [CUSTOMER_B]);
      expect(res.rowCount).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("担当外の顧客には明細を登録できない", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const message = await expectQueryError(
        client,
        `insert into public.statement_imports (customer_id, wallet_id, source, imported_by)
         values ($1, '20000000-0000-4000-8000-000000000001', 'csv', $2)`,
        [CUSTOMER_B, STAFF_ID],
      );
      expect(message).toMatch(/row-level security/);
    });
  });

  it("全テーブルで RLS が有効", async () => {
    const res = await client.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });
});

describe("判断ログは追記専用", () => {
  it.each(["postgres", "service_role"] as const)("%s でも AI判断を更新・削除できない", async (role) => {
    await client.query("begin");
    try {
      const { decisionId } = await insertSampleDecision(client);
      if (role === "service_role") {
        await client.query("set local role service_role");
      }
      const updateError = await expectQueryError(
        client,
        "update public.ai_decisions set confidence = 'low' where id = $1",
        [decisionId],
      );
      expect(updateError).toMatch(/append-only|permission denied/);
      const deleteError = await expectQueryError(client, "delete from public.ai_decisions where id = $1", [decisionId]);
      expect(deleteError).toMatch(/append-only|permission denied/);
    } finally {
      await client.query("rollback");
    }
  });

  it("TRUNCATE も拒否する", async () => {
    await client.query("begin");
    try {
      const message = await expectQueryError(client, "truncate public.human_reviews cascade");
      expect(message).toMatch(/append-only/);
    } finally {
      await client.query("rollback");
    }
  });

  it("担当者は確認ログに直接書けず、更新もできない", async () => {
    await client.query("begin");
    try {
      const { decisionId } = await insertSampleDecision(client);
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
      await client.query("set local role authenticated");
      const insert = await expectQueryError(
        client,
        `insert into public.human_reviews (customer_id, ai_decision_id, action, reviewer_id) values ($1, $2, 'hold', $3)`,
        [CUSTOMER_A, decisionId, STAFF_ID],
      );
      expect(insert).toMatch(/permission denied/);
      const update = await expectQueryError(client, "update public.human_reviews set action = 'reject'");
      expect(update).toMatch(/permission denied/);
    } finally {
      await client.query("rollback");
    }
  });

  it("担当者は AI判断を直接書けない（サーバー側だけが書く）", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const message = await expectQueryError(
        client,
        `insert into public.ai_decisions (customer_id, bank_transaction_id, transaction_snapshot, confidence, confidence_breakdown)
         values ($1, gen_random_uuid(), '{}', 'high', '{}')`,
        [CUSTOMER_A],
      );
      expect(message).toMatch(/permission denied/);
    });
  });
});

describe("実行には人の承認記録が必要", () => {
  async function insertReview(decisionId: string, action: string): Promise<string> {
    const finalEntry = action === "approve" || action === "correct" ? '{"account_item_id": 101, "tax_code": 21}' : null;
    const res = await client.query<{ id: string }>(
      `insert into public.human_reviews (customer_id, ai_decision_id, action, final_entry, reviewer_id)
       values ($1, $2, $3, $4, $5) returning id`,
      [CUSTOMER_A, decisionId, action, finalEntry, STAFF_ID],
    );
    return res.rows[0]!.id;
  }

  it.each(["hold", "reject"])("確認が %s なら実行ログを書けない", async (action) => {
    await client.query("begin");
    try {
      const { decisionId } = await insertSampleDecision(client);
      const reviewId = await insertReview(decisionId, action);
      const message = await expectQueryError(
        client,
        `insert into public.execution_logs (customer_id, human_review_id, target, status, error)
         values ($1, $2, 'freee_deal', 'failed', 'x')`,
        [CUSTOMER_A, reviewId],
      );
      expect(message).toMatch(/requires an approve or correct human review/);
    } finally {
      await client.query("rollback");
    }
  });

  it("承認済みなら実行ログを書ける", async () => {
    await client.query("begin");
    try {
      const { decisionId } = await insertSampleDecision(client);
      const reviewId = await insertReview(decisionId, "approve");
      await client.query("set local role service_role");
      const res = await client.query(
        `insert into public.execution_logs (customer_id, human_review_id, target, status, external_id)
         values ($1, $2, 'freee_deal', 'succeeded', 123456)`,
        [CUSTOMER_A, reviewId],
      );
      expect(res.rowCount).toBe(1);
    } finally {
      await client.query("rollback");
    }
  });

  it("承認・修正以外では確定内容を持てない", async () => {
    await client.query("begin");
    try {
      const { decisionId } = await insertSampleDecision(client);
      const message = await expectQueryError(
        client,
        `insert into public.human_reviews (customer_id, ai_decision_id, action, final_entry, reviewer_id)
         values ($1, $2, 'hold', '{"account_item_id": 101}', $3)`,
        [CUSTOMER_A, decisionId, STAFF_ID],
      );
      expect(message).toMatch(/check constraint/);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("顧客ルールは版で管理する", () => {
  it("版は更新できず、新しい版が現在のルールになる", async () => {
    await client.query("begin");
    try {
      const ruleId = "30000000-0000-4000-8000-000000000001";
      const update = await expectQueryError(
        client,
        "update public.journal_rule_versions set account_item_id = 102 where rule_id = $1",
        [ruleId],
      );
      expect(update).toMatch(/append-only/);

      await client.query(
        `insert into public.journal_rule_versions
           (rule_id, version, customer_id, status, source, cond_partner_key, account_item_id, tax_code, created_by)
         values ($1, 2, $2, 'active', 'staff', 'サンプルツウシン', 102, 21, $3)`,
        [ruleId, CUSTOMER_A, ADMIN_ID],
      );
      const current = await client.query<{ version: number; account_item_id: string }>(
        "select version, account_item_id from public.current_journal_rules where rule_id = $1",
        [ruleId],
      );
      expect(current.rows).toEqual([{ version: 2, account_item_id: "102" }]);
    } finally {
      await client.query("rollback");
    }
  });

  it("版の顧客は親ルールと一致しなければならない", async () => {
    await client.query("begin");
    try {
      const message = await expectQueryError(
        client,
        `insert into public.journal_rule_versions
           (rule_id, version, customer_id, status, source, cond_direction, account_item_id, tax_code)
         values ('30000000-0000-4000-8000-000000000001', 3, $1, 'active', 'staff', 'expense', 101, 21)`,
        [CUSTOMER_B],
      );
      expect(message).toMatch(/does not match its parent/);
    } finally {
      await client.query("rollback");
    }
  });

  it("条件が1つもないルールは作れない", async () => {
    await client.query("begin");
    try {
      const message = await expectQueryError(
        client,
        `insert into public.journal_rule_versions
           (rule_id, version, customer_id, status, source, account_item_id, tax_code)
         values ('30000000-0000-4000-8000-000000000001', 3, $1, 'active', 'staff', 101, 21)`,
        [CUSTOMER_A],
      );
      expect(message).toMatch(/check constraint/);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("明細の取込", () => {
  const rows = [
    { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", balance: 100000, dedupe_key: "k1" },
    { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "ﾃｽﾄｺｷﾔｸ(ｶ", balance: 430000, dedupe_key: "k2" },
  ];

  it("担当者が取り込むと件数が返り、同じ取引の再取込は読み飛ばす", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const first = await client.query(
        "select * from public.import_bank_statement($1, $2, 'csv', 'oct.csv', 'bank_generic', $3)",
        [CUSTOMER_A, WALLET_A, JSON.stringify(rows)],
      );
      expect(first.rows[0]).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0 });

      const second = await client.query(
        "select * from public.import_bank_statement($1, $2, 'csv', 'oct2.csv', 'bank_generic', $3)",
        [CUSTOMER_A, WALLET_A, JSON.stringify(rows)],
      );
      expect(second.rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2 });

      const imports = await client.query(
        "select row_count, skipped_duplicate_count, imported_by from public.statement_imports order by imported_at, file_name",
      );
      expect(imports.rows).toEqual([
        { row_count: 2, skipped_duplicate_count: 0, imported_by: STAFF_ID },
        { row_count: 2, skipped_duplicate_count: 2, imported_by: STAFF_ID },
      ]);
    });
  });

  it("担当外の顧客には取り込めない", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'x.csv', 'bank_generic', $3)",
        [CUSTOMER_B, WALLET_A, JSON.stringify(rows)],
      );
      expect(message).toMatch(/row-level security/);
    });
  });

  it("別の顧客の口座は指定できない", async () => {
    await client.query("begin");
    try {
      const message = await expectQueryError(
        client,
        `insert into public.statement_imports (customer_id, wallet_id, source) values ($1, $2, 'csv')`,
        [CUSTOMER_B, WALLET_A],
      );
      expect(message).toMatch(/foreign key/);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("AI判断の記録", () => {
  async function newTxn(): Promise<string> {
    const imp = await client.query<{ id: string }>(
      `insert into public.statement_imports (customer_id, wallet_id, source) values ($1, $2, 'csv') returning id`,
      [CUSTOMER_A, WALLET_A],
    );
    const txn = await client.query<{ id: string }>(
      `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
       values ($1, $2, $3, '2026-10-27', 9020, 'expense', 'ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ', 'rec-1') returning id`,
      [CUSTOMER_A, WALLET_A, imp.rows[0]!.id],
    );
    return txn.rows[0]!.id;
  }

  it("判断を記録すると明細が候補作成済になる", async () => {
    await client.query("begin");
    try {
      const txnId = await newTxn();
      await client.query("set local role service_role");
      const decision = {
        customer_id: CUSTOMER_A,
        bank_transaction_id: txnId,
        transaction_snapshot: { amount: 9020 },
        proposal: { account_item_id: 101, tax_code: 21 },
        confidence: "high",
        confidence_breakdown: { rule: { matched: true } },
        rule_versions_used: [{ rule_id: "30000000-0000-4000-8000-000000000001", version: 1 }],
        past_entry_ids: [],
        ai_unknowns: [],
        model: null,
        prompt_version: null,
      };
      const res = await client.query<{ id: string }>("select public.record_ai_decision($1) as id", [JSON.stringify(decision)]);
      expect(res.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      const txn = await client.query("select status from public.bank_transactions where id = $1", [txnId]);
      expect(txn.rows[0]).toEqual({ status: "proposed" });
      const row = await client.query("select confidence, rule_versions_used from public.ai_decisions where id = $1", [res.rows[0]!.id]);
      expect(row.rows[0]).toMatchObject({ confidence: "high" });
    } finally {
      await client.query("rollback");
    }
  });

  it("担当者は AI判断の記録を呼べない", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const message = await expectQueryError(client, "select public.record_ai_decision('{}'::jsonb)");
      expect(message).toMatch(/permission denied/);
    });
  });
});

describe("人の確認の記録（record_human_review）", () => {
  const PROPOSAL = { account_item_id: 105, tax_code: 21, partner_id: 302, item_id: null, section_id: 401, tag_ids: [], description: "11月分 家賃" };

  async function setup(confidence = "high", proposal: object | null = PROPOSAL) {
    const imp = await client.query<{ id: string }>(
      `insert into public.statement_imports (customer_id, wallet_id, source) values ($1, $2, 'csv') returning id`,
      [CUSTOMER_A, WALLET_A],
    );
    const txn = await client.query<{ id: string }>(
      `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key, status)
       values ($1, $2, $3, '2026-10-30', 165000, 'expense', 'ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ', 'rv-1', 'proposed') returning id`,
      [CUSTOMER_A, WALLET_A, imp.rows[0]!.id],
    );
    const decision = await client.query<{ id: string }>(
      `insert into public.ai_decisions (customer_id, bank_transaction_id, transaction_snapshot, proposal, confidence, confidence_breakdown)
       values ($1, $2, '{"partnerKey": "サンプルフドウサン"}', $3, $4, '{}') returning id`,
      [CUSTOMER_A, txn.rows[0]!.id, proposal === null ? null : JSON.stringify(proposal), confidence],
    );
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
    await client.query("set local role authenticated");
    return { txnId: txn.rows[0]!.id, decisionId: decision.rows[0]!.id };
  }

  const review = (decisionId: string, action: string, entry: object | null = null, bulk = false) =>
    client.query<{ id: string }>("select public.record_human_review($1, $2, $3, $4, $5, $6) as id", [
      decisionId,
      action,
      entry === null ? null : JSON.stringify(entry),
      null,
      7,
      bulk,
    ]);

  async function inTx(fn: () => Promise<void>) {
    await client.query("begin");
    try {
      await fn();
    } finally {
      await client.query("rollback");
    }
  }

  it("承認すると本人名義で記録され、明細は承認済、過去仕訳に加わる", () =>
    inTx(async () => {
      const { txnId, decisionId } = await setup();
      const res = await review(decisionId, "approve", null, true);
      const row = await client.query("select action, reviewer_id, final_entry, bulk, review_seconds from public.human_reviews where id = $1", [res.rows[0]!.id]);
      expect(row.rows[0]).toMatchObject({ action: "approve", reviewer_id: STAFF_ID, bulk: true, review_seconds: 7 });
      expect(row.rows[0].final_entry).toMatchObject({ account_item_id: 105, tax_code: 21, section_id: 401 });
      const txn = await client.query("select status from public.bank_transactions where id = $1", [txnId]);
      expect(txn.rows[0]).toEqual({ status: "approved" });
      const past = await client.query("select partner_key, account_item_id from public.past_journal_entries where ai_decision_id = $1", [decisionId]);
      expect(past.rows).toEqual([{ partner_key: "サンプルフドウサン", account_item_id: "105" }]);
    }));

  it("修正は差分を残す", () =>
    inTx(async () => {
      const { decisionId } = await setup("medium");
      const res = await review(decisionId, "correct", { ...PROPOSAL, account_item_id: 102 });
      const row = await client.query("select action, diff from public.human_reviews where id = $1", [res.rows[0]!.id]);
      expect(row.rows[0]).toEqual({ action: "correct", diff: { account_item_id: { before: 105, after: 102 } } });
    }));

  it("修正にマスタにない値は使えない", () =>
    inTx(async () => {
      const { decisionId } = await setup("low");
      const message = await expectQueryError(client, "select public.record_human_review($1, 'correct', $2, null, 1, false)", [
        decisionId,
        JSON.stringify({ ...PROPOSAL, account_item_id: 999 }),
      ]);
      expect(message).toMatch(/マスタにありません/);
    }));

  it("まとめて承認は確信度「高」だけ", () =>
    inTx(async () => {
      const { decisionId } = await setup("medium");
      const message = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, true)", [decisionId]);
      expect(message).toMatch(/確信度「高」だけ/);
    }));

  it("提案がなければ承認できない（修正として入力する）", () =>
    inTx(async () => {
      const { decisionId } = await setup("low", null);
      const message = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, false)", [decisionId]);
      expect(message).toMatch(/提案がない/);
    }));

  it("確認済みの明細は二重に承認できない", () =>
    inTx(async () => {
      const { decisionId } = await setup();
      await review(decisionId, "approve");
      const message = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, false)", [decisionId]);
      expect(message).toMatch(/確認済み/);
    }));

  it("保留した明細はあとで承認できる", () =>
    inTx(async () => {
      const { txnId, decisionId } = await setup();
      await review(decisionId, "hold");
      expect((await client.query("select status from public.bank_transactions where id = $1", [txnId])).rows[0]).toEqual({ status: "on_hold" });
      await review(decisionId, "approve");
      expect((await client.query("select status from public.bank_transactions where id = $1", [txnId])).rows[0]).toEqual({ status: "approved" });
    }));

  it("担当外の顧客の仕訳候補は確認できない", () =>
    inTx(async () => {
      const { decisionId } = await setup();
      await client.query("reset role");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", ["00000000-0000-4000-8000-000000000099"]);
      await client.query("insert into auth.users (id) values ('00000000-0000-4000-8000-000000000099')");
      await client.query(
        "insert into public.staff_members (user_id, email, display_name, role) values ('00000000-0000-4000-8000-000000000099', 'x@example.com', '別担当', 'staff')",
      );
      await client.query("set local role authenticated");
      const message = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, false)", [decisionId]);
      expect(message).toMatch(/見つかりません/);
    }));
});
