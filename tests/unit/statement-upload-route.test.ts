import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 実 Supabase・実 AI を読み込まないよう、route より先にモックする。
// ここで確かめるのは route の境界（認証・顧客の紐付け・入力検査・エラー応答・引数の受け渡し）だけ。
// 注意: 本物の RLS（担当外の顧客の口座が見えないこと）はこのテストでは証明しない。
// 下の fake は「id と customer_id の両方の絞り込みが付いているか」を見るだけで、RLS は再現していない。
// RLS は tests/db/ の既存 DB テストが別に確かめる。
const { createUserClientMock, importMock, gatewayFactoryMock } = vi.hoisted(() => ({
  createUserClientMock: vi.fn(),
  importMock: vi.fn(),
  gatewayFactoryMock: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createUserClient: createUserClientMock }));
vi.mock("@/lib/statements/import", () => ({ importStatementCsv: importMock }));
vi.mock("@/lib/statements/gateway", () => ({ supabaseStatementImportGateway: gatewayFactoryMock }));

import { POST } from "@/app/api/customers/[customerId]/statements/route";

// テスト専用の架空の ID
const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const WALLET_ID = "33333333-3333-4333-8333-333333333333";
const MAX_BYTES = 5 * 1024 * 1024;
const GATEWAY = { sentinel: "gateway" };

type WalletRow = { id: string; customer_id: string; kind: string };
type Lookup = { table: string; columns: string; filters: Array<[string, unknown]> };

type FakeOptions = {
  user?: { id: string } | null;
  wallets?: WalletRow[];
  lookupError?: { message: string; code: string };
};

/** 認証と wallets 検索だけを再現する偽クライアント。検索の条件を記録し、条件に合う行だけを返す */
function fakeClient(options: FakeOptions = {}) {
  const lookups: Lookup[] = [];
  const getUser = vi.fn(async () => ({ data: { user: options.user === undefined ? { id: "user-1" } : options.user } }));
  const client = {
    auth: { getUser },
    from(table: string) {
      const lookup: Lookup = { table, columns: "", filters: [] };
      lookups.push(lookup);
      const builder = {
        select(columns: string) {
          lookup.columns = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          lookup.filters.push([column, value]);
          return builder;
        },
        async maybeSingle() {
          if (options.lookupError) return { data: null, error: options.lookupError };
          const row = (options.wallets ?? []).find((w) =>
            lookup.filters.every(([column, value]) => (w as Record<string, unknown>)[column] === value),
          );
          return { data: row ? { kind: row.kind } : null, error: null };
        },
      };
      return builder;
    },
  };
  return { client, getUser, lookups };
}

function useClient(options: FakeOptions = {}) {
  const fake = fakeClient(options);
  createUserClientMock.mockResolvedValue(fake.client);
  return fake;
}

const OWN_BANK_WALLET: WalletRow = { id: WALLET_ID, customer_id: CUSTOMER_ID, kind: "bank_account" };

function csvFile(bytes: Uint8Array = new Uint8Array([0x41, 0x0a]), name = "statement.csv"): File {
  return new File([bytes as BlobPart], name, { type: "text/csv" });
}

function formWith(fields: { file?: File | string | null; walletId?: string | null; formatId?: string | null }): FormData {
  const form = new FormData();
  const file = "file" in fields ? fields.file : csvFile();
  const walletId = "walletId" in fields ? fields.walletId : WALLET_ID;
  const formatId = "formatId" in fields ? fields.formatId : "bank-generic";
  if (file != null) form.set("file", file);
  if (walletId != null) form.set("walletId", walletId);
  if (formatId != null) form.set("formatId", formatId);
  return form;
}

function post(form: FormData, customerId: string = CUSTOMER_ID) {
  const request = new Request(`http://localhost/api/customers/${customerId}/statements`, { method: "POST", body: form });
  const formDataSpy = vi.spyOn(request, "formData");
  const response = POST(request, { params: Promise.resolve({ customerId }) });
  return { response, formDataSpy };
}

function expectNothingImported() {
  expect(importMock).not.toHaveBeenCalled();
  expect(gatewayFactoryMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  gatewayFactoryMock.mockReturnValue(GATEWAY);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/customers/[customerId]/statements の入口", () => {
  it.each(["not-a-uuid", "", "11111111-1111-4111-8111-11111111111", `${CUSTOMER_ID}x`])(
    "顧客IDが UUID でなければ 400 で、クライアント作成・フォーム読取・取込のどれにも進まない（%j）",
    async (badId) => {
      const { formDataSpy, response } = post(formWith({}), badId);
      const res = await response;

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "顧客IDが不正です" });
      expect(createUserClientMock).not.toHaveBeenCalled();
      expect(formDataSpy).not.toHaveBeenCalled();
      expectNothingImported();
    },
  );

  it("未ログインなら 401 で、他の条件が全て正しくてもフォーム読取・口座検索・取込に進まない", async () => {
    const fake = useClient({ user: null, wallets: [OWN_BANK_WALLET] });
    const { formDataSpy, response } = post(formWith({}));
    const res = await response;

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "ログインしてください" });
    expect(fake.getUser).toHaveBeenCalledTimes(1);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(fake.lookups).toEqual([]);
    expectNothingImported();
  });
});

describe("POST /api/customers/[customerId]/statements の壊れた multipart", () => {
  const BOUNDARY = "testboundary";
  const GENERIC = { error: "アップロードの形式が不正です" };

  function rawPost(body: string, contentType: string, customerId: string = CUSTOMER_ID) {
    const request = new Request(`http://localhost/api/customers/${customerId}/statements`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    const formDataSpy = vi.spyOn(request, "formData");
    const response = POST(request, { params: Promise.resolve({ customerId }) });
    return { response, formDataSpy };
  }

  const wellFormedPart =
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="walletId"\r\n\r\n${WALLET_ID}\r\n`;

  const malformed: Array<[string, string, string]> = [
    ["boundary が無い", "multipart/form-data", wellFormedPart + `--${BOUNDARY}--\r\n`],
    ["本文が途中で切れている", `multipart/form-data; boundary=${BOUNDARY}`, wellFormedPart + `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nA,B`],
  ];

  it.each(malformed)("認証済みで %s なら 400 の汎用 JSON で、口座検索も取込もしない", async (_label, contentType, body) => {
    const fake = useClient({ wallets: [OWN_BANK_WALLET] });
    const { formDataSpy, response } = rawPost(body, contentType);
    const res = await response;

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(GENERIC);
    expect(formDataSpy).toHaveBeenCalledTimes(1);
    expect(fake.lookups).toEqual([]);
    expectNothingImported();
  });

  it("未ログインで壊れた multipart でも 401 で、フォーム読取に進まない", async () => {
    const fake = useClient({ user: null, wallets: [OWN_BANK_WALLET] });
    const { formDataSpy, response } = rawPost("garbage", "multipart/form-data");
    const res = await response;

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "ログインしてください" });
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(fake.lookups).toEqual([]);
    expectNothingImported();
  });

  it("顧客IDが不正なら、壊れた multipart でも 400（顧客ID）が優先される", async () => {
    const { formDataSpy, response } = rawPost("garbage", "multipart/form-data", "not-a-uuid");
    const res = await response;

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "顧客IDが不正です" });
    expect(createUserClientMock).not.toHaveBeenCalled();
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("formData が任意のエラーで拒否されても、内部の詳細を応答に出さず、口座検索も取込もしない", async () => {
    const fake = useClient({ wallets: [OWN_BANK_WALLET] });
    const request = new Request(`http://localhost/api/customers/${CUSTOMER_ID}/statements`, { method: "POST", body: formWith({}) });
    vi.spyOn(request, "formData").mockRejectedValue(
      new Error("secret-internal-detail SUPABASE_SERVICE_ROLE_KEY=abc /srv/app/stack"),
    );
    const res = await POST(request, { params: Promise.resolve({ customerId: CUSTOMER_ID }) });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual(GENERIC);
    expect(text).not.toContain("secret-internal-detail");
    expect(text).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(text).not.toContain("/srv/app");
    expect(fake.lookups).toEqual([]);
    expectNothingImported();
  });

  it("取込が例外で終わった場合は 400 に変換せず、そのまま伝える（コミット済みの可能性を誤分類しない）", async () => {
    useClient({ wallets: [OWN_BANK_WALLET] });
    importMock.mockRejectedValue(new Error("connection lost"));

    await expect(post(formWith({})).response).rejects.toThrow("connection lost");
    expect(importMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/customers/[customerId]/statements の入力検査", () => {
  const cases: Array<[string, () => FormData]> = [
    ["file が無い", () => formWith({ file: null })],
    ["file が文字列", () => formWith({ file: "a,b\n1,2\n" })],
    ["walletId が無い", () => formWith({ walletId: null })],
    ["walletId が UUID でない", () => formWith({ walletId: "wallet-1" })],
    ["formatId が無い", () => formWith({ formatId: null })],
    ["formatId が空", () => formWith({ formatId: "" })],
  ];

  it.each(cases)("%s なら 400 で、口座検索も取込もしない", async (_label, build) => {
    const fake = useClient({ wallets: [OWN_BANK_WALLET] });
    const res = await post(build()).response;

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "file・walletId・formatId を指定してください" });
    expect(fake.lookups).toEqual([]);
    expectNothingImported();
  });

  it("5MB を 1 バイト超えるファイルは 413 で、口座検索も取込もしない", async () => {
    const fake = useClient({ wallets: [OWN_BANK_WALLET] });
    const res = await post(formWith({ file: csvFile(new Uint8Array(MAX_BYTES + 1)) })).response;

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "ファイルが大きすぎます（5MB まで）" });
    expect(fake.lookups).toEqual([]);
    expectNothingImported();
  });

  it("ちょうど 5MB のファイルは上限内として取込へ進む", async () => {
    useClient({ wallets: [OWN_BANK_WALLET] });
    importMock.mockResolvedValue({ ok: false, errors: [{ line: 1, message: "x" }], failureRecordId: null });
    const res = await post(formWith({ file: csvFile(new Uint8Array(MAX_BYTES)) })).response;

    expect(res.status).toBe(422);
    expect(importMock).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/customers/[customerId]/statements の口座検索", () => {
  it("wallets の検索は URL の顧客ID と送られた walletId の両方で絞り込む", async () => {
    const fake = useClient({ wallets: [OWN_BANK_WALLET] });
    importMock.mockResolvedValue({ ok: false, errors: [], failureRecordId: null });
    await post(formWith({})).response;

    expect(fake.lookups).toHaveLength(1);
    const lookup = fake.lookups[0];
    if (lookup === undefined) throw new Error("wallets の検索が記録されていない");
    expect(lookup.table).toBe("wallets");
    expect([...lookup.filters].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["customer_id", CUSTOMER_ID],
      ["id", WALLET_ID],
    ]);
  });

  it("別の顧客に属する口座の walletId を送っても 404 で、取込しない（顧客の紐付けを外すと通ってしまう）", async () => {
    const fake = useClient({ wallets: [{ ...OWN_BANK_WALLET, customer_id: OTHER_CUSTOMER_ID }] });
    const res = await post(formWith({})).response;

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "口座が見つかりません" });
    expect(fake.lookups).toHaveLength(1);
    expectNothingImported();
  });

  it("口座が見えない（存在しない、または RLS で隠れて 0 行になる）場合も 404 で、取込しない", async () => {
    // RLS 自体の再現ではない。検索結果が空だった場合の route の振る舞いだけを確かめる
    useClient({ wallets: [] });
    const res = await post(formWith({})).response;

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "口座が見つかりません" });
    expectNothingImported();
  });

  it("口座検索がエラーなら 500 の汎用文言だけを返し、内部の詳細を出さず、取込しない", async () => {
    const internal = { message: 'relation "public.wallets" secret-internal-detail', code: "XX000" };
    useClient({ lookupError: internal });
    const res = await post(formWith({})).response;

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "口座を確認できませんでした" });
    expect(text).not.toContain("secret-internal-detail");
    expect(text).not.toContain("public.wallets");
    expect(text).not.toContain("XX000");
    expectNothingImported();
  });

  it("未対応の口座の種類なら 404 で、取込しない", async () => {
    useClient({ wallets: [{ ...OWN_BANK_WALLET, kind: "crypto_exchange" }] });
    const res = await post(formWith({})).response;

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "口座が見つかりません" });
    expectNothingImported();
  });
});

describe("POST /api/customers/[customerId]/statements の取込", () => {
  const counts = {
    ok: true,
    importId: "import-1",
    insertedCount: 2,
    skippedDuplicateCount: 0,
    suspectedDuplicateCount: 0,
    ignoredCount: 0,
    incomeTotal: 1000,
    expenseTotal: 500,
    insertedAmountTotal: 1500,
    skippedAmountTotal: 0,
    suspectedAmountTotal: 0,
  };

  it.each(["bank_account", "credit_card"])(
    "%s の口座では、認証済みのクライアントを gateway に渡し、顧客・口座・種類・ファイル名・バイト列をそのまま取込へ渡す",
    async (kind) => {
      const fake = useClient({ wallets: [{ ...OWN_BANK_WALLET, kind }] });
      importMock.mockResolvedValue(counts);
      // Shift_JIS 想定の非 ASCII バイトを含む（途中で変換・欠落しないこと）
      const bytes = new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x0d, 0x0a, 0x00, 0xff]);
      const name = "銀行_2026-10.csv";
      const res = await post(formWith({ file: csvFile(bytes, name), formatId: "format-x" })).response;

      expect(res.status).toBe(200);
      expect(gatewayFactoryMock).toHaveBeenCalledTimes(1);
      const factoryCall = gatewayFactoryMock.mock.calls[0];
      if (factoryCall === undefined) throw new Error("gateway factory が呼ばれていない");
      expect(factoryCall[0]).toBe(fake.client);
      expect(importMock).toHaveBeenCalledTimes(1);
      const importCall = importMock.mock.calls[0];
      if (importCall === undefined) throw new Error("取込が呼ばれていない");
      const [input, gateway] = importCall;
      expect(gateway).toBe(GATEWAY);
      expect(input).toEqual({
        customerId: CUSTOMER_ID,
        walletId: WALLET_ID,
        walletKind: kind,
        fileName: name,
        formatId: "format-x",
        bytes,
      });
      expect(input.bytes).toBeInstanceOf(Uint8Array);
    },
  );

  it("取込が成功したら 200 で結果をそのまま返す", async () => {
    useClient({ wallets: [OWN_BANK_WALLET] });
    importMock.mockResolvedValue(counts);
    const res = await post(formWith({})).response;

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(counts);
  });

  it("取込が既知の失敗（ok:false）を返したら 422 で結果をそのまま返す", async () => {
    useClient({ wallets: [OWN_BANK_WALLET] });
    const failure = { ok: false, errors: [{ line: 3, message: "金額を読めません" }], failureRecordId: "failure-1" };
    importMock.mockResolvedValue(failure);
    const res = await post(formWith({})).response;

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(failure);
  });
});
