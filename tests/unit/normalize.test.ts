import { describe, expect, it } from "vitest";
import { normalizeText, partnerKey, similarity } from "@/lib/retrieval/normalize";

describe("partnerKey", () => {
  it.each([
    ["ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ", "サンプルフドウサン"],
    ["ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ", "サンプルツウシン"],
    ["ｻﾝﾌﾟﾙﾂｳｼﾝ(ｶ)", "サンプルツウシン"],
    ["ﾌﾘｺﾐ ﾃｽﾄｺｷｬｸ(ｶ", "テストコキヤク"],
    ["ﾌﾘｺﾐ ﾃｽﾄｺｷﾔｸ(ｶ", "テストコキヤク"],
    ["株式会社テスト顧客", "テスト顧客"],
    ["ｶﾌﾞｼｷｶﾞｲｼｬ ｻﾝﾌﾟﾙ", "サンプル"],
    ["ｱﾏｿﾞﾝ ｼﾞｬﾊﾟﾝ 10/03 12345", "アマゾンジヤパン"],
    ["ﾕ)ｻﾝﾌﾟﾙﾔ", "サンプルヤ"],
    ["さんぷる", "サンプル"],
  ])("%s → %s", (raw, expected) => {
    expect(partnerKey(raw)).toBe(expected);
  });

  it("文字が残らなければ null", () => {
    expect(partnerKey("12345 (ｶ)")).toBeNull();
  });

  it("名前の途中のカは消さない", () => {
    expect(partnerKey("ｶﾜｶﾐｼﾖｳｼﾞ")).toBe("カワカミシヨウジ");
  });
});

describe("normalizeText", () => {
  it("全角英数は半角、英字は大文字", () => {
    expect(normalizeText("ＡＴＭ　ｔｅｓｕ")).toBe("ATM TESU");
  });
});

describe("similarity", () => {
  it("表記揺れは高く、別の取引先は低い", () => {
    expect(similarity("サンプルツウシン", "サンプルツウシン")).toBe(1);
    expect(similarity("サンプルツウシン", "サンプルツウシンシヤ")).toBeGreaterThan(0.8);
    expect(similarity("サンプルツウシン", "テストコキヤク")).toBeLessThan(0.2);
  });
});
