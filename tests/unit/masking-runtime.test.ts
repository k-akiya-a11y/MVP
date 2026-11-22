import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// 修正前の期待（docs/reviews/2026-11-05-masking-runtime.md）。数字はすべて架空の固定値。
// 実際の src/lib/ai/mask.ts を TypeScript で変換し、node:vm の中で実行する（正規表現の写しは使わない）。
// 1回の呼出しに 2 秒の上限を付け、超えたらその呼出しだけを打ち切って失敗にする。
// 速度の細かい比較（ミリ秒の微細な計測）はしない。判定は「上限内に終わるか」と「結果が完全に一致するか」だけ。
const CALL_LIMIT_MS = 2000;
const LONG = 200_000;
// 修正前は 1 件ごとに上限（2 秒）まで待つため、vitest 側の時間切れはその数倍にしておく。
const TEST_LIMIT_MS = 20_000;

// 変換は時間の計測の外で 1 回だけ行う。mask.ts は import を持たないので、そのまま実行できる。
const compiled = ts.transpileModule(readFileSync(join(process.cwd(), "src/lib/ai/mask.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const context = vm.createContext({ exports: {}, input: "" });
vm.runInContext(compiled, context);

function runMask(text: string): string {
  context.input = text;
  try {
    return vm.runInContext("exports.maskSensitive(input)", context, { timeout: CALL_LIMIT_MS }) as string;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
      throw new Error(`maskSensitive が ${CALL_LIMIT_MS}ms 以内に終わらなかった（入力 ${text.length} 文字）`);
    }
    throw error;
  }
}

const star = (token: string) => "*".repeat(token.length);

// 20万文字の比較結果を toBe の差分表示に出さないため、長さと一致を別々に確認する。
function expectExactly(actual: string, expected: string) {
  expect(actual.length).toBe(expected.length);
  expect(actual === expected).toBe(true);
}

describe("maskSensitive: 短い通常の文章は変えない・既存の伏せ方は保つ（VM 上の実コード）", () => {
  it.each(["10/03 12345", "3名 1,234円", "No.12345", "（株）ゆいの", "第(1)(2)条", "TEL(1234)", "03(12)", "支払\n10/03\n12345", "1\t2\t3", ""])(
    "%j は変更なし",
    (text) => {
      expect(runMask(text)).toBe(text);
    },
  );

  it.each(["090(1234)5678", "090（1234）5678", "０９０（１２３４）５６７８", "03(1234)5678"])("括弧区切りの電話番号 %j は同じ長さの * にし、前後は残す", (phone) => {
    expect(runMask(`電話${phone}まで`)).toBe(`電話${star(phone)}まで`);
    expect(runMask(`10/03 12345 ${phone}`)).toBe(`10/03 12345 ${star(phone)}`);
  });

  it("既存の規則（ハイフン区切り・連続7桁以上・空白区切りのカード番号）の結果は変わらない", () => {
    expect(runMask("03-1234-5678")).toBe(star("03-1234-5678"));
    expect(runMask("口座1234567")).toBe(`口座${star("1234567")}`);
    expect(runMask("口座１２３４５６７")).toBe(`口座${star("１２３４５６７")}`);
    expect(runMask("4111 1111 1111 1111で")).toBe(`${star("4111 1111 1111 1111")}で`);
  });
});

describe("maskSensitive: 長い数字でも 1 回 2 秒以内に終わり、結果は正確（VM 上の実コード）", () => {
  const ascii = "1".repeat(LONG);
  const full = "１".repeat(LONG);

  it("開き括弧のない 20 万桁の半角数字は全部伏せる", { timeout: TEST_LIMIT_MS }, () => {
    expectExactly(runMask(ascii), star(ascii));
  });

  it("開き括弧のない 20 万桁の全角数字は全部伏せる", { timeout: TEST_LIMIT_MS }, () => {
    expectExactly(runMask(full), star(full));
  });

  it("前後の文字は変えず、数字の部分だけ伏せる", { timeout: TEST_LIMIT_MS }, () => {
    expectExactly(runMask(`摘要${ascii}終わり`), `摘要${star(ascii)}終わり`);
  });

  it.each([
    ["閉じ括弧がない", "(1234", "x"],
    ["閉じ括弧がない（全角）", "（1234", "x"],
    ["括弧内が5桁で閉じられない", "(12345)", "6789"],
    ["後ろの数字が3桁で足りない", "(1234)", "567"],
    ["後ろの数字が3桁で足りない（全角）", "（１２３４）", "５６７"],
    ["括弧内が空", "()", "5678"],
  ])("20 万桁のあとに近い形（%s）が続いても、数字の塊だけ伏せて残りは変えない", { timeout: TEST_LIMIT_MS }, (_name, bracket, suffix) => {
    expectExactly(runMask(`${ascii}${bracket}${suffix}`), `${star(ascii)}${bracket}${suffix}`);
  });

  it("20 万桁の全角数字のあとに、後ろが足りない括弧が続いても同様", { timeout: TEST_LIMIT_MS }, () => {
    expectExactly(runMask(`${full}（１２３４）５６７`), `${star(full)}（１２３４）５６７`);
  });

  it("20 万桁のあとに正しい括弧区切りの続きがあれば、続きも含めて全部伏せる", { timeout: TEST_LIMIT_MS }, () => {
    const phone = `${ascii}(1234)5678`;
    expectExactly(runMask(phone), star(phone));
    const fullPhone = `${full}（１２３４）５６７８`;
    expectExactly(runMask(fullPhone), star(fullPhone));
  });

  it("括弧のない長い数字の前後に通常の短い文章があっても、その文章は変えない", { timeout: TEST_LIMIT_MS }, () => {
    expectExactly(runMask(`10/03 12345 ${ascii} TEL(1234) 03(12)`), `10/03 12345 ${star(ascii)} TEL(1234) 03(12)`);
  });
});
