#!/bin/sh
set -eu

APP_PORT=${SMOKE_APP_PORT:-3010}
export APP_PORT
compose="docker compose --project-name fleet-radar-smoke --env-file .env.example"

stop_stack() {
  $compose down
}

trap stop_stack EXIT INT TERM

$compose config --quiet
$compose up --build --wait

node -e "fetch('http://127.0.0.1:' + process.env.APP_PORT + '/health').then(async (response) => { if (!response.ok) throw new Error('health returned ' + response.status); }).catch((error) => { console.error(error.message); process.exit(1); })"
node -e "const url = 'http://127.0.0.1:' + process.env.APP_PORT + '/api/vehicles'; (async () => { for (let attempt = 0; attempt < 30; attempt += 1) { const response = await fetch(url); if (!response.ok) throw new Error('vehicles returned ' + response.status); const body = await response.json(); if (Array.isArray(body.data) && body.data.length === 100) return; await new Promise((resolve) => setTimeout(resolve, 1000)); } throw new Error('fleet did not reach 100 vehicles'); })().catch((error) => { console.error(error.message); process.exit(1); })"
node -e "const signal = AbortSignal.timeout(10000); fetch('http://127.0.0.1:' + process.env.APP_PORT + '/api/events?after=0', { signal }).then(async (response) => { if (!response.ok || !response.body) throw new Error('event stream returned ' + response.status); const reader = response.body.getReader(); const decoder = new TextDecoder(); let received = ''; while (!received.includes('event:')) { const chunk = await reader.read(); if (chunk.done) break; received += decoder.decode(chunk.value); } await reader.cancel(); if (!received.includes('event:')) throw new Error('event stream produced no update'); }).catch((error) => { console.error(error.message); process.exit(1); })"

before_sequence=$($compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COALESCE(MAX(sequence), 0) FROM event_log"')
$compose restart app
$compose up --wait app
sleep 2
after_sequence=$($compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT COALESCE(MAX(sequence), 0) FROM event_log"')

if [ "$after_sequence" -le "$before_sequence" ]; then
  echo "event sequences did not advance after application restart" >&2
  exit 1
fi
