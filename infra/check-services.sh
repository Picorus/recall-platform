#!/usr/bin/env sh
# Proves the laptop services answer. Run after `pnpm services:up`.
set -eu
compose="docker compose -f $(dirname "$0")/docker-compose.yml"

echo "Database extensions:"
$compose exec -T db psql -U recall -d recall -tAc \
  "SELECT extname || ' ' || extversion FROM pg_extension WHERE extname IN ('postgis','timescaledb','h3','h3_postgis') ORDER BY 1" \
  | tee /dev/stderr | wc -l | grep -qx 4

echo "Map cell check (H3 for Hitec City):"
$compose exec -T db psql -U recall -d recall -tAc \
  "SELECT h3_latlng_to_cell(POINT(78.3810, 17.4474), 9)"

echo "Redis:"
$compose exec -T redis redis-cli ping | grep -qx PONG && echo PONG

echo "MQTT broker:"
$compose exec -T mqtt /opt/emqx/bin/emqx ctl status

echo "File storage:"
$compose exec -T s3 wget -q -O /dev/null http://127.0.0.1:8333/healthz && echo ok

echo "All laptop services are up."
