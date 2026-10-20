/**
 * 銀行摘要・取引先名の正規化（設計書6章）。
 * 全角半角とカナを統一し、法人格の略号・取引種別の語・数字・記号を取り除いて「取引先キー」を作る。
 */

const SMALL_KANA: Record<string, string> = {
  ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ",
  ッ: "ツ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ヮ: "ワ", ヵ: "カ", ヶ: "ケ",
};

/** NFKC（半角カナ → 全角、全角英数 → 半角）、ひらがな → カタカナ、小書きカナ → 大きいカナ、英字は大文字 */
export function normalizeText(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[ァィゥェォッャュョヮヵヶ]/g, (c) => SMALL_KANA[c] ?? c)
    .replace(/[ー－‐−-]/g, "-")
    .toUpperCase();
}

// 法人格（銀行の略号と正式表記）。長いものから順に除く
const LEGAL_FORMS = [
  "カブシキガイシヤ", "ユウゲンガイシヤ", "ゴウドウガイシヤ", "ゴウシガイシヤ", "ゴウメイガイシヤ",
  "イツパンシヤダンホウジン", "イツパンザイダンホウジン", "シヤダンホウジン", "ザイダンホウジン",
  "イリヨウホウジン", "ガツコウホウジン", "シヤカイフクシホウジン", "トクテイヒエイリカツドウホウジン",
  "株式会社", "有限会社", "合同会社", "合資会社", "合名会社",
  "一般社団法人", "一般財団法人", "医療法人", "学校法人", "社会福祉法人", "特定非営利活動法人", "NPO法人",
];
// 略号: (カ) カ) (カ (ユ) ユ) (ド) (シヤ) (イ) など。括弧の片側だけの表記も多い
const LEGAL_ABBR = /\((?:カ|ユ|ド|ゴ|シ|メ|シヤ|ザイ|イ|ガク|フク|トクヒ|株|有|同)\)|\((?:カ|ユ|ド|シヤ|ザイ|イ|株|有|同)(?=$|[^ァ-ヴ])|(?:^|(?<=[^ァ-ヴ]))(?:カ|ユ|ド|シヤ|ザイ|イ)\)/g;

// 摘要の先頭に付く取引種別の語（振込・振替・口座振替・デビット・カード）
const TXN_TYPE_PREFIX = /^(?:フリコミ|フリカエ|ジドウフリカエ|コウフリ|デビツト|カ-ド|VISA|JCB|振込|振替|口座振替)\s*/;

/**
 * 取引先キー。例: "ｶ)ｻﾝﾌﾟﾙﾌﾄﾞｳｻﾝ" → "サンプルフドウサン"、"ﾌﾘｺﾐ ﾃｽﾄｺｷｬｸ(ｶ" → "テストコキヤク"
 * 何も残らなければ null（キーなしは新規取引先と同じ扱い）。
 */
export function partnerKey(raw: string): string | null {
  let s = normalizeText(raw).trim();
  s = s.replace(TXN_TYPE_PREFIX, "");
  s = s.replace(LEGAL_ABBR, " ");
  for (const form of LEGAL_FORMS) s = s.split(form).join(" ");
  // 日付・番号・記号・空白を除く（文字だけ残す）
  s = s.replace(/[^\p{L}]/gu, "");
  return s.length > 0 ? s : null;
}

/** 文字 bigram の Dice 係数（0〜1）。短いキーの表記揺れの吸収に使う */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}
