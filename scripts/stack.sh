#!/usr/bin/env bash
# Local systems under test (Grafana, Prometheus, Loki, exporter, webhook sink) on the Colima
# "breakroom" Docker socket. `down` stops containers but keeps volumes; nothing is deleted.
set -euo pipefail
cd "$(dirname "$0")/../infra"
export DOCKER_HOST=${SW_DOCKER_HOST:-unix://$HOME/.colima/breakroom/docker.sock}
cp ../.env .env
case "${1:-status}" in
  up) docker compose up -d --build
      for i in $(seq 1 60); do curl -sf 127.0.0.1:3300/api/health >/dev/null && curl -sf 127.0.0.1:9390/-/ready >/dev/null && break; sleep 2; done
      curl -s 127.0.0.1:3300/api/health; echo; curl -s 127.0.0.1:3100/ready; echo ;;
  down) docker compose stop ;;
  status) docker compose ps --format '{{.Name}}\t{{.Status}}' ;;
esac
