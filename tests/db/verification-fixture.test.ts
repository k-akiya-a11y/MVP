import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import { decodeStatement, parseStatementCsv } from "@/lib/statements/parse";
import { findStatementFormat } from "@/lib/statements/formats";
import { searchPastEntries } from "@/lib/retrieval/search";
import { matchRule } from "@/lib/rules/match";
import { CAUTION_WORDS } from "@/lib/confidence/compute";
import { normalizeText } from "@/lib/retrieval/normalize";
import type { BankTransaction, PastEntry, RuleVersion } from "@/lib/proposals/types";
import { CUSTOMER_A, STAFF_ID, connect } from "./helpers";

/**
 * 仕訳精度の検証データ（tests/fixtures/verification）が、README の期待結果どおりに
 * 過去仕訳・ルールに当たることを確かめる。AI は呼ばない（確信度の計算の入力までを固定する）。
 * seed には入れないデータなので、トランザクションの中で適用して最後に戻す。
 */
const DIR = "tests/fixtures/verification";
const CUSTOMER_V = "10000000-0000-4000-8000-000000000003";
const WALLET_V_BANK = "20000000-0000-4000-8000-000000000003";
const WALLET_V_CARD = "20000000-0000-4000-8000-000000000004";

let client: Client;

beforeAll(async () => {
  client = await connect();
  await client.query("begin");
  await client.query(readFileSync(`${DIR}/verification_customer.sql`, "utf8"));
});

afterAll(async () => {
  await client.query("rollback");
  await client.end();
});

function loadCsv(file: string, formatId: string, walletId: string): BankTransaction[] {
  const format = findStatementFormat(formatId)!;
  const parsed = parseStatementCsv(decodeStatement(new Uint8Array(readFileSync(`${DIR}/${file}`)), format.encoding), format);
  expect(parsed.errors).toEqual([]);
  return parsed.rows.map((r, i) => ({
    id: `${formatId}-${i}`,
    customerId: CUSTOMER_V,
    walletId,
    txnDate: r.txnDate,
    amount: r.amount,
    direction: r.direction,
    description: r.description,
  }));
}

async function loadPast(): Promise<PastEntry[]> {
  const res = await client.query(
    `select id, entry_date::text, amount::int, direction, bank_description, partner_key,
            account_item_id::int, tax_code, partner_id::int, item_id::int, section_id::int, tag_ids::int[], description
     from public.past_journal_entries where customer_id = $1`,
    [CUSTOMER_V],
  );
  return res.rows.map((r) => ({
    id: r.id,
    entryDate: r.entry_date,
    amount: r.amount,
    direction: r.direction,
    bankDescription: r.bank_description,
    partnerKey: r.partner_key,
    entry: {
      accountItemId: r.account_item_id,
      taxCode: r.tax_code,
      partnerId: r.partner_id,
      itemId: r.item_id,
      sectionId: r.section_id,
      tagIds: r.tag_ids,
      description: r.description,
    },
  }));
}

async function loadRules(): Promise<RuleVersion[]> {
  const res = await client.query(
    `select rule_id, version, priority, created_at::text, cond_partner_key, cond_description_keyword,
            cond_amount_min::int, cond_amount_max::int, cond_wallet_id, cond_direction,
            account_item_id::int, tax_code, partner_id::int, item_id::int, section_id::int, tag_ids::int[],
            description_template, valid_from::text, valid_to::text
     from public.current_journal_rules where customer_id = $1 and status = 'active'`,
    [CUSTOMER_V],
  );
  return res.rows.map((r) => ({
    ruleId: r.rule_id,
    version: r.version,
    priority: r.priority,
    createdAt: r.created_at,
    cond: {
      partnerKey: r.cond_partner_key,
      descriptionKeyword: r.cond_description_keyword,
      amountMin: r.cond_amount_min,
      amountMax: r.cond_amount_max,
      walletId: r.cond_wallet_id,
      direction: r.cond_direction,
    },
    action: {
      accountItemId: r.account_item_id,
      taxCode: r.tax_code,
      partnerId: r.partner_id,
      itemId: r.item_id,
      sectionId: r.section_id,
      tagIds: r.tag_ids,
      description: "",
      descriptionTemplate: r.description_template,
    },
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));
}

describe("検証用顧客のデータ", () => {
  it("SQL を適用すると、顧客・口座2つ・過去仕訳19件・ルール1つ・メモ1つができる", async () => {
    const counts = await client.query<{ wallets: string; past: string; rules: string; notes: string; masters: string }>(
      `select (select count(*) from public.wallets where customer_id = $1) as wallets,
              (select count(*) from public.past_journal_entries where customer_id = $1) as past,
              (select count(*) from public.current_journal_rules where customer_id = $1 and status = 'active') as rules,
              (select count(*) from public.current_customer_notes where customer_id = $1 and status = 'active') as notes,
              (select count(*) from public.freee_masters where customer_id = $1) as masters`,
      [CUSTOMER_V],
    );
    expect(counts.rows[0]).toEqual({ wallets: "2", past: "19", rules: "1", notes: "1", masters: "23" });
  });

  it("二度適用しても失敗せず、行も増えない", async () => {
    await client.query("savepoint twice");
    await client.query(readFileSync(`${DIR}/verification_customer.sql`, "utf8"));
    const res = await client.query("select count(*) as n from public.past_journal_entries where customer_id = $1", [CUSTOMER_V]);
    expect(res.rows[0]!.n).toBe("19");
    await client.query("rollback to savepoint twice");
  });

  it("サンプル商事だけを担当する担当者には見えない（過去仕訳の検索にも混ざらない）", async () => {
    await client.query("savepoint staff");
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [STAFF_ID]);
    await client.query("set local role authenticated");
    const customers = await client.query<{ id: string }>("select id from public.customers order by id");
    expect(customers.rows.map((r) => r.id)).toEqual([CUSTOMER_A]);
    const past = await client.query("select count(*) as n from public.past_journal_entries where customer_id = $1", [CUSTOMER_V]);
    expect(past.rows[0]!.n).toBe("0");
    await client.query("rollback to savepoint staff");
  });

  it("銀行 CSV の8件が、README の期待結果どおりの過去仕訳・ルールに当たる", async () => {
    const txns = loadCsv("bank_generic_sjis.csv", "bank_generic", WALLET_V_BANK);
    const past = await loadPast();
    const rules = await loadRules();
    expect(txns).toHaveLength(8);
    const summary = txns.map((t) => {
      const p = searchPastEntries(t, past);
      const caution = CAUTION_WORDS.filter((w) => normalizeText(t.description).includes(w));
      return {
        date: t.txnDate,
        amount: t.amount,
        direction: t.direction,
        rule: matchRule(t, rules)?.ruleId ?? null,
        match: p.matchType,
        total: p.total,
        majority: p.majority ? `${p.majority.accountItemId}:${p.majority.taxCode}` : null,
        share: p.majority?.share ?? null,
        inRange: p.amountRange ? t.amount >= p.amountRange.min && t.amount <= p.amountRange.max : null,
        exampleTags: p.examples.map((e) => e.entry.tagIds.join(",")),
        exampleItems: p.examples.map((e) => e.entry.itemId),
        caution,
      };
    });
    const rule = "30000000-0000-4000-8000-000000000002";
    expect(summary).toEqual([
      // B1 家賃: 過去3件、タグ 501 付き → 中
      { date: "2026-10-01", amount: 165000, direction: "expense", rule: null, match: "exact", total: 3, majority: "105:21", share: 1, inRange: true, exampleTags: ["501", "501", "501"], exampleItems: [null, null, null], caution: [] },
      // B2 クラウド: 過去6件・一致率100%・範囲内、品目 601 → 高
      { date: "2026-10-05", amount: 5500, direction: "expense", rule: null, match: "exact", total: 6, majority: "101:21", share: 1, inRange: true, exampleTags: ["", "", "", "", ""], exampleItems: [601, 601, 601, 601, 601], caution: [] },
      // B3 電気: 過去3件、タグ・品目なし → 中
      { date: "2026-10-10", amount: 12340, direction: "expense", rule: null, match: "exact", total: 3, majority: "109:21", share: 1, inRange: true, exampleTags: ["", "", ""], exampleItems: [null, null, null], caution: [] },
      // B4 ATM: 過去2件 → 中
      { date: "2026-10-15", amount: 110, direction: "expense", rule: null, match: "exact", total: 2, majority: "104:21", share: 1, inRange: true, exampleTags: ["", ""], exampleItems: [null, null], caution: [] },
      // B5 立替: 要注意語 → 低
      { date: "2026-10-20", amount: 5000, direction: "expense", rule: null, match: "none", total: 0, majority: null, share: null, inRange: null, exampleTags: [], exampleItems: [], caution: ["タテカエ"] },
      // B6 通信: ルール一致 → 高（AI を呼ばない）
      { date: "2026-10-27", amount: 9020, direction: "expense", rule, match: "none", total: 0, majority: null, share: null, inRange: null, exampleTags: [], exampleItems: [], caution: [] },
      // B7 業務委託料: 過去2件、上限額未満 → 中
      { date: "2026-10-31", amount: 220000, direction: "income", rule: null, match: "exact", total: 2, majority: "106:31", share: 1, inRange: true, exampleTags: ["", ""], exampleItems: [null, null], caution: [] },
      // B8 新規取引先 → 低
      { date: "2026-10-31", amount: 50000, direction: "income", rule: null, match: "none", total: 0, majority: null, share: null, inRange: null, exampleTags: [], exampleItems: [], caution: [] },
    ]);
  });

  it("カード CSV の4件が、README の期待結果どおりの過去仕訳に当たる", async () => {
    const txns = loadCsv("card_generic_sjis.csv", "card_generic", WALLET_V_CARD);
    const past = await loadPast();
    const rules = await loadRules();
    expect(txns).toHaveLength(4);
    const summary = txns.map((t) => {
      const p = searchPastEntries(t, past);
      return { date: t.txnDate, amount: t.amount, rule: matchRule(t, rules)?.ruleId ?? null, match: p.matchType, total: p.total, majority: p.majority ? `${p.majority.accountItemId}:${p.majority.taxCode}` : null };
    });
    expect(summary).toEqual([
      // C1 書店: 過去3件 → 中
      { date: "2026-10-03", amount: 2750, rule: null, match: "exact", total: 3, majority: "110:21" },
      // C2〜C4 新規取引先 → 低
      { date: "2026-10-08", amount: 3980, rule: null, match: "none", total: 0, majority: null },
      { date: "2026-10-12", amount: 132000, rule: null, match: "none", total: 0, majority: null },
      { date: "2026-10-18", amount: 1200, rule: null, match: "none", total: 0, majority: null },
    ]);
  });
});
