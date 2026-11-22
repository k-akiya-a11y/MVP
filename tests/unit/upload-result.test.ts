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

/** 件数・金額が全部 0 の土台。ケースごとに必要な項目だけ上書きする */
const ZERO = {
  importId: "00000000-0000-4000-8000-0000000000c1",
  insertedCount: 0,
  skippedDuplicateCount: 0,
  suspectedDuplicateCount: 0,
  ignoredCount: 0,
  incomeTotal: 0,
  expenseTotal: 0,
  insertedAmountTotal: 0,
  skippedAmountTotal: 0,
  suspectedAmountTotal: 0,
};

describe("submitStatementUpload: 応答内の金額保存則（入金+出金 = 登録+読み飛ばし+疑い）", () => {
  // 合計 600 円（入金 500 + 出金 100）に対する内訳を変えたケース。件数は金額と対応させてある
  const BASE600 = {
    ...ZERO,
    insertedCount: 1,
    skippedDuplicateCount: 1,
    suspectedDuplicateCount: 1,
    incomeTotal: 500,
    expenseTotal: 100,
    insertedAmountTotal: 100,
    skippedAmountTotal: 300,
    suspectedAmountTotal: 200,
  };

  it("基準の 600 円は成功のまま", async () => {
    const { promise } = run(async () => json({ ok: true, ...BASE600 }, 200));
    expect((await promise).kind).toBe("success");
  });

  const mismatches: [string, Record<string, number>][] = [
    ["内訳が 1 円少ない（599 円）", { suspectedAmountTotal: 199 }],
    ["内訳が 1 円多い（601 円）", { suspectedAmountTotal: 201 }],
    ["入金側が 1 円多い", { incomeTotal: 501 }],
    ["出金側が 1 円少ない", { expenseTotal: 99 }],
    ["内訳の登録分だけ大きくずれる（1,100 円）", { insertedAmountTotal: 600 }],
    ["読み飛ばし分が 1 円ずれる", { skippedAmountTotal: 301 }],
  ];

  it.each(mismatches)("合計と内訳が一致しなければ結果不明: %s", async (_name, override) => {
    const { promise, fetchFn } = run(async () => json({ ok: true, ...BASE600, ...override }, 200));
    const outcome = await promise;
    expect(outcome).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
    expect(outcome.message).not.toContain("登録 1件");
    expect(outcome.message).not.toContain("600");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("浮動小数点の和では丸めで一致して見える不整合（2^53+1 と 2^53）も結果不明", async () => {
    // 入金+出金 = 2^53 + 1、内訳 = 2^53。number の足し算ではどちらも 2^53 になり見逃す
    const body = {
      ...ZERO,
      insertedCount: 1,
      skippedDuplicateCount: 1,
      incomeTotal: Number.MAX_SAFE_INTEGER,
      expenseTotal: 2,
      insertedAmountTotal: Number.MAX_SAFE_INTEGER,
      skippedAmountTotal: 1,
    };
    const { promise } = run(async () => json({ ok: true, ...body }, 200));
    expect(await promise).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
  });

  it("合計が MAX_SAFE_INTEGER を超えても、正確に一致していれば成功", async () => {
    // 入金 MAX_SAFE + 出金 1 = 2^53、内訳 MAX_SAFE + 1 = 2^53
    const body = {
      ...ZERO,
      insertedCount: 1,
      skippedDuplicateCount: 1,
      incomeTotal: Number.MAX_SAFE_INTEGER,
      expenseTotal: 1,
      insertedAmountTotal: Number.MAX_SAFE_INTEGER,
      skippedAmountTotal: 1,
    };
    const { promise } = run(async () => json({ ok: true, ...body }, 200));
    expect((await promise).kind).toBe("success");
  });

  // 合計は一致させ、件数と金額の対応だけを崩したケース
  const countAmount: [string, Record<string, number>][] = [
    ["登録 0 件なのに登録金額が正", { insertedCount: 0, skippedDuplicateCount: 1, suspectedDuplicateCount: 0, insertedAmountTotal: 60, skippedAmountTotal: 540, suspectedAmountTotal: 0 }],
    ["読み飛ばし 0 件なのに読み飛ばし金額が正", { insertedCount: 1, skippedDuplicateCount: 0, suspectedDuplicateCount: 0, insertedAmountTotal: 100, skippedAmountTotal: 500, suspectedAmountTotal: 0 }],
    ["疑い 0 件なのに疑い金額が正", { insertedCount: 1, skippedDuplicateCount: 1, suspectedDuplicateCount: 0, insertedAmountTotal: 100, skippedAmountTotal: 300, suspectedAmountTotal: 200 }],
    ["登録 1 件なのに登録金額が 0 円", { insertedCount: 1, skippedDuplicateCount: 1, suspectedDuplicateCount: 0, insertedAmountTotal: 0, skippedAmountTotal: 600, suspectedAmountTotal: 0 }],
    ["読み飛ばし 1 件なのに読み飛ばし金額が 0 円", { insertedCount: 1, skippedDuplicateCount: 1, suspectedDuplicateCount: 0, insertedAmountTotal: 600, skippedAmountTotal: 0, suspectedAmountTotal: 0 }],
    ["疑い 1 件なのに疑い金額が 0 円", { insertedCount: 1, skippedDuplicateCount: 0, suspectedDuplicateCount: 1, insertedAmountTotal: 600, skippedAmountTotal: 0, suspectedAmountTotal: 0 }],
  ];

  it.each(countAmount)("件数と金額が対応しなければ結果不明: %s", async (_name, override) => {
    const { promise, fetchFn } = run(async () => json({ ok: true, ...BASE600, ...override }, 200));
    expect(await promise).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["件数が安全でない整数", { insertedCount: 2 ** 60 }],
    ["金額が安全でない整数", { incomeTotal: 2 ** 60, insertedAmountTotal: 2 ** 60 }],
    ["無視行数が安全でない整数", { ignoredCount: 2 ** 60 }],
  ])("安全でない整数を含む応答は結果不明: %s", async (_name, override) => {
    const { promise } = run(async () => json({ ok: true, ...BASE600, ...override }, 200));
    expect(await promise).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
  });

  it("件数の合計が MAX_SAFE_INTEGER を超えても、読めた行は丸めずに表示する", async () => {
    // 件数は MAX_SAFE + 2 = 9007199254740993 のまま。金額は 1 件 1 円未満にならないよう、
    // 入金+出金 = MAX_SAFE + 2 = 登録 MAX_SAFE + 読み飛ばし 1 + 疑い 1 で正確に一致させる
    const body = {
      ...ZERO,
      insertedCount: Number.MAX_SAFE_INTEGER,
      skippedDuplicateCount: 1,
      suspectedDuplicateCount: 1,
      incomeTotal: Number.MAX_SAFE_INTEGER,
      expenseTotal: 2,
      insertedAmountTotal: Number.MAX_SAFE_INTEGER,
      skippedAmountTotal: 1,
      suspectedAmountTotal: 1,
    };
    const { promise } = run(async () => json({ ok: true, ...body }, 200));
    const outcome = await promise;
    expect(outcome.kind).toBe("success");
    expect(outcome.message).toContain("読めた行 9007199254740993件");
  });

  it("金額が文字列の応答は、合計が合っていても成功にしない", async () => {
    const { promise } = run(async () => json({ ok: true, ...BASE600, incomeTotal: "500" }, 200));
    expect(await promise).toEqual({ kind: "unknown", message: UPLOAD_UNKNOWN_MESSAGE });
  });

  // 「正当」は応答の形が保存則を満たすという意味で、実際の取込が成功した例を意味しない
  describe("保存則を満たす応答は成功のまま（応答の形の検証であり、実取込の成功例ではない）", () => {
    it("完全再取込: 登録 0 件・読み飛ばしだけ", async () => {
      const { promise } = run(async () =>
        json({ ...ZERO, ok: true, skippedDuplicateCount: 4, incomeTotal: 700, expenseTotal: 300, skippedAmountTotal: 1000 }, 200),
      );
      const outcome = await promise;
      expect(outcome.kind).toBe("success");
      expect(outcome.message).toContain("読めた行 4件（入金 700円・出金 300円）");
      expect(outcome.message).toContain("登録 0件 0円");
      expect(outcome.message).toContain("取込済みのため読み飛ばし 4件 1,000円");
    });

    it("重複の疑いだけ", async () => {
      const { promise } = run(async () =>
        json({ ...ZERO, ok: true, suspectedDuplicateCount: 2, expenseTotal: 800, suspectedAmountTotal: 800 }, 200),
      );
      const outcome = await promise;
      expect(outcome.kind).toBe("success");
      expect(outcome.message).toContain("重複の疑い 2件 800円");
    });

    it("入金だけ・出金だけ", async () => {
      const a = run(async () => json({ ...ZERO, ok: true, insertedCount: 2, incomeTotal: 900, insertedAmountTotal: 900 }, 200));
      const b = run(async () => json({ ...ZERO, ok: true, insertedCount: 1, expenseTotal: 50, insertedAmountTotal: 50 }, 200));
      expect((await a.promise).kind).toBe("success");
      expect((await b.promise).kind).toBe("success");
    });

    // 応答の形が保存則（0 = 0）を満たすかだけを見る境界のテスト。
    // 実際の 0 円だけの CSV は取込成功ではなく 422 で拒否される（この応答は実取込の成功例ではない）
    it("全ゼロの応答保存則の境界（実際の0円だけCSVは422）", async () => {
      const { promise } = run(async () => json({ ...ZERO, ok: true, ignoredCount: 3 }, 200));
      const outcome = await promise;
      expect(outcome.kind).toBe("success");
      expect(outcome.message).toContain("金額0のため取引にしなかった行 3件");
    });

    it("ignoredCount があっても保存則の対象にしない（基準の応答）", async () => {
      const { promise } = run(async () => json({ ok: true, ...COUNTS, ignoredCount: 9 }, 200));
      expect((await promise).kind).toBe("success");
    });
  });
});
