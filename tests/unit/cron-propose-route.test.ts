import { afterEach, describe, expect, it, vi } from "vitest";

// 実ジョブ（Supabase・Claude API のクライアント）を読み込まないよう、route より先にモックする
const { jobMock } = vi.hoisted(() => ({ jobMock: vi.fn() }));
vi.mock("@/jobs/propose-journal-entries", () => ({
  proposeJournalEntriesJob: jobMock,
}));

import type { ProposalRunResult } from "@/lib/proposals/run";
import { GET } from "@/app/api/cron/propose/route";

// テスト専用の架空の値（実際のシークレットではない）
const SECRET = "test-cron-secret-not-real";
const URL_ = "http://localhost/api/cron/propose";

function req(authorization?: string): Request {
  return new Request(URL_, {
    headers: authorization === undefined ? {} : { authorization },
  });
}

async function expectUnauthorized(res: Response) {
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "unauthorized" });
  expect(jobMock).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetAllMocks();
});

describe("GET /api/cron/propose の認証", () => {
  it("CRON_SECRET が未設定なら Bearer ヘッダがあっても 401 でジョブを呼ばない", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    await expectUnauthorized(await GET(req("Bearer undefined")));
    await expectUnauthorized(await GET(req("Bearer ")));
  });

  it("CRON_SECRET が空文字なら 'Bearer ' だけのヘッダでも 401 でジョブを呼ばない", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await expectUnauthorized(await GET(req("Bearer ")));
    await expectUnauthorized(await GET(req("Bearer")));
  });

  it("authorization ヘッダが無ければ 401 でジョブを呼ばない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expectUnauthorized(await GET(req()));
  });

  it("シークレットが違えば 401 でジョブを呼ばない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expectUnauthorized(await GET(req("Bearer wrong-secret")));
    await expectUnauthorized(await GET(req(`Bearer ${SECRET}x`)));
    await expectUnauthorized(await GET(req(`Bearer ${SECRET.slice(0, -1)}`)));
  });

  it("認証方式が Bearer 以外なら 401 でジョブを呼ばない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    await expectUnauthorized(await GET(req(SECRET)));
    await expectUnauthorized(await GET(req(`Basic ${SECRET}`)));
    await expectUnauthorized(await GET(req(`bearer ${SECRET}`)));
  });

  it("401 の応答にシークレットを含めない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await GET(req("Bearer wrong-secret"));
    expect(await res.text()).not.toContain(SECRET);
  });
});

describe("GET /api/cron/propose の実行", () => {
  it("Bearer が完全一致すればジョブを1回だけ呼び、結果を JSON のまま返す", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const result = {
      processed: 3,
      byConfidence: { high: 2, medium: 1, low: 0 },
      failures: [],
    } satisfies ProposalRunResult;
    jobMock.mockResolvedValue(result);

    const res = await GET(req(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(jobMock).toHaveBeenCalledTimes(1);
  });

  it("Request が前後の空白を正規化するため、先頭空白付きのヘッダも有効な Bearer として扱う", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const result = {
      processed: 0,
      byConfidence: { high: 0, medium: 0, low: 0 },
      failures: [],
    } satisfies ProposalRunResult;
    jobMock.mockResolvedValue(result);

    const res = await GET(req(` Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(jobMock).toHaveBeenCalledTimes(1);
  });

  it("失敗の要約を含む結果も加工せずそのまま返す", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const result = {
      processed: 1,
      byConfidence: { high: 0, medium: 0, low: 1 },
      failures: [
        { bankTransactionId: "txn-1", error: "ai_invalid_output" },
        { bankTransactionId: "txn-2", error: "log_write_failed" },
      ],
    } satisfies ProposalRunResult;
    jobMock.mockResolvedValue(result);

    const res = await GET(req(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(jobMock).toHaveBeenCalledTimes(1);
  });

  it("リクエストごとに現在の CRON_SECRET で判定する", async () => {
    jobMock.mockResolvedValue({
      processed: 0,
      byConfidence: { high: 0, medium: 0, low: 0 },
      failures: [],
    } satisfies ProposalRunResult);

    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(200);
    expect(jobMock).toHaveBeenCalledTimes(1);

    // シークレットを差し替えたら、旧シークレットは拒否される
    vi.stubEnv("CRON_SECRET", "rotated-test-secret-not-real");
    expect((await GET(req(`Bearer ${SECRET}`))).status).toBe(401);
    expect(jobMock).toHaveBeenCalledTimes(1);
    expect((await GET(req("Bearer rotated-test-secret-not-real"))).status).toBe(200);
    expect(jobMock).toHaveBeenCalledTimes(2);

    // 未設定に戻したら、以前有効だったヘッダも拒否される
    vi.stubEnv("CRON_SECRET", undefined);
    expect((await GET(req("Bearer rotated-test-secret-not-real"))).status).toBe(401);
    expect(jobMock).toHaveBeenCalledTimes(2);
  });
});
