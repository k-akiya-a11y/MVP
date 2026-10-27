import { describe, expect, it, vi } from "vitest";
import { submitStatementUpload, UPLOAD_UNKNOWN_MESSAGE } from "@/lib/statements/upload-result";

const URL = "/api/customers/00000000-0000-4000-8000-000000000001/statements";

const COUNTS = {
  importId: "00000000-0000-4000-8000-0000000000c1",
  insertedCount: 3,
  skippedDuplicateCount: 1,
  suspectedDuplicateCount: 2,
  ignoredCount: 1,
  incomeTotal: 100000,
  expenseTotal: 25000,
  insertedAmountTotal: 90000,
  skippedAmountTotal: 5000,
  suspectedAmountTotal: 30000,
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function run(respond: () => Promise<Response>) {
  const fetchFn = vi.fn(respond) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const promise = submitStatementUpload(fetchFn, URL, new FormData());
  return { fetchFn, promise };
}

describe("submitStatementUpload", () => {
  it("成功: 件数と金額の要約を返す", async () => {
    const { promise } = run(async () => json({ ok: true, ...COUNTS }, 200));
    const outcome = await promise;
    expect(outcome.kind).toBe("success");
    expect(outcome.message).toContain("読めた行 6件（入金 100,000円・出金 25,000円）");
    expect(outcome.message).toContain("登録 3件 90,000円");
    expect(outcome.message).toContain("取込済みのため読み飛ばし 1件 5,000円");
    expect(outcome.message).toContain("重複の疑い 2件 30,000円");
    expect(outcome.message).toContain("金額0のため取引にしなかった行 1件");
  });

  it("通信の失敗: 結果不明で、登録されていないとは言わない", async () => {
    const { promise, fetchFn } = run(async () => {
      throw new TypeError("secret-host.internal refused");
    });
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
    expect(outcome.message).not.toContain("secret-host");
    expect(outcome.message).not.toContain("1件も登録していません");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("HTML の 500: 結果不明", async () => {
    const { promise } = run(async () => new Response("<html>Internal Server Error db-password</html>", { status: 500 }));
    const outcome = await promise;
    expect(outcome.kind).toBe("unknown");
    expect(outcome.message).not.toContain("db-password");
  });

  it("成功の状態でも本文が JSON でなければ結果不明", async () => {
    const { promise } = run(async () => new Response("<html>ok</html>", { status: 200 }));
    expect((await promise).kind).toBe("unknown");
  });

  it.each([null, "ok", [], {}, { ok: true }, { ok: true, ...COUNTS, insertedCount: "3" }, { ok: true, ...COUNTS, insertedCount: -1 }])(
    "成功の状態でも本文が不正なら成功にしない: %j",
    async (body) => {
      const { promise } = run(async () => json(body, 200));
      expect((await promise).kind).toBe("unknown");
    },
  );

  it("成功らしい本文でも HTTP 500 なら成功にしない", async () => {
    const { promise } = run(async () => json({ ok: true, ...COUNTS }, 500));
    const outcome = await promise;
    expect(outcome.kind).toBe("unknown");
    expect(outcome.message).not.toContain("登録 3件");
  });

  it("422 の検証失敗: 登録していないと伝え、記録済みなら併記する", async () => {
    const { promise } = run(async () =>
      json({ ok: false, errors: [{ line: 3, message: "金額が読めません" }], failureRecordId: "00000000-0000-4000-8000-0000000000f1" }, 422),
    );
    const outcome = await promise;
    expect(outcome.kind).toBe("rejected");
    expect(outcome.message).toContain("明細は1件も登録していません");
    expect(outcome.message).toContain("失敗として記録しました");
    expect(outcome.message).toContain("3行目 金額が読めません");
  });

  it("422 で failureRecordId がなければ記録済みとは言わない", async () => {
    const { promise } = run(async () => json({ ok: false, errors: [{ line: 1, message: "形式が違います" }], failureRecordId: null }, 422));
    const outcome = await promise;
    expect(outcome.kind).toBe("rejected");
    expect(outcome.message).not.toContain("失敗として記録しました");
  });

  it("422 でも本文が不正なら結果不明", async () => {
    const { promise } = run(async () => json({ ok: false }, 422));
    expect((await promise).kind).toBe("unknown");
  });

  it.each([
    [400, "指定を確認してください"],
    [401, "ログインしてください"],
    [404, "口座が見つかりません"],
    [413, "ファイルが大きすぎます（5MB まで）"],
  ])("登録前に返す既知の状態 %i は固定の文言で「登録していない」と伝える", async (status, expected) => {
    const { promise } = run(async () => json({ error: "route-body-ignored" }, status));
    const outcome = await promise;
    expect(outcome.kind).toBe("rejected");
    expect(outcome.message).toContain("明細は1件も登録していません");
    expect(outcome.message).toContain(expected);
    expect(outcome.message).not.toContain("route-body-ignored");
  });

  it("既知の状態でも { error } の形でなければ結果不明", async () => {
    const { promise } = run(async () => json({ message: "x" }, 413));
    expect((await promise).kind).toBe("unknown");
  });

  it.each([408, 429, 403, 409, 418])("既知でない 4xx（%i）は登録されていないと言い切れず、結果不明", async (status) => {
    const { promise } = run(async () => json({ error: "短い本文" }, status));
    expect(await promise).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
  });

  it("短くても機密を含む 400 の本文は表示しない", async () => {
    const { promise } = run(async () => json({ error: "db-password=hunter2" }, 400));
    const outcome = await promise;
    expect(outcome.message).not.toContain("hunter2");
    expect(outcome.message).not.toContain("db-password");
  });

  it("422 の errors が空なら結果不明", async () => {
    const { promise } = run(async () => json({ ok: false, errors: [], failureRecordId: null }, 422));
    expect((await promise).kind).toBe("unknown");
  });

  it("422 の failureRecordId が UUID でなければ結果不明", async () => {
    const { promise } = run(async () =>
      json({ ok: false, errors: [{ line: 1, message: "x" }], failureRecordId: "not-a-uuid" }, 422),
    );
    expect((await promise).kind).toBe("unknown");
  });

  it("成功の importId が UUID でなければ結果不明", async () => {
    const { promise } = run(async () => json({ ok: true, ...COUNTS, importId: "abc" }, 200));
    expect((await promise).kind).toBe("unknown");
  });

  it("5xx の { error } 本文は表示しない", async () => {
    const { promise } = run(async () => json({ error: "relation bank_transactions violates constraint" }, 500));
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
  });

  it("4xx でも長い本文は表示しない", async () => {
    const { promise } = run(async () => json({ error: "x".repeat(500) }, 400));
    const outcome = await promise;
    expect(outcome.kind).toBe("rejected");
    expect(outcome.message).not.toContain("xxxxxxxxxx");
    expect(outcome.message.length).toBeLessThan(200);
  });

  it("再送しない: 失敗しても fetch は1回だけ", async () => {
    const { promise, fetchFn } = run(async () => new Response("bad gateway", { status: 502 }));
    await promise;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });
});
