import { describe, expect, it } from "vitest";
import { maskSensitive } from "@/lib/ai/mask";
import { buildJournalPrompt } from "@/lib/ai/prompt";
import { searchPastEntries } from "@/lib/retrieval/search";
import { sampleContext, txn } from "../fixtures/proposal-context";

// 修正前の期待（docs/reviews/2026-11-05-masking-separators.md）。数字はすべて架空の固定値。
// 特定した番号は、数字だけでなく区切り（括弧・タブ・改行・空白）も含めて同じ長さの * にする
// （既存のハイフン区切り・空白区切りと同じ「元の長さを保つ」方式）。
const star = (token: string) => "*".repeat(token.length);

const PHONE_ASCII = "090(1234)5678";
const PHONE_FULL = "090（1234）5678";
const PHONE_FULL_DIGITS = "０９０（１２３４）５６７８";
const PHONE_AREA = "03(1234)5678";

const CARD_TAB = "4111\t1111\t1111\t1111";
const CARD_NEWLINE = "4111\n1111\n1111\n1111";
const CARD_CRLF = "4111\r\n1111\r\n1111\r\n1111";
const CARD_MULTI_SPACE = "4111  1111   1111 1111";
const CARD_NBSP = "4111 1111 1111 1111";
const CARD_MIXED = "4111 \t1111 \n1111  1111";
const CARD_FULL_TAB = "４１１１\t１１１１\t１１１１\t１１１１";

const PHONES = [PHONE_ASCII, PHONE_FULL, PHONE_FULL_DIGITS, PHONE_AREA];
const CARDS = [CARD_TAB, CARD_NEWLINE, CARD_CRLF, CARD_MULTI_SPACE, CARD_NBSP, CARD_MIXED, CARD_FULL_TAB];

describe("maskSensitive: 括弧・タブ・改行・複数空白・NBSP 区切りの番号", () => {
  it.each(PHONES)("電話番号 %j は括弧も含めすべて伏せ、前後の日本語は残す", (phone) => {
    expect(maskSensitive(`電話${phone}まで`)).toBe(`電話${star(phone)}まで`);
    expect(maskSensitive(phone)).toBe(star(phone));
    expect(maskSensitive(phone)).not.toMatch(/[0-9０-９]/);
  });

  it.each(CARDS)("カード番号 %j は区切りも含めすべて伏せ、前後の日本語は残す", (card) => {
    expect(maskSensitive(`カード${card}で支払`)).toBe(`カード${star(card)}で支払`);
    expect(maskSensitive(card)).toBe(star(card));
    expect(maskSensitive(card)).not.toMatch(/[0-9０-９]/);
  });

  it("1つの文に複数あっても、それぞれ別の番号として伏せる", () => {
    const text = `${PHONE_ASCII} と ${CARD_TAB} と ${PHONE_FULL}`;
    expect(maskSensitive(text)).toBe(`${star(PHONE_ASCII)} と ${star(CARD_TAB)} と ${star(PHONE_FULL)}`);
  });

  it("既存の伏せ方（連続・ハイフン・空白1つ）は変えない", () => {
    expect(maskSensitive("7654321")).toBe("*******");
    expect(maskSensitive("765-4321")).toBe("********");
    expect(maskSensitive("4111 1111 1111 1111")).toBe(star("4111 1111 1111 1111"));
    expect(maskSensitive("４１１１　１１１１　１１１１　１１１１")).toBe(star("４１１１　１１１１　１１１１　１１１１"));
  });

  it("普通の短い数字・日付・括弧・通常の改行は変えない", () => {
    const keep = [
      "10/03 12345",
      "10/03 12345 振込",
      "（株）ｻﾝﾌﾟﾙ 3名 1,234円",
      "第(1)(2)条",
      "TEL(1234)",
      "03(12)",
      "支払\n10/03\n12345",
      "1\t2\t3",
      "No.12345",
    ];
    for (const s of keep) expect(maskSensitive(s)).toBe(s);
  });

  it("番号の隣にある普通の短い数字だけを残す", () => {
    expect(maskSensitive(`10/03 12345 ${PHONE_ASCII}`)).toBe(`10/03 12345 ${star(PHONE_ASCII)}`);
    expect(maskSensitive(`${CARD_NEWLINE}\n10/03 12345`)).toBe(`${star(CARD_NEWLINE)}\n10/03 12345`);
  });
});

// ---- buildJournalPrompt 全体 ----

type Sent = {
  transaction: { date: string; amount: number; direction: string; wallet: string; description: string };
  masters: Record<string, { id: number; name: string; defaultTaxCode?: number; fixedAsset?: true }[]>;
  notes: { title: string; body: string }[];
  past: {
    total: number;
    combos: unknown[];
    amountRange: unknown;
    examples: { entryDate: string; amount: number; bankDescription: string | null; entry: Record<string, unknown> & { description: string } }[];
  };
};

function userContent(p: ReturnType<typeof buildJournalPrompt>): string {
  const content = p.messages[0]?.content;
  if (typeof content !== "string") throw new Error("user content は文字列のはず");
  return content;
}

/** 自由記述を除いた構造化項目（金額・日付・ID・件数）だけを取り出す */
function structure(s: Sent) {
  return {
    transaction: { date: s.transaction.date, amount: s.transaction.amount, direction: s.transaction.direction },
    masters: Object.fromEntries(
      Object.entries(s.masters).map(([k, v]) => [k, v.map(({ id, defaultTaxCode, fixedAsset }) => ({ id, defaultTaxCode, fixedAsset }))]),
    ),
    past: {
      total: s.past.total,
      combos: s.past.combos,
      amountRange: s.past.amountRange,
      examples: s.past.examples.map((e) => ({
        entryDate: e.entryDate,
        amount: e.amount,
        entry: Object.fromEntries(Object.entries(e.entry).filter(([k]) => k !== "description")),
      })),
    },
  };
}

describe("AI に送る内容: 括弧・タブ・改行・複数空白・NBSP 区切りの番号（buildJournalPrompt）", () => {
  const ctx = sampleContext();
  const base = txn();

  const build = (secret: boolean) => {
    const t = secret ? { ...base, description: `${base.description} ${PHONE_FULL}` } : base;
    const pastEntries = ctx.pastEntries.map((p) =>
      secret
        ? {
            ...p,
            bankDescription: `${p.bankDescription ?? ""} ${CARD_NBSP}`,
            entry: { ...p.entry, description: `口座メモ ${PHONE_ASCII}` },
          }
        : p,
    );
    const masters = ctx.masters.map((m) => (secret && m.kind === "partner" ? { ...m, name: `${m.name}（${CARD_MULTI_SPACE}）` } : m));
    const notes = secret
      ? [
          ...ctx.notes,
          { noteId: "n-secret", version: 1, title: `連絡先${PHONE_FULL_DIGITS}`, body: `カード${CARD_NEWLINE}は社長個人のもの 10/03 12345` },
          { noteId: "n-secret2", version: 1, title: "別メモ", body: `ｶｰﾄﾞ ${CARD_TAB} / ${PHONE_AREA}` },
        ]
      : ctx.notes;
    const past = searchPastEntries(t, pastEntries);
    expect(past.examples.length).toBeGreaterThan(0);
    const prompt = buildJournalPrompt({
      customer: ctx.customer,
      masters,
      notes,
      txn: t,
      walletName: secret ? `サンプル銀行 普通 ${CARD_CRLF}` : "サンプル銀行 普通",
      past,
    });
    return userContent(prompt);
  };

  it("各自由記述の番号は、元の長さの * に置き換わり、原文も断片も残らない", () => {
    const raw = build(true);
    const sent = JSON.parse(raw) as Sent;

    expect(sent.transaction.description).toBe(`${base.description} ${star(PHONE_FULL)}`);
    expect(sent.transaction.wallet).toBe(`サンプル銀行 普通 ${star(CARD_CRLF)}`);

    const partners = sent.masters.partner ?? [];
    expect(partners.length).toBeGreaterThan(0);
    for (const p of partners) expect(p.name).toMatch(new RegExp(`（\\*{${CARD_MULTI_SPACE.length}}）$`));
    expect(partners.find((p) => p.id === 301)?.name).toBe(`サンプル通信株式会社（${star(CARD_MULTI_SPACE)}）`);

    expect(sent.notes).toContainEqual({ title: `連絡先${star(PHONE_FULL_DIGITS)}`, body: `カード${star(CARD_NEWLINE)}は社長個人のもの 10/03 12345` });
    expect(sent.notes).toContainEqual({ title: "別メモ", body: `ｶｰﾄﾞ ${star(CARD_TAB)} / ${star(PHONE_AREA)}` });

    expect(sent.past.examples.length).toBeGreaterThan(0);
    for (const e of sent.past.examples) {
      expect(e.bankDescription).toBe(`サンプルフドウサン ${star(CARD_NBSP)}`);
      expect(e.entry.description).toBe(`口座メモ ${star(PHONE_ASCII)}`);
    }

    // 原文そのもの（JSON 上のエスケープ表記も）と、数字の断片が一切残らない
    const secrets = [PHONE_ASCII, PHONE_FULL, PHONE_FULL_DIGITS, PHONE_AREA, CARD_TAB, CARD_NEWLINE, CARD_CRLF, CARD_MULTI_SPACE, CARD_NBSP];
    for (const s of secrets) {
      expect(raw).not.toContain(s);
      expect(raw).not.toContain(JSON.stringify(s).slice(1, -1));
    }
    // 断片の確認は、番号を入れた項目（特定した番号の領域）だけに限る。
    // 意図して残す普通の短い数字 `10/03 12345` は、断片 `1234` を含むので、その部分だけ除いてから見る。
    const sensitiveFields = [
      sent.transaction.description,
      sent.transaction.wallet,
      ...partners.map((p) => p.name),
      ...sent.notes.filter((n) => n.title.startsWith("連絡先") || n.title === "別メモ").flatMap((n) => [n.title, n.body]),
      ...sent.past.examples.flatMap((e) => [e.bankDescription ?? "", e.entry.description]),
    ];
    const withoutOrdinary = (s: string) => s.replaceAll("10/03 12345", "");
    for (const field of sensitiveFields) {
      for (const fragment of ["090", "1234", "5678", "4111", "1111", "０９０", "１２３４", "５６７８"]) {
        expect(withoutOrdinary(field)).not.toContain(fragment);
      }
    }
  });

  it("金額・日付・入出金・マスタ ID・過去仕訳の ID/件数は、番号を含まない入力と同じまま", () => {
    const withSecret = JSON.parse(build(true)) as Sent;
    const without = JSON.parse(build(false)) as Sent;

    expect(withSecret.transaction.amount).toBe(base.amount);
    expect(withSecret.transaction.date).toBe(base.txnDate);
    expect(withSecret.transaction.direction).toBe("出金");
    expect(structure(withSecret)).toEqual(structure(without));
    // 普通の短い数字・日付は残る
    expect(withSecret.notes.some((n) => n.body.includes("10/03 12345"))).toBe(true);
  });
});
