import { execFile, type ExecFileException } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";

/**
 * pg_dump / pg_restore をテストから安全に呼ぶための道具（バックアップ・復元の検証用）。
 * 接続先は、検証済みの localhost の URL から作った値だけ。パスワードは子プロセスの環境変数にだけ置き、
 * 引数・URI・エラーメッセージ・ログには出さない。シェルは使わない。
 */

/** 許可するメジャー版。CI の行列（16.15 と 17.11）に対応する。増やすときはワークフローとドキュメントも同じ変更で更新する */
export const ALLOWED_PG_MAJORS = [16, 17] as const;
export type PgMajor = (typeof ALLOWED_PG_MAJORS)[number];
export const OPT_IN_VARIABLE = "TEST_DATABASE_DISPOSABLE";
export const PG_MAJOR_VARIABLE = "TEST_PG_MAJOR";

type Env = Record<string, string | undefined>;
/** 子プロセスに渡す、値がすべて文字列の環境 */
export type ChildEnv = Record<string, string>;

/** 破壊的な後始末（DB の作成・削除）を伴うテストは、使い捨てクラスタだと明示した場合だけ動かす */
export function requireDisposableOptIn(env: Env = process.env): void {
  if (env[OPT_IN_VARIABLE] !== "1") {
    throw new Error(
      `refusing to run: set ${OPT_IN_VARIABLE}=1 only for a dedicated disposable superuser cluster (localhost alone does not prove the cluster is disposable)`,
    );
  }
}

/** URL の query・fragment は、CLI で同じ接続先を保証できないので受け付けない */
export function assertPlainBaseUrl(base: URL): void {
  if (base.search !== "" || base.hash !== "") {
    throw new Error("refusing to run: TEST_DATABASE_URL must not have query options or a fragment (the CLI target could differ from the pg client)");
  }
  if (base.username === "") {
    throw new Error("refusing to run: TEST_DATABASE_URL must include a user name");
  }
  // パスワードがない URL だと、node-pg・libpq が利用者の .pgpass などの資格情報を探しに行く。合成の値を URL に明示させる
  if (decodeURIComponent(base.password) === "") {
    throw new Error("refusing to run: TEST_DATABASE_URL must include an explicit non-empty synthetic password (otherwise the clients could consult the user's own credential files)");
  }
}

export type ToolPaths = { pgDump: string; pgRestore: string };

/** 検証するメジャー版（TEST_PG_MAJOR）。"16" または "17" の文字列だけを受け付け、未設定・それ以外は拒否する */
export function requirePgMajor(env: Env = process.env): PgMajor {
  const value = env[PG_MAJOR_VARIABLE];
  const major = ALLOWED_PG_MAJORS.find((m) => String(m) === value);
  if (major === undefined) {
    throw new Error(`${PG_MAJOR_VARIABLE} is required and must be exactly one of ${ALLOWED_PG_MAJORS.join(" / ")}`);
  }
  return major;
}

/** 選んだメジャー版の環境変数名。例: PG17_PG_DUMP */
export const toolVariable = (major: PgMajor, tool: "pg_dump" | "pg_restore"): string => `PG${major}_${tool.toUpperCase()}`;

function resolveTool(env: Env, major: PgMajor, expected: "pg_dump" | "pg_restore", exists: (path: string) => boolean): string {
  const variable = toolVariable(major, expected);
  const value = env[variable];
  if (!value) {
    throw new Error(`${variable} is required: set it to the absolute path of the PostgreSQL ${major} ${expected} (nothing is installed by this test)`);
  }
  if (!isAbsolute(value)) throw new Error(`${variable} must be an absolute path`);
  if (basename(value).replace(/\.exe$/i, "") !== expected) throw new Error(`${variable} must point to ${expected}`);
  if (!exists(value)) throw new Error(`${variable}: ${expected} was not found at the given path (nothing is installed by this test)`);
  return value;
}

export function resolveToolPaths(env: Env = process.env, exists: (path: string) => boolean = existsSync): ToolPaths {
  const major = requirePgMajor(env);
  return {
    pgDump: resolveTool(env, major, "pg_dump", exists),
    pgRestore: resolveTool(env, major, "pg_restore", exists),
  };
}

/** `pg_dump (PostgreSQL) 16.15 (...)` のような出力からメジャー版を取り出す */
export function parseMajor(versionOutput: string): number {
  const match = /\(PostgreSQL\)\s+(\d+)(?:\.\d+)?/.exec(versionOutput);
  if (!match) throw new Error("could not read the PostgreSQL client version");
  return Number(match[1]);
}

/**
 * 子プロセスの環境。継承した PG*（PGHOST・PGOPTIONS・PGSERVICE など）を全部外してから、検証済み URL の値だけを入れる。
 * パスワードはここ（環境変数）にだけ置く。
 */
export function buildChildEnv(parent: Env, url: URL, database: string): ChildEnv {
  const env: ChildEnv = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && !/^pg/i.test(key)) env[key] = value;
  }
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || "5432";
  env.PGUSER = decodeURIComponent(url.username);
  env.PGDATABASE = database;
  env.PGCONNECT_TIMEOUT = "10";
  const password = decodeURIComponent(url.password);
  if (password !== "") env.PGPASSWORD = password;
  return env;
}

export function secretsOf(url: URL): string[] {
  const password = decodeURIComponent(url.password);
  return [...new Set([password, url.password, encodeURIComponent(password)])].filter((s) => s !== "");
}

/** 出力からパスワードと URI 内の認証情報を伏せ、長さも切り詰める */
export function redact(text: string, secrets: string[]): string {
  let out = text.replace(/(postgres(?:ql)?:\/\/)[^@\s/]*@/gi, "$1[redacted]@");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
  return out.length > 2000 ? `${out.slice(0, 2000)}…(truncated)` : out;
}

/** 時間制限つきで CLI を実行する（argv 配列・シェルなし）。失敗メッセージは伏せ字にしてから投げる */
export function runTool(label: string, file: string, args: string[], env: ChildEnv, timeoutMs: number, secrets: string[]): Promise<string> {
  // Next が ProcessEnv に必須の NODE_ENV を足しているため、作り直した環境はそのままでは型が合わない。
  // 子プロセスには環境を丸ごと渡す（NODE_ENV を足したり、親から戻したりはしない）ので、型だけを合わせる
  const childEnv = env as NodeJS.ProcessEnv;
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { env: childEnv, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false, encoding: "utf8" },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (!error) return resolve(stdout);
        const e = error as ExecFileException;
        const reason = e.killed ? `timed out after ${timeoutMs} ms` : e.code === "ENOENT" ? "binary not found" : `exit ${String(e.code)}`;
        reject(new Error(`${label} failed (${reason}): ${redact(String(stderr), secrets)}`.trim()));
      },
    );
    child.stdin?.end();
  });
}
