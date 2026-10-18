#!/usr/bin/env bash
# Local control-plane PostgreSQL for Signalworks (port 54563). Separate from the systems under
# test and from Breakroom's database. Standard startup never deletes data.
set -euo pipefail
cd "$(dirname "$0")/.."
PGDATA=.local/pg PORT=${SW_PG_PORT:-54563}
mkdir -p .local
if [ ! -d "$PGDATA" ]; then
  initdb -D "$PGDATA" -U sw_owner --auth=scram-sha-256 -E UTF8 --locale=C --pwfile=<(grep '^SW_OWNER_PASSWORD=' .env | cut -d= -f2-) >/dev/null
fi
if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
  pg_ctl -D "$PGDATA" -o "-p $PORT -k /tmp -c listen_addresses=127.0.0.1" -l .local/pg.log start >/dev/null
fi
for i in $(seq 1 20); do pg_isready -h 127.0.0.1 -p "$PORT" >/dev/null 2>&1 && break; sleep 0.5; done
export PGPASSWORD=$(grep '^SW_OWNER_PASSWORD=' .env | cut -d= -f2-)
psql -h 127.0.0.1 -p "$PORT" -U sw_owner -d postgres -tAc "select 1 from pg_database where datname='signalworks'" | grep -q 1 \
  || createdb -h 127.0.0.1 -p "$PORT" -U sw_owner signalworks
echo "control database ready on 127.0.0.1:$PORT"
