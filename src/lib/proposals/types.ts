/** 機能①（明細 → 仕訳候補）で共通に使う型。DB の列名ではなくアプリ内の表記 */

export type Direction = "income" | "expense";

/** 仕訳の中身（freee の取引1行分）。ID はすべて freee マスタの ID */
export type JournalEntryFields = {
  accountItemId: number;
  taxCode: number;
  partnerId: number | null;
  itemId: number | null;
  sectionId: number | null;
  tagIds: number[];
  description: string;
};

export type BankTransaction = {
  id: string;
  customerId: string;
  walletId: string;
  txnDate: string;
  amount: number;
  direction: Direction;
  description: string;
};

export type Customer = {
  id: string;
  name: string;
  taxMethod: "general" | "simplified" | "exempt";
  invoiceRegistered: boolean;
  lowConfidenceAmountThreshold: number;
};

export type MasterKind = "account_item" | "partner" | "item" | "section" | "tag" | "tax";

export type MasterEntry = {
  kind: MasterKind;
  id: number;
  name: string;
  /** 科目の既定税区分 */
  defaultTaxCode?: number;
  /** 固定資産になり得る科目 */
  fixedAsset?: boolean;
};

export type RuleVersion = {
  ruleId: string;
  version: number;
  priority: number;
  createdAt: string;
  cond: {
    partnerKey: string | null;
    descriptionKeyword: string | null;
    amountMin: number | null;
    amountMax: number | null;
    walletId: string | null;
    direction: Direction | null;
  };
  action: JournalEntryFields & { descriptionTemplate: string | null };
  validFrom: string | null;
  validTo: string | null;
};

export type NoteVersion = { noteId: string; version: number; title: string; body: string };

export type PastEntry = {
  id: string;
  entryDate: string;
  amount: number;
  direction: Direction;
  bankDescription: string | null;
  partnerKey: string | null;
  entry: JournalEntryFields;
};
