import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * テストごとの使い捨てデータベースの道具（アップグレードテスト用）。
 * ローカルの検証用サーバーだけに接続する。作ったデータベースだけを削除する。
 */

export const noop = () => undefined;

/** ローカルの検証用サーバーだけを許可する（本番・外部ホストには接続しない） */
export function validateBaseUrl(): URL {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) {
    throw new Error("TEST_DATABASE_URL is required (npm run db:test:local で起動できます)");
  }
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must be a postgres URL");
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`refusing to run: TEST_DATABASE_URL host must be 127.0.0.1 or localhost (got ${url.hostname})`);
  }
  // 接続先を query で上書きさせない
  for (const key of ["host", "hostaddr", "service", "dbname"]) {
    if (url.searchParams.has(key)) {
      throw new Error(`refusing to run: TEST_DATABASE_URL must not set "${key}"`);
    }
  }
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (name !== "postgres" && !/test/i.test(name)) {
    throw new Error(`refusing to run: database "${name}" is not a test target (name must contain "test", or be the local default "postgres")`);
  }
  return url;
}

export function urlFor(base: URL, database: string): string {
  const url = new URL(base.toString());
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export async function openClient(url: string, label: string): Promise<Client> {
  const client = new Client({
    connectionString: url,
    application_name: label,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  client.on("error", noop); // 後始末で接続を落とすときの通知で落ちないようにする
  await client.connect();
  return client;
}

/**
 * 土台（shim）の SQL を適用する。ロールはクラスタ共通なので、すでにあるロールの作成文だけ省く
 * （同じサーバーの共有 DB に適用済みでも、先に別のテストが作っていても失敗しない）。
 */
export async function applyShim(client: Client, shimSql: string): Promise<void> {
  let shim = shimSql;
  const existing = await client.query<{ rolname: string }>("select rolname from pg_roles where rolname = any($1)", [
    ["anon", "authenticated", "service_role"],
  ]);
  for (const { rolname } of existing.rows) {
    shim = shim.replace(new RegExp(`^create role ${rolname}\\b[^;]*;\\s*$`, "m"), "");
  }
  await client.query(shim);
}

export type DisposableDatabase = { name: string; url: string; drop: () => Promise<void> };

/** 名前が prefix で始まる使い捨てデータベースを作る。drop() は自分が作ったものだけを削除する */
export async function createDisposableDatabase(base: URL, prefix: string): Promise<DisposableDatabase> {
  const name = `${prefix}${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const admin = await openClient(base.toString(), "disposable-create");
  try {
    await admin.query(`create database ${admin.escapeIdentifier(name)}`);
  } catch (error) {
    throw new Error(`could not create the disposable database (CREATEDB 権限が必要です): ${String(error)}`);
  } finally {
    await admin.end().catch(noop);
  }
  let dropped = false;
  return {
    name,
    url: urlFor(base, name),
    drop: async () => {
      if (dropped || !name.startsWith(prefix)) return;
      const dropper = await openClient(base.toString(), "disposable-drop");
      try {
        await dropper.query(`drop database if exists ${dropper.escapeIdentifier(name)} with (force)`);
        dropped = true;
      } finally {
        await dropper.end().catch(noop);
      }
    },
  };
}
