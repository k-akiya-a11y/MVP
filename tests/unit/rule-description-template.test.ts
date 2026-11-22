import { describe, expect, it, vi } from "vitest";
import type { JournalAi } from "@/lib/ai/client";
import { toAiDecisionRow } from "@/lib/audit/decision-log";
import { proposeForTransaction } from "@/lib/proposals/propose";
import { renderDescriptionTemplate } from "@/lib/rules/match";
import { sampleContext, txn } from "../fixtures/proposal-context";

// 摘要の雛形に明細の摘要を入れるとき、摘要の文字をそのまま（$ を特殊記号として解釈せずに）入れる。
// 期待の記録: docs/reviews/2026-11-05-rule-description-literal.md（すべて架空の値・外部呼出しなし）

const TEMPLATE = "明細:{description}:終";

function render(template: string, description: string, txnDate = "2026-10-30"): string {
  return renderDescriptionTemplate(template, txn({ description, txnDate }));
}

describe("renderDescriptionTemplate: 摘要の記号をそのまま入れる", () => {
  it.each([
    ["$&（一致した文字列）", "A$&B"],
    ["$$（ドル記号）", "A$$B"],
    ["$`（一致箇所より前）", "A$`B"],
    ["$'（一致箇所より後）", "A$'B"],
    ["複数の記号の連続", "$$$&$$"],
    ["先頭と末尾の記号", "$&A$'"],
  ])("%s を含む摘要は1文字も変わらない", (_, description) => {
    expect(render(TEMPLATE, description)).toBe(`明細:${description}:終`);
  });

  it("$ に続く数字や名前も文字どおり残る（一致グループがない）", () => {
    for (const description of ["A$1B", "A$0B", "A$<x>B", "A$10B", "$"]) {
      expect(render(TEMPLATE, description), description).toBe(`明細:${description}:終`);
    }
  });

  it("バックスラッシュ・書式記号・正規表現の記号・波括弧もそのまま入る", () => {
    for (const description of ["A\\B", "100%s", "A.*B", "A{0}B", "^A(a)B[b]$", "A\\nB"]) {
      expect(render(TEMPLATE, description), description).toBe(`明細:${description}:終`);
    }
  });

  it("{description} が複数あっても、すべて摘要そのまま", () => {
    expect(render("{description}/{description}", "A$&B")).toBe("A$&B/A$&B");
    expect(render("{description}/{description}", "A$$B")).toBe("A$$B/A$$B");
    expect(render("{description}|{description}|{description}", "$'")).toBe("$'|$'|$'");
  });

  it("摘要が差込みの文字そのものでも、そのまま入る", () => {
    expect(render("{description}", "{description}$&")).toBe("{description}$&");
  });

  it("摘要の中の差込み風の文字は、再度は置換しない", () => {
    expect(render(TEMPLATE, "{year}年{month}月", "2026-03-05")).toBe("明細:{year}年{month}月:終");
    expect(render(TEMPLATE, "{description}{year}", "2026-03-05")).toBe("明細:{description}{year}:終");
    expect(render(TEMPLATE, "{description}$&{year}", "2026-03-05")).toBe("明細:{description}$&{year}:終");
  });

  it("雛形そのものの $ は文字のまま（摘要の置換の対象ではない）", () => {
    expect(render("$&{description}$$", "X")).toBe("$&X$$");
  });
});

describe("renderDescriptionTemplate: 従来どおりの動作", () => {
  it("{year} と {month} は取引日から入る。月は0埋めしない", () => {
    expect(render("{year}年{month}月分 {description}", "ﾃｽﾄ", "2026-03-05")).toBe("2026年3月分 ﾃｽﾄ");
    expect(render("{year}年{month}月分 {description}", "ﾃｽﾄ", "2026-11-05")).toBe("2026年11月分 ﾃｽﾄ");
  });

  it("{year} と {month} が繰り返されても、すべて置換する", () => {
    expect(render("{year}/{month}/{year}/{month}", "X", "2026-03-05")).toBe("2026/3/2026/3");
  });

  it("年月と摘要の記号を同時に使っても、年月は取引日どおり、摘要は文字どおり", () => {
    expect(render("{year}-{month} {description}", "A$&B$$", "2026-03-05")).toBe("2026-3 A$&B$$");
  });

  it("未知の差込み・大文字小文字違い・空白入りはそのまま残る", () => {
    expect(render("{unknown}{Description}{ description }{ month }{Year}", "X")).toBe(
      "{unknown}{Description}{ description }{ month }{Year}",
    );
  });

  it("未知の差込みはそのまま残り、摘要側は文字どおり入る", () => {
    expect(render("{unknown}:{description}", "A$&B")).toBe("{unknown}:A$&B");
  });

  it("空の雛形は空、差込みのない雛形は摘要を使わずそのまま", () => {
    expect(render("", "A$&B")).toBe("");
    expect(render("固定摘要", "A$&B")).toBe("固定摘要");
  });

  it("摘要が空なら、差込みの位置が空になるだけ", () => {
    expect(render("[{description}]", "")).toBe("[]");
  });
});

// ルールに一致した取引の提案と AI 判断ログ。AI は呼ばない（モック）。
function ruleContext(descriptionTemplate: string | null) {
  const ctx = sampleContext();
  const base = ctx.activeRules[0]!;
  // partnerKey() は文字以外（記号など）を取り除き、文字は正規化する。この fixture の摘要には英字 A/B も加えているので、
  // 取引先キー全体は fixture のものと変わり一致しない。そこで取引先キーの条件を外し、摘要の語句の条件で雛形のテストだけを切り出す
  ctx.activeRules = [
    {
      ...base,
      cond: { ...base.cond, partnerKey: null, descriptionKeyword: "ｻﾝﾌﾟﾙﾂｳｼﾝ" },
      action: { ...base.action, descriptionTemplate },
    },
  ];
  return ctx;
}

function noAi(): JournalAi & ReturnType<typeof vi.fn> {
  return vi.fn() as unknown as JournalAi & ReturnType<typeof vi.fn>;
}

describe("proposeForTransaction: ルールの摘要の雛形", () => {
  const RULE_USED = [{ ruleId: "30000000-0000-4000-8000-000000000001", version: 1 }];

  it("$& を含む摘要でも、提案の摘要と判断ログの摘要は文字どおり。元の明細は変わらず、AI は呼ばない", async () => {
    const original = txn({ description: "ｻﾝﾌﾟﾙﾂｳｼﾝ A$&B", amount: 9020, txnDate: "2026-10-27" });
    const input = { ...original };
    const ai = noAi();

    const draft = await proposeForTransaction(ruleContext(TEMPLATE), input, ai);
    const row = toAiDecisionRow(draft);

    expect(ai).not.toHaveBeenCalled();
    expect(draft.proposal).toEqual({
      accountItemId: 101,
      taxCode: 21,
      partnerId: 301,
      itemId: null,
      sectionId: null,
      tagIds: [],
      description: "明細:ｻﾝﾌﾟﾙﾂｳｼﾝ A$&B:終",
    });
    expect(row.proposal).toEqual({
      account_item_id: 101,
      tax_code: 21,
      partner_id: 301,
      item_id: null,
      section_id: null,
      tag_ids: [],
      description: "明細:ｻﾝﾌﾟﾙﾂｳｼﾝ A$&B:終",
    });

    // 元の取引は変えない（渡したオブジェクトも、判断ログに残る取引の写しも）
    expect(input).toEqual(original);
    expect(row.transaction_snapshot).toMatchObject({
      id: "t-1",
      description: "ｻﾝﾌﾟﾙﾂｳｼﾝ A$&B",
      amount: 9020,
      txnDate: "2026-10-27",
    });

    // ルールの版は従来どおり記録され、AI の項目は空
    expect(row.rule_versions_used).toEqual([{ rule_id: RULE_USED[0]!.ruleId, version: RULE_USED[0]!.version }]);
    expect(row.note_versions_used).toEqual([]);
    expect(row.ai_output).toBeNull();
    expect(row.ai_reason).toBeNull();
    expect(row.ai_unknowns).toEqual([]);
    expect(row.model).toBeNull();
    expect(row.prompt_version).toBeNull();
    expect(row.input_tokens).toBeNull();
    expect(row.output_tokens).toBeNull();
    expect(row.cost_usd_micros).toBeNull();
  });

  it.each([
    ["$$", "ｻﾝﾌﾟﾙﾂｳｼﾝ A$$B"],
    ["$`", "ｻﾝﾌﾟﾙﾂｳｼﾝ A$`B"],
    ["$'", "ｻﾝﾌﾟﾙﾂｳｼﾝ A$'B"],
  ])("%s を含む摘要でも、提案と判断ログの摘要は文字どおり", async (_, description) => {
    const ai = noAi();
    const draft = await proposeForTransaction(
      ruleContext(TEMPLATE),
      txn({ description, amount: 9020, txnDate: "2026-10-27" }),
      ai,
    );
    const row = toAiDecisionRow(draft);

    expect(ai).not.toHaveBeenCalled();
    expect(draft.proposal?.description).toBe(`明細:${description}:終`);
    expect(row.proposal?.description).toBe(`明細:${description}:終`);
    expect(row.transaction_snapshot.description).toBe(description);
    expect(draft.ruleVersionsUsed).toEqual(RULE_USED);
  });

  it("年月と摘要を同時に使う雛形でも、年月は取引日どおり、摘要は文字どおり", async () => {
    const draft = await proposeForTransaction(
      ruleContext("{year}年{month}月分 {description}"),
      txn({ description: "ｻﾝﾌﾟﾙﾂｳｼﾝ $&", amount: 9020, txnDate: "2026-10-27" }),
      noAi(),
    );
    expect(draft.proposal?.description).toBe("2026年10月分 ｻﾝﾌﾟﾙﾂｳｼﾝ $&");
  });

  it("雛形のないルールは、従来どおり明細の摘要をそのまま提案の摘要にする", async () => {
    const ai = noAi();
    const draft = await proposeForTransaction(
      ruleContext(null),
      txn({ description: "ｻﾝﾌﾟﾙﾂｳｼﾝ A$&B", amount: 9020, txnDate: "2026-10-27" }),
      ai,
    );
    expect(ai).not.toHaveBeenCalled();
    expect(draft.proposal?.description).toBe("ｻﾝﾌﾟﾙﾂｳｼﾝ A$&B");
    expect(draft.ruleVersionsUsed).toEqual(RULE_USED);
  });
});
