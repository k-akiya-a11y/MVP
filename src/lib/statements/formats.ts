/**
 * 明細 CSV の形式。銀行・カード会社ごとに列の並びが違うので、見出し名で列を探す。
 * 新しい銀行・カード会社に対応するときは、ここに形式を1つ足す。
 */
/** 口座の種類（wallets.kind） */
export type WalletKind = "bank_account" | "credit_card" | "wallet";

export type StatementCsvFormat = {
  id: string;
  label: string;
  /** この形式で取り込める口座の種類。違う種類の口座を選んだら取り込まない（銀行明細をカードの口座に入れない） */
  walletKind: WalletKind;
  encoding: "utf-8" | "shift_jis";
  /** 列の見出し候補（最初に見つかったものを使う） */
  columns: {
    date: string[];
    description: string[];
    /** 出金・入金が別の列のとき */
    withdrawal?: string[];
    deposit?: string[];
    /** 1つの列で符号付き（正 = 出金）のとき。カード明細の利用金額など */
    signedAmount?: string[];
    balance?: string[];
  };
};

export const STATEMENT_CSV_FORMATS: readonly StatementCsvFormat[] = [
  {
    id: "bank_generic",
    label: "銀行（日付・摘要・出金・入金・残高）",
    walletKind: "bank_account",
    encoding: "shift_jis",
    columns: {
      date: ["日付", "取引日", "年月日", "お取引日"],
      description: ["摘要", "お取引内容", "内容", "取引内容", "お振込人名"],
      withdrawal: ["出金", "出金額", "お支払金額", "支払金額", "引出額"],
      deposit: ["入金", "入金額", "お預り金額", "預入金額", "預入額"],
      balance: ["残高", "差引残高"],
    },
  },
  {
    id: "card_generic",
    label: "クレジットカード（利用日・利用店名・利用金額）",
    walletKind: "credit_card",
    encoding: "shift_jis",
    columns: {
      date: ["利用日", "ご利用日", "日付"],
      description: ["利用店名", "ご利用店名", "利用先", "ご利用先", "摘要"],
      signedAmount: ["利用金額", "ご利用金額", "金額"],
    },
  },
];

export function findStatementFormat(id: string): StatementCsvFormat | undefined {
  return STATEMENT_CSV_FORMATS.find((f) => f.id === id);
}
