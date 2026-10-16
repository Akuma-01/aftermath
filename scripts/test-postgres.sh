#!/usr/bin/env bash
set -euo pipefail
# Use an explicitly supplied test database, or create an isolated disposable cluster.
if [[ -n "${STORAGE_TEST_DATABASE_URL:-}" ]]; then
  npm test -- tests/storage.test.ts tests/integration.test.ts
  exit
fi
pg_bin="${PG_BIN:-/usr/lib/postgresql/16/bin}"
if [[ ! -x "$pg_bin/initdb" || ! -x "$pg_bin/pg_ctl" ]]; then
  echo 'PostgreSQL binaries unavailable. Set PG_BIN or STORAGE_TEST_DATABASE_URL.' >&2
  exit 1
fi
pg_dir=$(mktemp -d /tmp/aftermath-postgres-XXXXXX)
cleanup() {
  "$pg_bin/pg_ctl" -D "$pg_dir/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf -- "$pg_dir"
}
trap cleanup EXIT
if ! "$pg_bin/initdb" -D "$pg_dir/data" --auth=trust --no-locale -E UTF8 >"$pg_dir/init.log" 2>&1; then
  cat "$pg_dir/init.log" >&2
  exit 1
fi
if ! "$pg_bin/pg_ctl" -D "$pg_dir/data" -l "$pg_dir/server.log" -o "-k $pg_dir -c listen_addresses='' -c unix_socket_permissions=0700" -w start; then
  cat "$pg_dir/server.log" >&2
  exit 1
fi
export STORAGE_TEST_DATABASE_URL="postgresql://localhost/postgres?host=$pg_dir"
npm test -- tests/storage.test.ts tests/integration.test.ts
