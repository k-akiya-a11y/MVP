// 仕訳候補のテスト用の顧客コンテキスト（すべて架空。supabase/seed と同じ値）
import type { CustomerContext } from "@/lib/proposals/propose";
import type { BankTransaction, PastEntry } from "@/lib/proposals/types";

export const CUSTOMER_ID = "10000000-0000-4000-8000-000000000001";
export const BANK_WALLET = "20000000-0000-4000-8000-000000000001";

function past(i: number, partnerKey: string, amount: number, accountItemId: number, taxCode: number, direction: "income" | "expense" = "expense"): PastEntry {
  return {
    id: `p-${partnerKey}-${i}`,
    entryDate: `2026-${String(1 + (i % 9)).padStart(2, "0")}-27`,
    amount,
    direction,
    bankDescription: partnerKey,
    partnerKey,
    entry: { accountItemId, taxCode, partnerId: null, itemId: null, sectionId: 401, tagIds: [], description: "" },
  };
}

export function sampleContext(): CustomerContext {
  return {
    customer: {
      id: CUSTOMER_ID,
      name: "サンプル商事株式会社",
      taxMethod: "general",
      invoiceRegistered: true,
      lowConfidenceAmountThreshold: 300000,
    },
    masters: [
      { kind: "account_item", id: 101, name: "通信費", defaultTaxCode: 21 },
      { kind: "account_item", id: 102, name: "消耗品費", defaultTaxCode: 21 },
      { kind: "account_item", id: 105, name: "地代家賃", defaultTaxCode: 21 },
      { kind: "account_item", id: 106, name: "売上高", defaultTaxCode: 31 },
      { kind: "account_item", id: 108, name: "工具器具備品", defaultTaxCode: 21, fixedAsset: true },
      { kind: "tax", id: 2, name: "対象外" },
      { kind: "tax", id: 21, name: "課対仕入10%" },
      { kind: "tax", id: 31, name: "課税売上10%" },
      { kind: "partner", id: 302, name: "サンプル不動産株式会社" },
      { kind: "section", id: 401, name: "本社" },
    ],
    activeRules: [
      {
        ruleId: "30000000-0000-4000-8000-000000000001",
        version: 1,
        priority: 10,
        createdAt: "2026-10-01T00:00:00Z",
        cond: { partnerKey: "サンプルツウシン", descriptionKeyword: null, amountMin: null, amountMax: null, walletId: null, direction: "expense" },
        action: {
          accountItemId: 101,
          taxCode: 21,
          partnerId: 301,
          itemId: null,
          sectionId: null,
          tagIds: [],
          description: "",
          descriptionTemplate: "{month}月分 通信料",
        },
        validFrom: null,
        validTo: null,
      },
    ],
    notes: [{ noteId: "31000000-0000-4000-8000-000000000001", version: 1, title: "代表者カードの私用分", body: "私用分は役員貸付金" }],
    pastEntries: [
      ...Array.from({ length: 6 }, (_, i) => past(i, "サンプルフドウサン", 165000, 105, 21)),
      ...Array.from({ length: 2 }, (_, i) => past(i, "テストコキヤク", 330000, 106, 31, "income")),
    ],
    walletNames: new Map([[BANK_WALLET, "サンプル銀行 本店 普通"]]),
  };
}

export function txn(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: "t-1",
    customerId: CUSTOMER_ID,
    walletId: BANK_WALLET,
    txnDate: "2026-10-30",
    amount: 165000,
    direction: "expense",
    description: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ",
    ...overrides,
  };
}
