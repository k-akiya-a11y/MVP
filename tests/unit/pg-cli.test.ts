import { describe, expect, it } from "vitest";
import {
  assertPlainBaseUrl,
  buildChildEnv,
  parseMajor,
  redact,
  requireDisposableOptIn,
  requirePgMajor,
  resolveToolPaths,
  runTool,
  secretsOf,
  toolVariable,
} from "../db/pg-cli";

const URL_WITH_SECRET = new URL("postgres://admin:p%40ss%2Fw0rd@localhost:5544/postgres");

describe("バックアップ検証の対象ガード", () => {
  it("使い捨てクラスタの明示（TEST_DATABASE_DISPOSABLE=1）がなければ拒否する", () => {
    expect(() => requireDisposableOptIn({})).toThrow(/TEST_DATABASE_DISPOSABLE=1/);
    expect(() => requireDisposableOptIn({ TEST_DATABASE_DISPOSABLE: "true" })).toThrow();
    expect(() => requireDisposableOptIn({ TEST_DATABASE_DISPOSABLE: "1" })).not.toThrow();
  });

  it("接続先を変えうる query・fragment と、ユーザー名なしの URL は拒否する", () => {
    expect(() => assertPlainBaseUrl(new URL("postgres://u:p@localhost:5432/postgres?host=db.example.com"))).toThrow(/query/);
    expect(() => assertPlainBaseUrl(new URL("postgres://u:p@localhost:5432/postgres?options=-c%20search_path%3Dx"))).toThrow(/query/);
    expect(() => assertPlainBaseUrl(new URL("postgres://localhost:5432/postgres"))).toThrow(/user name/);
    expect(() => assertPlainBaseUrl(new URL("postgres://u:p@localhost:5432/postgres"))).not.toThrow();
  });

  it("合成のパスワードが URL に明示されていなければ拒否する（.pgpass など利用者の資格情報を参照させない）", () => {
    expect(() => assertPlainBaseUrl(new URL("postgres://u@localhost:5432/postgres"))).toThrow(/password/);
    expect(() => assertPlainBaseUrl(new URL("postgres://u:@localhost:5432/postgres"))).toThrow(/password/);
    expect(() => assertPlainBaseUrl(new URL("postgres://u:p%40ss@localhost:5432/postgres"))).not.toThrow();
  });

  it("検証するメジャー版（TEST_PG_MAJOR）は \"16\" と \"17\" だけを受け付け、未設定・不明・曖昧な値は拒否する", () => {
    expect(requirePgMajor({ TEST_PG_MAJOR: "16" })).toBe(16);
    expect(requirePgMajor({ TEST_PG_MAJOR: "17" })).toBe(17);
    for (const bad of [undefined, "", "15", "18", "16.15", "17.11", " 17", "017", "1", "latest", "16,17"]) {
      expect(() => requirePgMajor({ TEST_PG_MAJOR: bad }), String(bad)).toThrow(/TEST_PG_MAJOR/);
    }
    expect(() => requirePgMajor({})).toThrow(/TEST_PG_MAJOR/);
  });

  it("pg_dump / pg_restore は選んだ版の明示パスだけを受け付け、無い・相対・別のバイナリー・別の版の変数は明確に失敗する（インストールしない）", () => {
    const ok16 = { TEST_PG_MAJOR: "16", PG16_PG_DUMP: "/usr/lib/postgresql/16/bin/pg_dump", PG16_PG_RESTORE: "/usr/lib/postgresql/16/bin/pg_restore" };
    const ok17 = { TEST_PG_MAJOR: "17", PG17_PG_DUMP: "/usr/lib/postgresql/17/bin/pg_dump", PG17_PG_RESTORE: "/usr/lib/postgresql/17/bin/pg_restore" };
    expect(resolveToolPaths(ok16, () => true)).toEqual({ pgDump: ok16.PG16_PG_DUMP, pgRestore: ok16.PG16_PG_RESTORE });
    expect(resolveToolPaths(ok17, () => true)).toEqual({ pgDump: ok17.PG17_PG_DUMP, pgRestore: ok17.PG17_PG_RESTORE });
    expect(toolVariable(17, "pg_restore")).toBe("PG17_PG_RESTORE");

    // 版の選択がなければ、変数がそろっていても拒否する（既定の版を黙って選ばない）
    expect(() => resolveToolPaths({ ...ok16, TEST_PG_MAJOR: undefined }, () => true)).toThrow(/TEST_PG_MAJOR/);
    // 選んだ版の変数だけを見る。別の版の変数では代用しない
    expect(() => resolveToolPaths({ ...ok16, TEST_PG_MAJOR: "17" }, () => true)).toThrow(/PG17_PG_DUMP is required/);
    expect(() => resolveToolPaths({ ...ok17, TEST_PG_MAJOR: "16" }, () => true)).toThrow(/PG16_PG_DUMP is required/);
    expect(() => resolveToolPaths({ ...ok17, PG17_PG_RESTORE: undefined }, () => true)).toThrow(/PG17_PG_RESTORE is required/);

    expect(() => resolveToolPaths({ ...ok16, PG16_PG_DUMP: "pg_dump" }, () => true)).toThrow(/absolute/);
    expect(() => resolveToolPaths({ ...ok17, PG17_PG_DUMP: "pg_dump" }, () => true)).toThrow(/absolute/);
    expect(() => resolveToolPaths({ ...ok16, PG16_PG_RESTORE: "/usr/bin/psql" }, () => true)).toThrow(/pg_restore/);
    expect(() => resolveToolPaths({ ...ok17, PG17_PG_DUMP: "/usr/lib/postgresql/17/bin/pg_restore" }, () => true)).toThrow(/pg_dump/);
    expect(() => resolveToolPaths(ok16, () => false)).toThrow(/not found/);
    expect(() => resolveToolPaths(ok17, () => false)).toThrow(/not found/);
  });

  it("メジャー版が選択と食い違うクライアントは、読み取った版の比較で検出できる（16 と 17 の取り違え）", () => {
    const out17 = "pg_dump (PostgreSQL) 17.11 (Debian 17.11-1.pgdg24.04+1)";
    const out16 = "pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)";
    expect(parseMajor(out17)).toBe(requirePgMajor({ TEST_PG_MAJOR: "17" }));
    expect(parseMajor(out16)).toBe(requirePgMajor({ TEST_PG_MAJOR: "16" }));
    expect(parseMajor(out17)).not.toBe(requirePgMajor({ TEST_PG_MAJOR: "16" }));
    expect(parseMajor(out16)).not.toBe(requirePgMajor({ TEST_PG_MAJOR: "17" }));
  });

  it("クライアントのメジャー版を読み取る", () => {
    expect(parseMajor("pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)")).toBe(16);
    expect(parseMajor("pg_restore (PostgreSQL) 17.2")).toBe(17);
    expect(() => parseMajor("something else")).toThrow();
  });
});

describe("子プロセスの設定と失敗の伏せ字", () => {
  it("継承した PG* を全部外し、検証済み URL の値だけを設定する。パスワードは PGPASSWORD にだけ入り、URI は作らない", () => {
    const parent = {
      PATH: "/usr/bin",
      PGHOST: "db.example.com",
      PGPORT: "6543",
      PGUSER: "someone",
      PGOPTIONS: "-c search_path=evil",
      PGSERVICE: "prod",
      pgpassword: "inherited",
      PGSSLROOTCERT: "/tmp/x",
    };
    const env = buildChildEnv(parent, URL_WITH_SECRET, "mvp_bkp_src_0123456789abcdef");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      PGHOST: "localhost",
      PGPORT: "5544",
      PGUSER: "admin",
      PGPASSWORD: "p@ss/w0rd",
      PGDATABASE: "mvp_bkp_src_0123456789abcdef",
    });
    expect(Object.keys(env).filter((k) => /^pg/i.test(k)).sort()).toEqual(["PGCONNECT_TIMEOUT", "PGDATABASE", "PGHOST", "PGPASSWORD", "PGPORT", "PGUSER"]);
    expect(Object.values(env).some((v) => /postgres(ql)?:\/\//i.test(v))).toBe(false);
  });

  it("出力のパスワード（生・URL エンコード）と URI 内の認証情報を伏せる", () => {
    const secrets = secretsOf(URL_WITH_SECRET);
    const text = "connection to postgres://admin:p%40ss%2Fw0rd@localhost failed; password p@ss/w0rd rejected";
    const out = redact(text, secrets);
    expect(out).not.toContain("p@ss/w0rd");
    expect(out).not.toContain("p%40ss%2Fw0rd");
    expect(out).toContain("postgres://[redacted]@localhost");
  });

  it("失敗した CLI のエラーにパスワードを含めず、時間制限を超えたら止める", async () => {
    const secrets = secretsOf(URL_WITH_SECRET);
    const env = { PGPASSWORD: "p@ss/w0rd" };
    const failure = await runTool("fake tool", process.execPath, ["-e", "console.error('bad auth ' + process.env.PGPASSWORD); process.exit(3)"], env, 10_000, secrets).catch(
      (e: Error) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("exit 3");
    expect((failure as Error).message).not.toContain("p@ss/w0rd");

    const slow = await runTool("slow tool", process.execPath, ["-e", "setTimeout(() => {}, 30000)"], env, 300, secrets).catch((e: Error) => e);
    expect((slow as Error).message).toMatch(/timed out after 300 ms/);
  });
});
