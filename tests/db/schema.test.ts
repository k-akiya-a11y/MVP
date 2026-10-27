import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  ADMIN_ID,
  CUSTOMER_A,
  CUSTOMER_B,
  STAFF_ID,
  WALLET_A,
  WALLET_A_CARD,
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

  it("担当者は明細・取込記録の表に直接書けない", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const message = await expectQueryError(
        client,
        `insert into public.statement_imports (customer_id, wallet_id, source, imported_by)
         values ($1, '20000000-0000-4000-8000-000000000001', 'csv', $2)`,
        [CUSTOMER_A, STAFF_ID],
      );
      // 担当顧客でも表に直接は書けない（取込は import_bank_statement だけを通す）
      expect(message).toMatch(/permission denied/);
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
        "select * from public.import_bank_statement($1, $2, 'csv', 'oct.csv', 'bank_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A, JSON.stringify(rows)],
      );
      expect(first.rows[0]).toMatchObject({ inserted_count: 2, skipped_duplicate_count: 0 });

      const second = await client.query(
        "select * from public.import_bank_statement($1, $2, 'csv', 'oct2.csv', 'bank_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A, JSON.stringify(rows)],
      );
      expect(second.rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2 });

      const imports = await client.query(
        // 同じトランザクション内なので imported_at は同じ。照合順序に依存しないよう件数で並べる
        "select row_count, skipped_duplicate_count, imported_by from public.statement_imports order by skipped_duplicate_count",
      );
      expect(imports.rows).toEqual([
        { row_count: 2, skipped_duplicate_count: 0, imported_by: STAFF_ID },
        { row_count: 2, skipped_duplicate_count: 2, imported_by: STAFF_ID },
      ]);
    });
  });

  it("CSV の形式と口座の種類が合わなければ、担当顧客の口座でも取り込まず、明細も取込記録も増えない", async () => {
    const bankRows = rows;
    const cardRows = [{ txn_date: "2026-10-05", amount: 550, direction: "expense", description: "ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ", balance: null, dedupe_key: "c1" }];
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const count = async () => {
        const res = await client.query<{ txns: string; imports: string }>(
          "select (select count(*) from public.bank_transactions where customer_id = $1) as txns, (select count(*) from public.statement_imports where customer_id = $1) as imports",
          [CUSTOMER_A],
        );
        return { txns: Number(res.rows[0]!.txns), imports: Number(res.rows[0]!.imports) };
      };
      const before = await count();

      // 銀行 CSV をカードの口座へ
      let message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'bank.csv', 'bank_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A_CARD, JSON.stringify(bankRows)],
      );
      expect(message).toMatch(/口座と CSV の形式が合っていません/);
      // カード CSV を銀行の口座へ
      message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'card.csv', 'card_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A, JSON.stringify(cardRows)],
      );
      expect(message).toMatch(/口座と CSV の形式が合っていません/);
      // 未対応の形式
      message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'x.csv', 'unknown_format', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A, JSON.stringify(bankRows)],
      );
      expect(message).toMatch(/未対応の CSV 形式/);
      // 別の顧客の口座 ID
      message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'x.csv', 'bank_generic', $3, null, '[]')",
        [CUSTOMER_A, "20000000-0000-4000-8000-0000000000ff", JSON.stringify(bankRows)],
      );
      expect(message).toMatch(/口座が見つかりません/);

      expect(await count()).toEqual(before);

      // 合っていれば取り込める（検査が厳しすぎないこと）
      const ok = await client.query(
        "select * from public.import_bank_statement($1, $2, 'csv', 'card.csv', 'card_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A_CARD, JSON.stringify(cardRows)],
      );
      expect(ok.rows[0]).toMatchObject({ inserted_count: 1 });
    });
  });

  it("形式が合わなかった取込を「失敗」として記録することはできる（明細は登録しない）", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const id = await client.query<{ record_failed_statement_import: string }>(
        "select public.record_failed_statement_import($1, $2, 'csv', 'bank.csv', 'bank_generic', 5, $3)",
        [CUSTOMER_A, WALLET_A_CARD, JSON.stringify([{ line: 0, message: "選んだ口座と CSV の形式が合っていません" }])],
      );
      const rec = await client.query("select status, row_count, inserted_count from public.statement_imports where id = $1", [
        id.rows[0]!.record_failed_statement_import,
      ]);
      expect(rec.rows).toEqual([{ status: "failed", row_count: 0, inserted_count: 0 }]);
    });
  });

  it("残高がなく区別できない行は捨てず「重複の疑い」として登録する", async () => {
    const card = [{ txn_date: "2026-10-05", amount: 550, direction: "expense", description: "ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ", balance: null, dedupe_key: "c1" }];
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const first = await client.query(
        "select * from public.import_bank_statement($1, $2, 'csv', 'a.csv', 'card_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A_CARD, JSON.stringify(card)],
      );
      expect(first.rows[0]).toMatchObject({ inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
      const second = await client.query(
        "select * from public.import_bank_statement($1, $2, 'csv', 'b.csv', 'card_generic', $3, null, '[]')",
        [CUSTOMER_A, WALLET_A_CARD, JSON.stringify(card)],
      );
      expect(second.rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });

      const txns = await client.query(
        "select status, duplicate_of_id is not null as has_original from public.bank_transactions where description = 'ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ' order by created_at, status",
      );
      expect(txns.rows).toEqual([
        { status: "duplicate_suspected", has_original: true },
        { status: "new", has_original: false },
      ]);
      const imports = await client.query("select suspected_duplicate_count from public.statement_imports where file_name = 'b.csv'");
      expect(imports.rows).toEqual([{ suspected_duplicate_count: 1 }]);
    });
  });

  it("取込記録で、読めた行の件数・金額 = 登録 + 読み飛ばし + 重複の疑い が成り立つ（一部だけ重なる取込）", async () => {
    const mixed = [
      { txn_date: "2026-10-27", amount: 9020, direction: "expense", description: "ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", balance: 100000, dedupe_key: "m1" },
      { txn_date: "2026-10-05", amount: 550, direction: "expense", description: "ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ", balance: null, dedupe_key: "m2" },
    ];
    const second = [
      ...mixed,
      { txn_date: "2026-10-31", amount: 330000, direction: "income", description: "ﾃｽﾄｺｷﾔｸ(ｶ", balance: 430000, dedupe_key: "m3" },
    ];
    const ignored = JSON.stringify([{ line: 5, reason: "金額が0（残高照会などの行）" }]);
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      await client.query("select * from public.import_bank_statement($1, $2, 'csv', 'm1.csv', 'bank_generic', $3, 2, '[]')", [
        CUSTOMER_A, WALLET_A, JSON.stringify(mixed),
      ]);
      const res = await client.query("select * from public.import_bank_statement($1, $2, 'csv', 'm2.csv', 'bank_generic', $3, 4, $4)", [
        CUSTOMER_A, WALLET_A, JSON.stringify(second), ignored,
      ]);
      // 一部だけ重なる取込は再実行ではないので、残高のある行も読み飛ばさず「重複の疑い」にする
      expect(res.rows[0]).toMatchObject({
        inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 2,
        income_total: "330000", expense_total: "9570",
        inserted_amount_total: "330000", skipped_amount_total: "0", suspected_amount_total: "9570",
      });
      const rec = await client.query(
        "select status, source_row_count, row_count, inserted_count, ignored_rows from public.statement_imports where file_name = 'm2.csv'",
      );
      expect(rec.rows[0]).toEqual({
        status: "completed", source_row_count: 4, row_count: 3, inserted_count: 1,
        ignored_rows: [{ line: 5, reason: "金額が0（残高照会などの行）" }],
      });
      // 行数が合わない取込記録は DB が受け付けない
      const message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'bad.csv', 'bank_generic', $3, 9, '[]')",
        [CUSTOMER_A, WALLET_A, JSON.stringify([{ ...second[2], dedupe_key: "m9" }])],
      );
      expect(message).toMatch(/statement_imports_reconciled/);
    });
  });

  it("読めなかった取込も、理由と行番号を「失敗」として記録する（明細は登録しない）", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      await client.query("select public.record_failed_statement_import($1, $2, 'csv', 'ng.csv', 'bank_generic', 2, $3)", [
        CUSTOMER_A, WALLET_A, JSON.stringify([{ line: 3, message: "金額を読めません" }]),
      ]);
      const rec = await client.query("select status, row_count, errors, imported_by from public.statement_imports where file_name = 'ng.csv'");
      expect(rec.rows).toEqual([{ status: "failed", row_count: 0, errors: [{ line: 3, message: "金額を読めません" }], imported_by: STAFF_ID }]);
      const empty = await expectQueryError(client, "select public.record_failed_statement_import($1, $2, 'csv', 'ng2.csv', 'bank_generic', 2, '[]')", [
        CUSTOMER_A, WALLET_A,
      ]);
      expect(empty).toMatch(/失敗の理由がありません/);
    });
  });

  it("担当外の顧客には取り込めない", async () => {
    await asActor(client, { role: "authenticated", userId: STAFF_ID }, async () => {
      const message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'x.csv', 'bank_generic', $3, null, '[]')",
        [CUSTOMER_B, WALLET_A, JSON.stringify(rows)],
      );
      expect(message).toMatch(/担当外の顧客には明細を取り込めません/);
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

describe("明細の取込: 別ファイルのキーの重なり（取込全体の再実行だけを読み飛ばす）", () => {
  const shop = { txn_date: "2026-10-05", amount: 1000, direction: "expense", description: "ｻﾝﾌﾟﾙｼﾖﾂﾌﾟ", balance: 9000 };
  const salary = { txn_date: "2026-10-05", amount: 1000, direction: "income", description: "ﾃｽﾄﾆﾕｳｷﾝ", balance: 10000 };
  const csvA = [{ ...shop, dedupe_key: "x-shop-1" }];
  // CSV B の連番は 1 から数え直すので、別の取引である同じ内容の出金が CSV A と同じキーになる
  const csvB = [{ ...salary, dedupe_key: "x-salary-1" }, { ...shop, dedupe_key: "x-shop-1" }];

  const importRows = (file: string, rowsToImport: object[], count: number | null = null) =>
    client.query(
      "select * from public.import_bank_statement($1, $2, 'csv', $3, 'bank_generic', $4, $5, '[]')",
      [CUSTOMER_A, WALLET_A, file, JSON.stringify(rowsToImport), count],
    );
  const txnCount = async () =>
    Number((await client.query<{ n: string }>("select count(*) as n from public.bank_transactions where customer_id = $1", [CUSTOMER_A])).rows[0]!.n);

  async function inTx(fn: () => Promise<void>) {
    await client.query("begin");
    try {
      await fn();
    } finally {
      await client.query("rollback");
    }
  }
  const asStaff = async () => {
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
    await client.query("set local role authenticated");
  };

  it("残高が同じでも、別ファイルの同じキーの行は読み飛ばさず「重複の疑い」として残す（別取引を消さない）", () =>
    inTx(async () => {
      await asStaff();
      const a = await importRows("a.csv", csvA, 1);
      expect(a.rows[0]).toMatchObject({ inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 0 });
      const b = await importRows("b.csv", csvB, 2);
      expect(b.rows[0]).toMatchObject({
        inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 1,
        income_total: "1000", expense_total: "1000",
        inserted_amount_total: "1000", skipped_amount_total: "0", suspected_amount_total: "1000",
      });
      // 3件とも残っている。疑いの行は A の行を指し、人が「別の取引」か「重複」かを決める
      expect(await txnCount()).toBe(3);
      const suspected = await client.query(
        `select t.status, t.balance, o.status as original_status, o.import_id <> t.import_id as from_other_file
         from public.bank_transactions t join public.bank_transactions o on o.id = t.duplicate_of_id
         where t.status = 'duplicate_suspected'`,
      );
      expect(suspected.rows).toEqual([{ status: "duplicate_suspected", balance: "9000", original_status: "new", from_other_file: true }]);
    }));

  it("同じ内容の取込全体を再実行したときだけ、残高のある行を読み飛ばす（順序が違っても同じ）。DB が内容から計算した識別を記録する", () =>
    inTx(async () => {
      await asStaff();
      await importRows("a.csv", csvA, 1);
      await importRows("b.csv", csvB, 2);
      const before = await txnCount();
      // A の再実行
      expect((await importRows("a2.csv", csvA, 1)).rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 1, suspected_duplicate_count: 0 });
      // 疑いの行を含む B の再実行（行の順序が違っても同じ取込）。疑いが増えず、明細も増えない
      expect((await importRows("b2.csv", [...csvB].reverse(), 2)).rows[0]).toMatchObject({
        inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0,
        skipped_amount_total: "2000", suspected_amount_total: "0",
      });
      expect((await importRows("b3.csv", csvB, 2)).rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0 });
      expect(await txnCount()).toBe(before);
      const hashes = await client.query<{ batch_hash: string }>("select batch_hash from public.statement_imports where file_name in ('b.csv', 'b2.csv', 'b3.csv')");
      expect(hashes.rows).toHaveLength(3);
      expect(new Set(hashes.rows.map((r) => r.batch_hash)).size).toBe(1);
      expect(hashes.rows[0]!.batch_hash).toMatch(/^[0-9a-f]{64}$/);
      // 件数・金額の照合は読み飛ばしでも成り立つ（制約が受け付けている）
      const rec = await client.query("select row_count, inserted_count, skipped_duplicate_count, suspected_duplicate_count from public.statement_imports where file_name = 'b2.csv'");
      expect(rec.rows).toEqual([{ row_count: 2, inserted_count: 0, skipped_duplicate_count: 2, suspected_duplicate_count: 0 }]);
    }));

  it("一部だけ重なる取込は再実行ではないので、重なった行はすべて「重複の疑い」にする", () =>
    inTx(async () => {
      await asStaff();
      await importRows("b.csv", csvB, 2);
      const partial = [csvB[1]!, { ...salary, txn_date: "2026-10-06", dedupe_key: "x-salary-2" }];
      expect((await importRows("partial.csv", partial, 2)).rows[0]).toMatchObject({ inserted_count: 1, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });
      // 重なりのない取込は影響を受けない
      expect((await importRows("other.csv", [{ ...salary, txn_date: "2026-11-06", dedupe_key: "x-other" }], 1)).rows[0]).toMatchObject({ inserted_count: 1, suspected_duplicate_count: 0 });
    }));

  it("同じキーで行の内容（金額・摘要・残高・日付・入出金）が変わっていれば、読み飛ばさない", () =>
    inTx(async () => {
      await asStaff();
      await importRows("a.csv", csvA, 1);
      const changes: object[] = [{ amount: 2000 }, { description: "ｲｶﾞｲﾉﾃﾝﾎﾟ" }, { balance: 8000 }, { balance: null }, { txn_date: "2026-10-06" }, { direction: "income" }];
      for (const [i, change] of changes.entries()) {
        const res = await importRows(`changed${i}.csv`, [{ ...csvA[0], ...change }], 1);
        expect(res.rows[0], JSON.stringify(change)).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });
      }
      expect(await txnCount()).toBe(1 + changes.length);
    }));

  it("残高のない行は、取込全体の再実行でも読み飛ばさず「重複の疑い」にする（同内容のファイルを別々に取り込んだ別取引と区別できない）", () =>
    inTx(async () => {
      await asStaff();
      const card = [{ ...shop, balance: null, dedupe_key: "x-card-1" }];
      await importRows("c1.csv", card, 1);
      const again = await importRows("c2.csv", card, 1);
      expect(again.rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });
      // 残高のある行と残高のない行が混ざる再実行: 残高のある行だけ読み飛ばす
      const mixed = [{ ...shop, dedupe_key: "x-mix-1" }, { ...shop, balance: null, dedupe_key: "x-mix-2" }];
      await importRows("m1.csv", mixed, 2);
      expect((await importRows("m2.csv", mixed, 2)).rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 1, suspected_duplicate_count: 1 });
    }));

  it("同じファイルに同じ内容の行が複数あっても（キーが別）取り込め、再実行は全部読み飛ばす。同じキーが2回あるファイルは拒否する", () =>
    inTx(async () => {
      await asStaff();
      const twice = [{ ...shop, dedupe_key: "x-twice-1" }, { ...shop, dedupe_key: "x-twice-2" }];
      expect((await importRows("t1.csv", twice, 2)).rows[0]).toMatchObject({ inserted_count: 2 });
      expect((await importRows("t2.csv", twice, 2)).rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 2 });
      const message = await expectQueryError(
        client,
        "select * from public.import_bank_statement($1, $2, 'csv', 'dup.csv', 'bank_generic', $3, 2, '[]')",
        [CUSTOMER_A, WALLET_A, JSON.stringify([twice[0], twice[0]])],
      );
      expect(message).toMatch(/重複キーが重なっています/);
    }));

  it("この変更より前の取込（識別なし）と同じキーの行は、内容が同じでも読み飛ばさず「重複の疑い」にする", () =>
    inTx(async () => {
      // 古い取込を再現する: batch_hash のない取込記録と明細を直接作る
      const imp = await client.query<{ id: string }>(
        `insert into public.statement_imports (customer_id, wallet_id, source, row_count, inserted_count, income_total, expense_total, inserted_amount_total)
         values ($1, $2, 'csv', 1, 1, 0, 1000, 1000) returning id`,
        [CUSTOMER_A, WALLET_A],
      );
      await client.query(
        `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, balance, dedupe_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'x-shop-1')`,
        [CUSTOMER_A, WALLET_A, imp.rows[0]!.id, shop.txn_date, shop.amount, shop.direction, shop.description, shop.balance],
      );
      await asStaff();
      expect((await importRows("after-legacy.csv", csvA, 1)).rows[0]).toMatchObject({ inserted_count: 0, skipped_duplicate_count: 0, suspected_duplicate_count: 1 });
      // 取り込んだ記録には識別が付き、その再実行からは読み飛ばせる
      expect((await importRows("after-legacy2.csv", csvA, 1)).rows[0]).toMatchObject({ skipped_duplicate_count: 1, suspected_duplicate_count: 0 });
    }));

  it("失敗した取込記録には識別が付かず、再実行の判定に影響しない", () =>
    inTx(async () => {
      await asStaff();
      await importRows("a.csv", csvA, 1);
      await client.query("select public.record_failed_statement_import($1, $2, 'csv', 'ng.csv', 'bank_generic', 1, $3)", [
        CUSTOMER_A, WALLET_A, JSON.stringify([{ line: 2, message: "x" }]),
      ]);
      expect((await importRows("a2.csv", csvA, 1)).rows[0]).toMatchObject({ skipped_duplicate_count: 1 });
      const failed = await client.query("select batch_hash from public.statement_imports where file_name = 'ng.csv'");
      expect(failed.rows).toEqual([{ batch_hash: null }]);
    }));

  it("取込は顧客単位のロックを取って直列にする（トランザクションの終わりまで保持）", () =>
    inTx(async () => {
      await asStaff();
      await importRows("a.csv", csvA, 1);
      const locks = await client.query<{ n: string }>(
        "select count(*) as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted",
      );
      expect(Number(locks.rows[0]!.n)).toBeGreaterThanOrEqual(1);
    }));
});

describe("トップ画面の残件数（pending_transaction_counts）", () => {
  it("1,000件を超えても欠けずに数え、重複の疑いも残件に含める。担当外の顧客は数えない", async () => {
    await client.query("begin");
    try {
      const imp = await client.query<{ id: string }>(
        `insert into public.statement_imports (customer_id, wallet_id, source) values ($1, $2, 'csv') returning id`,
        [CUSTOMER_A, WALLET_A],
      );
      await client.query(
        `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key)
         select $1, $2, $3, '2026-10-01', 100 + g, 'expense', 'ｻﾝﾌﾟﾙ', 'cnt-' || g from generate_series(1, 1205) g`,
        [CUSTOMER_A, WALLET_A, imp.rows[0]!.id],
      );
      const original = await client.query<{ id: string }>("select id from public.bank_transactions where dedupe_key = 'cnt-1'");
      await client.query(
        `insert into public.bank_transactions (customer_id, wallet_id, import_id, txn_date, amount, direction, description, dedupe_key, status, duplicate_of_id)
         values ($1, $2, $3, '2026-10-01', 101, 'expense', 'ｻﾝﾌﾟﾙ', 'cnt-1:suspected', 'duplicate_suspected', $4)`,
        [CUSTOMER_A, WALLET_A, imp.rows[0]!.id, original.rows[0]!.id],
      );
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
      await client.query("set local role authenticated");
      const counts = await client.query("select customer_id, status, count from public.pending_transaction_counts order by status");
      expect(counts.rows).toEqual([
        { customer_id: CUSTOMER_A, status: "duplicate_suspected", count: 1 },
        { customer_id: CUSTOMER_A, status: "new", count: 1205 },
      ]);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("重複の疑いの確認（resolve_suspected_duplicate）", () => {
  const card = [{ txn_date: "2026-10-05", amount: 550, direction: "expense", description: "ｻﾝﾌﾟﾙｺﾝﾋﾞﾆ", balance: null, dedupe_key: "c1" }];

  async function suspected(userId: string): Promise<string> {
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
    await client.query("set local role authenticated");
    for (const file of ["a.csv", "b.csv"]) {
      await client.query("select * from public.import_bank_statement($1, $2, 'csv', $3, 'card_generic', $4, null, '[]')", [
        CUSTOMER_A, WALLET_A_CARD, file, JSON.stringify(card),
      ]);
    }
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const row = await client.query<{ id: string }>("select id from public.bank_transactions where status = 'duplicate_suspected'");
    return row.rows[0]!.id;
  }

  async function inTx(fn: () => Promise<void>) {
    await client.query("begin");
    try {
      await fn();
    } finally {
      await client.query("rollback");
    }
  }

  it("担当者は「別の取引」として未判定に戻せる。確認は記録に残る", () =>
    inTx(async () => {
      const id = await suspected(STAFF_ID);
      await client.query("select public.resolve_suspected_duplicate($1, 'distinct', '同日に2回利用')", [id]);
      expect((await client.query("select status from public.bank_transactions where id = $1", [id])).rows).toEqual([{ status: "new" }]);
      const log = await client.query("select resolution, reason, reviewer_id from public.duplicate_reviews where bank_transaction_id = $1", [id]);
      expect(log.rows).toEqual([{ resolution: "distinct", reason: "同日に2回利用", reviewer_id: STAFF_ID }]);
    }));

  it("重複として除外できるのは承認者（管理者）だけ", () =>
    inTx(async () => {
      const id = await suspected(STAFF_ID);
      const message = await expectQueryError(client, "select public.resolve_suspected_duplicate($1, 'duplicate', null)", [id]);
      expect(message).toMatch(/承認者/);
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN_ID]);
      await client.query("select public.resolve_suspected_duplicate($1, 'duplicate', null)", [id]);
      expect((await client.query("select status from public.bank_transactions where id = $1", [id])).rows).toEqual([{ status: "duplicate" }]);
    }));

  it("重複の疑いのある明細は仕訳候補にも承認にも進まない", () =>
    inTx(async () => {
      const id = await suspected(ADMIN_ID);
      await client.query("reset role");
      await client.query("set local role service_role");
      const message = await expectQueryError(client, "select public.record_ai_decision($1)", [
        JSON.stringify({
          customer_id: CUSTOMER_A, bank_transaction_id: id, transaction_snapshot: {}, proposal: null,
          confidence: "low", confidence_breakdown: {},
        }),
      ]);
      expect(message).toMatch(/not waiting for a proposal/);
    }));

  it("確認ログは更新できない", () =>
    inTx(async () => {
      const id = await suspected(STAFF_ID);
      await client.query("select public.resolve_suspected_duplicate($1, 'distinct', null)", [id]);
      await client.query("reset role");
      const message = await expectQueryError(client, "update public.duplicate_reviews set reason = 'x'");
      expect(message).toMatch(/append-only/);
    }));
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

  // 遅れて届いた保存（同じ明細を未判定として読み込んだ別のジョブ）が、状態や人の判断を書き換えないこと。
  // 注: ここは同じ接続での順次の再現（先の保存・保留が確定した後に、遅れた保存が届く結果）の検証。
  // 2つの独立したセッションが同時に走る競合は、判断ログが追記専用で後から消せず共有のテストデータを汚すため再現していない。
  // 同時実行での安全性は、確認と更新を1文（update ... where status = 'new'）で行う実装に依る
  const decisionFor = (txnId: string, accountItemId = 101) =>
    JSON.stringify({
      customer_id: CUSTOMER_A,
      bank_transaction_id: txnId,
      transaction_snapshot: { amount: 9020 },
      proposal: { account_item_id: accountItemId, tax_code: 21 },
      confidence: "high",
      confidence_breakdown: {},
      model: null,
      prompt_version: null,
    });
  const save = async (txnId: string, accountItemId = 101) => {
    await client.query("reset role");
    await client.query("set local role service_role");
    return (await client.query<{ id: string }>("select public.record_ai_decision($1) as id", [decisionFor(txnId, accountItemId)])).rows[0]!.id;
  };
  const saveRejected = async (txnId: string) => {
    await client.query("reset role");
    await client.query("set local role service_role");
    return expectQueryError(client, "select public.record_ai_decision($1)", [decisionFor(txnId, 102)]);
  };
  const asUser = async (userId: string) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await client.query("set local role authenticated");
  };
  const snapshot = async (txnId: string) => {
    await client.query("reset role");
    const txn = await client.query("select status from public.bank_transactions where id = $1", [txnId]);
    const decisions = await client.query("select id, proposal from public.ai_decisions where bank_transaction_id = $1 order by created_at, id", [txnId]);
    const reviews = await client.query(
      "select r.action, r.reason, r.reviewer_id from public.human_reviews r join public.ai_decisions d on d.id = r.ai_decision_id where d.bank_transaction_id = $1 order by r.created_at, r.action",
      [txnId],
    );
    return { status: txn.rows[0]!.status, decisions: decisions.rows, reviews: reviews.rows };
  };
  async function inTx(fn: () => Promise<void>) {
    await client.query("begin");
    try {
      await fn();
    } finally {
      await client.query("rollback");
    }
  }

  it("候補作成済（proposed）の明細への重ねての保存は拒否し、最初の判断を置き換えない", () =>
    inTx(async () => {
      const txnId = await newTxn();
      await save(txnId);
      const before = await snapshot(txnId);
      expect(before.status).toBe("proposed");
      expect(await saveRejected(txnId)).toMatch(/not waiting for a proposal/);
      expect(await snapshot(txnId)).toEqual(before);
    }));

  it("保留（on_hold）にした後に遅れて届いた保存は拒否し、保留・理由・判断ログを変えず、まとめて承認もできないまま", () =>
    inTx(async () => {
      const txnId = await newTxn();
      const decisionId = await save(txnId); // ジョブ A
      await asUser(STAFF_ID);
      await client.query("select public.record_human_review($1, 'hold', null, '請求書の到着待ち', 3, false)", [decisionId]); // 人が保留
      const before = await snapshot(txnId);
      expect(before.status).toBe("on_hold");
      expect(before.reviews).toEqual([{ action: "hold", reason: "請求書の到着待ち", reviewer_id: STAFF_ID }]);

      expect(await saveRejected(txnId)).toMatch(/not waiting for a proposal/); // ジョブ B（遅れて保存）
      const after = await snapshot(txnId);
      expect(after).toEqual(before); // 状態・判断・保留の理由と記録が変わらない
      expect(after.decisions).toHaveLength(1);

      // 保留は解除されていないので、管理者でもまとめて承認はできない（1件ずつなら承認できる）
      await asUser(ADMIN_ID);
      const bulk = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, true)", [decisionId]);
      expect(bulk).toMatch(/保留中の明細はまとめて承認できません/);
      await client.query("select public.record_human_review($1, 'approve', null, null, 1, false)", [decisionId]);
      expect((await snapshot(txnId)).status).toBe("approved");
    }));

  it("承認済・却下・登録済の明細には保存できず、状態も判断も変わらない", async () => {
    for (const final of ["approve", "reject", "registered"] as const) {
      await inTx(async () => {
        const txnId = await newTxn();
        const decisionId = await save(txnId);
        if (final === "registered") {
          await client.query("reset role");
          await client.query("update public.bank_transactions set status = 'registered' where id = $1", [txnId]);
        } else {
          await asUser(ADMIN_ID);
          await client.query("select public.record_human_review($1, $2, null, null, 1, false)", [decisionId, final]);
        }
        const before = await snapshot(txnId);
        expect(before.status).toBe(final === "approve" ? "approved" : final === "reject" ? "rejected" : "registered");
        expect(await saveRejected(txnId)).toMatch(/not waiting for a proposal/);
        expect(await snapshot(txnId)).toEqual(before);
      });
    }
  });

  it("未判定（new）の明細には、1回だけ保存できる", () =>
    inTx(async () => {
      const txnId = await newTxn();
      await save(txnId);
      expect(await saveRejected(txnId)).toMatch(/not waiting for a proposal/);
      expect((await snapshot(txnId)).decisions).toHaveLength(1);
    }));

  it("重複の疑いの明細には保存できず、人が「別の取引」として未判定（new）に戻せば保存できる", () =>
    inTx(async () => {
      const txnId = await newTxn();
      await client.query("update public.bank_transactions set status = 'duplicate_suspected', duplicate_of_id = id where id = $1", [txnId]);
      expect(await saveRejected(txnId)).toMatch(/not waiting for a proposal/);
      await client.query("reset role");
      await client.query("update public.bank_transactions set status = 'new' where id = $1", [txnId]);
      await save(txnId);
      expect((await snapshot(txnId)).status).toBe("proposed");
    }));
});

describe("人の確認の記録（record_human_review）", () => {
  const PROPOSAL = { account_item_id: 105, tax_code: 21, partner_id: 302, item_id: null, section_id: 401, tag_ids: [], description: "11月分 家賃" };

  async function setup(confidence = "high", proposal: object | null = PROPOSAL, actor = ADMIN_ID) {
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
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actor]);
    await client.query("set local role authenticated");
    return { txnId: txn.rows[0]!.id, decisionId: decision.rows[0]!.id };
  }

  const review = (
    decisionId: string,
    action: string,
    entry: object | null = null,
    bulk = false,
    reason: string | null = action === "hold" ? "請求書の到着待ち" : null,
  ) =>
    client.query<{ id: string }>("select public.record_human_review($1, $2, $3, $4, $5, $6) as id", [
      decisionId,
      action,
      entry === null ? null : JSON.stringify(entry),
      reason,
      7,
      bulk,
    ]);

  const asUser = async (userId: string) => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    await client.query("set local role authenticated");
  };

  it("保留には理由が必須（空白・全角空白・改行だけの理由も拒否する）", () =>
    inTx(async () => {
      const { decisionId } = await setup("high", PROPOSAL, STAFF_ID);
      for (const reason of [null, "", "   ", "　\n\t　"]) {
        const message = await expectQueryError(client, "select public.record_human_review($1, 'hold', null, $2, 1, false)", [decisionId, reason]);
        expect(message).toMatch(/保留の理由を入力してください/);
      }
    }));

  it("担当者が理由付きで保留 → 管理者が理由・保留者・日時を見て、1件ずつ承認できる", () =>
    inTx(async () => {
      const { txnId, decisionId } = await setup("high", PROPOSAL, STAFF_ID);
      await review(decisionId, "hold", null, false, "  インボイス番号を顧客に確認中　");

      await asUser(ADMIN_ID);
      const holds = await client.query(
        `select r.reason, r.reviewer_id, s.display_name, r.created_at is not null as has_time
         from public.human_reviews r join public.staff_members s on s.user_id = r.reviewer_id
         where r.ai_decision_id = $1 and r.action = 'hold'`,
        [decisionId],
      );
      // 前後の空白は除いて記録する
      expect(holds.rows).toEqual([
        { reason: "インボイス番号を顧客に確認中", reviewer_id: STAFF_ID, display_name: expect.any(String), has_time: true },
      ]);
      const bulk = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, true)", [decisionId]);
      expect(bulk).toMatch(/保留中の明細はまとめて承認できません/);
      await review(decisionId, "approve");
      expect((await client.query("select status from public.bank_transactions where id = $1", [txnId])).rows[0]).toEqual({ status: "approved" });
      const actions = await client.query("select action, reviewer_id from public.human_reviews where ai_decision_id = $1 order by created_at, action desc", [decisionId]);
      expect(actions.rows.map((r) => r.action).sort()).toEqual(["approve", "hold"]);
    }));

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
      expect(row.rows[0]).toMatchObject({ action: "approve", reviewer_id: ADMIN_ID, bulk: true, review_seconds: 7 });
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

  it("担当者は承認・修正・却下ができず、保留だけできる", () =>
    inTx(async () => {
      const { txnId, decisionId } = await setup("high", PROPOSAL, STAFF_ID);
      for (const [action, entry] of [["approve", null], ["correct", JSON.stringify({ ...PROPOSAL, account_item_id: 102 })], ["reject", null]] as const) {
        const message = await expectQueryError(client, "select public.record_human_review($1, $2, $3, null, 1, false)", [decisionId, action, entry]);
        expect(message).toMatch(/承認者（管理者）だけ/);
      }
      await review(decisionId, "hold");
      expect((await client.query("select status from public.bank_transactions where id = $1", [txnId])).rows[0]).toEqual({ status: "on_hold" });
    }));

  it("保留中の明細はまとめて承認できない（1件ずつなら承認できる）", () =>
    inTx(async () => {
      const { decisionId } = await setup();
      await review(decisionId, "hold");
      const message = await expectQueryError(client, "select public.record_human_review($1, 'approve', null, null, 1, true)", [decisionId]);
      expect(message).toMatch(/保留中の明細はまとめて承認できません/);
      await review(decisionId, "approve");
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
