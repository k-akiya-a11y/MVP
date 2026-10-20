#!/usr/bin/env bash
# Docker なしでマイグレーションを検証する: 使い捨ての Postgres を起動し、
# Supabase 互換の土台（tests/db/supabase-shim.sql）→ マイグレーション → seed を適用してから DB テストを流す。
# CI では Postgres サービスコンテナを使い、TEST_DATABASE_URL を渡して npm run test:db を直接実行する。
set -euo pipefail

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
WORK="$(mktemp -d)"
PORT="${PORT:-54329}"

RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown -R postgres "$WORK" 2>/dev/null || true
  RUN_AS=(su postgres -s /bin/bash -c)
  run() { "${RUN_AS[@]}" "$*"; }
else
  run() { bash -c "$*"; }
fi

cleanup() {
  run "$PG_BIN/pg_ctl -D $WORK/data -m immediate stop" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

run "$PG_BIN/initdb -D $WORK/data -U postgres -A trust >/dev/null"
run "$PG_BIN/pg_ctl -D $WORK/data -o '-p $PORT -k $WORK -c listen_addresses=127.0.0.1' -l $WORK/log -w start >/dev/null"

export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/postgres"
npm run --silent db:apply
npm run --silent test:db
