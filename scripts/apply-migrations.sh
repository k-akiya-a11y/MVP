#!/usr/bin/env bash
# TEST_DATABASE_URL の Postgres に Supabase 互換の土台・マイグレーション・seed を順に適用する（テスト用）。
set -euo pipefail
: "${TEST_DATABASE_URL:?TEST_DATABASE_URL is required}"
cd "$(dirname "$0")/.."

apply() { psql "$TEST_DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null; }

apply tests/db/supabase-shim.sql
for f in $(ls supabase/migrations/*.sql | sort); do apply "$f"; done
for f in $(ls supabase/seed/*.sql 2>/dev/null | sort); do apply "$f"; done
