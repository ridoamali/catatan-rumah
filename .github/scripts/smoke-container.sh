#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the image to test}"
name="cr-smoke-${GITHUB_RUN_ID:-local}-$$"
volume="$name-data"
cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    docker logs "$name" || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume" >/dev/null
docker run -d --name "$name" --platform linux/arm64 --init \
  --read-only --tmpfs /tmp:size=32m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --mount "type=volume,source=$volume,target=/app/data" \
  -e ALLOWED_ORIGINS=https://rumah.example.com \
  "$image" >/dev/null

wait_healthy() {
  for attempt in $(seq 1 45); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$name")
    if [ "$status" = healthy ]; then return; fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != true ]; then
      echo 'Container exited before becoming healthy' >&2
      return 1
    fi
    sleep 2
  done
  echo 'Container health timed out' >&2
  return 1
}

wait_healthy
docker exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.getuid(), 1000);
assert.throws(() => require.resolve('tsx'), {code: 'MODULE_NOT_FOUND'});
const base = 'http://127.0.0.1:3000';
assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {status:'ok', db:'ok'});
const home = await fetch(base);
assert.equal(home.status, 200);
const html = await home.text();
assert.match(html, /<div id="root"><\/div>/);
const asset = html.match(/src="([^"]+\.js)"/);
assert.ok(asset, 'Built frontend JS must be present');
assert.equal((await fetch(new URL(asset[1], base))).status, 200);
assert.equal((await fetch(`${base}/api/missing`)).status, 404);
const setup = (origin) => fetch(`${base}/api/auth/setup`, {
  method:'POST', headers:{'content-type':'application/json', origin},
  body: JSON.stringify({householdName:'Container Test', name:'Test', email:'test@example.test', password:'container-smoke-123'}),
});
assert.equal((await setup('https://foreign.example.com')).status, 403);
const created = await setup('https://rumah.example.com');
assert.equal(created.status, 201);
const cookie = created.headers.get('set-cookie');
assert.match(cookie, /; Secure/i);
assert.match(cookie, /; HttpOnly/i);
const me = await fetch(`${base}/api/auth/me`, {headers:{cookie:cookie.split(';')[0]}});
assert.equal(me.status, 200);
JS

docker stop --time 150 "$name" >/dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$name")" = 0
docker start "$name" >/dev/null
wait_healthy
docker exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const r = await fetch('http://127.0.0.1:3000/api/auth/status');
assert.equal(r.status, 200);
assert.equal((await r.json()).needsSetup, false, 'Database must survive restart');
console.log('PASS: Linux ARM64 container, non-root, production-only dependencies, frontend, auth, Secure cookie, persistence.');
JS
