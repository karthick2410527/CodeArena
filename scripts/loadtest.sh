#!/usr/bin/env bash
#
# A modest, repeatable load test for CodeArena.
#
# It is deliberately small: enough to see whether the API stays responsive
# while the judge is busy, and to measure how long submissions actually take
# end to end. It makes no claim about production capacity — see
# docs/LOADTEST.md for what the numbers do and do not mean.
#
# Usage:
#   scripts/loadtest.sh [options]
#
#   --api URL            API base URL          (default http://localhost:8080)
#   --submissions N      submissions to send   (default 20)
#   --concurrency N      parallel submitters   (default 4)
#   --reads N            concurrent read loops (default 2)
#   --problem SLUG       problem to submit to  (default a-plus-b)
#   --timeout SECONDS    give up on a verdict  (default 120)
#
# Requires: bash, curl, python3. No other tooling.

set -uo pipefail

API="${API:-http://localhost:8080}"
SUBMISSIONS=20
CONCURRENCY=4
READERS=2
PROBLEM="a-plus-b"
TIMEOUT=120

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="$2"; shift 2 ;;
    --submissions) SUBMISSIONS="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --reads) READERS="$2"; shift 2 ;;
    --problem) PROBLEM="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

BASE="$API/api/v1"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

json_get() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1],""))' "$1"; }

# --------------------------------------------------------------- preflight

say "CodeArena load test"
say "  api         $API"
say "  submissions $SUBMISSIONS at concurrency $CONCURRENCY"
say "  read load   $READERS loops"
say ""

curl -fsS --max-time 5 "$BASE/health" >/dev/null \
  || die "the API is not reachable at $BASE/health — is it running?"

READY="$(curl -fsS --max-time 5 "$BASE/ready")" || die "readiness check failed"
say "environment (as the API reports it):"
python3 - "$READY" <<'PYEOF'
import json, sys
r = json.loads(sys.argv[1])
def fmt(v):
    if v is None:
        return "not configured"
    if isinstance(v, bool):
        return "yes" if v else "no"
    return str(v)
for k in ("database", "redis", "queue_driver", "rate_limiting"):
    print(f"  {k:16} {fmt(r.get(k))}")
# The API's own runner is always disabled; the worker's strategy is what judges.
print(f"  api runner       {fmt(r.get('runner_strategy'))} (the API never executes code)")
print("  worker runner    see the worker's RUNNER_STRATEGY / GET /admin/workers")
PYEOF

WORKERS="$(curl -fsS --max-time 5 "$BASE/admin/workers" 2>/dev/null || true)"
if [[ -z "$WORKERS" ]]; then
  say "  workers          (needs an admin token to read; skipping)"
fi
say ""

# ------------------------------------------------------------- test account
# A dedicated account per run, so repeated runs do not collide.
STAMP="$(date +%s)$RANDOM"
USER="load$STAMP"
PASSWORD="loadtest-password-1"

REG="$(curl -fsS --max-time 20 -X POST "$BASE/auth/register" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"$USER\",\"email\":\"$USER@example.com\",\"password\":\"$PASSWORD\"}")" \
  || die "could not register a load-test account (is the register rate limit in the way?)"
TOKEN="$(printf '%s' "$REG" | json_get access_token)"
[[ -n "$TOKEN" ]] || die "registration returned no access token"

# A correct solution to a-plus-b, so the expected verdict is ACCEPTED.
SOURCE='#include <bits/stdc++.h>
int main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\n"; }'
PAYLOAD="$(python3 - "$PROBLEM" "$SOURCE" <<'PY'
import json, sys
print(json.dumps({"problem_id": sys.argv[1], "language": "cpp17", "source_code": sys.argv[2]}))
PY
)"

# ------------------------------------------------- background read pressure
# Public reads continue throughout, which is how "the API stayed responsive
# while the judge was busy" is actually measured.
READ_PIDS=()
for ((r = 0; r < READERS; r++)); do
  (
    while [[ ! -f "$WORK/stop" ]]; do
      start=$(date +%s%N)
      code="$(curl -o /dev/null -sS -w '%{http_code}' --max-time 10 "$BASE/problems?limit=20")"
      end=$(date +%s%N)
      printf '%s %s\n' "$code" "$(( (end - start) / 1000000 ))" >> "$WORK/reads.txt"
      sleep 0.1
    done
  ) &
  READ_PIDS+=("$!")
done

# ------------------------------------------------------------- submit phase
say "submitting…"
SUBMIT_START=$(date +%s%N)

submit_one() {
  local i="$1"
  local start end code body id
  start=$(date +%s%N)
  body="$(curl -sS --max-time 30 -o "$WORK/resp.$i" -w '%{http_code}' \
            -X POST "$BASE/submissions" \
            -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $TOKEN" \
            -d "$PAYLOAD")"
  end=$(date +%s%N)
  code="$body"
  printf '%s %s\n' "$code" "$(( (end - start) / 1000000 ))" >> "$WORK/accept.txt"
  if [[ "$code" == "202" ]]; then
    id="$(json_get submission_id < "$WORK/resp.$i")"
    [[ -n "$id" ]] && printf '%s\n' "$id" >> "$WORK/ids.txt"
  fi
  rm -f "$WORK/resp.$i"
}

for ((i = 0; i < SUBMISSIONS; i++)); do
  submit_one "$i" &
  while (( $(jobs -rp | wc -l) >= CONCURRENCY + READERS )); do wait -n; done
done
# Wait for the submitters, not the read loops.
for pid in $(jobs -rp); do
  if [[ ! " ${READ_PIDS[*]} " =~ " $pid " ]]; then wait "$pid" 2>/dev/null; fi
done
SUBMIT_END=$(date +%s%N)

ACCEPTED_COUNT=$(wc -l < "$WORK/ids.txt" 2>/dev/null || echo 0)
say "  accepted $ACCEPTED_COUNT of $SUBMISSIONS"
if [[ "$ACCEPTED_COUNT" -eq 0 ]]; then
  touch "$WORK/stop"; wait 2>/dev/null
  die "no submission was accepted; check the submit rate limit (RATE_LIMIT_SUBMIT)"
fi

# ---------------------------------------------------------- wait for verdicts
say "waiting for verdicts (timeout ${TIMEOUT}s)…"
JUDGE_START=$(date +%s%N)
DEADLINE=$(( $(date +%s) + TIMEOUT ))

while :; do
  : > "$WORK/pending.txt"
  : > "$WORK/verdicts.txt"
  while read -r id; do
    [[ -z "$id" ]] && continue
    status="$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" \
               "$BASE/submissions/$id" | json_get status)"
    case "$status" in
      QUEUED|RUNNING|"") printf '%s\n' "$id" >> "$WORK/pending.txt" ;;
      *) printf '%s %s\n' "$id" "$status" >> "$WORK/verdicts.txt" ;;
    esac
  done < "$WORK/ids.txt"

  pending=$(wc -l < "$WORK/pending.txt")
  [[ "$pending" -eq 0 ]] && break
  if (( $(date +%s) > DEADLINE )); then
    say "  timed out with $pending still unjudged"
    break
  fi
  printf '\r  %s judged, %s pending' "$(wc -l < "$WORK/verdicts.txt")" "$pending"
  sleep 1
done
printf '\r'
JUDGE_END=$(date +%s%N)

touch "$WORK/stop"
wait 2>/dev/null

# ------------------------------------------------------------------ results
say ""
say "results"
python3 - "$WORK" "$SUBMIT_START" "$SUBMIT_END" "$JUDGE_START" "$JUDGE_END" "$SUBMISSIONS" <<'PY'
import os, sys, statistics as st

work, s0, s1, j0, j1, total = sys.argv[1], *map(int, sys.argv[2:6]), int(sys.argv[6])

def read(name):
    p = os.path.join(work, name)
    return open(p).read().split("\n") if os.path.exists(p) else []

def pct(values, p):
    if not values:
        return 0
    values = sorted(values)
    k = min(len(values) - 1, int(round((p / 100) * (len(values) - 1))))
    return values[k]

accept = [l.split() for l in read("accept.txt") if l.strip()]
codes = [a[0] for a in accept]
lat = [int(a[1]) for a in accept if a[0] == "202"]
reads = [l.split() for l in read("reads.txt") if l.strip()]
read_lat = [int(r[1]) for r in reads if r[0] == "200"]
verdicts = [l.split() for l in read("verdicts.txt") if l.strip()]

submit_s = (s1 - s0) / 1e9
judge_s = (j1 - j0) / 1e9

print(f"  POST /submissions")
print(f"    accepted (202)        {codes.count('202')}/{total}")
rejected = [c for c in codes if c != '202']
if rejected:
    from collections import Counter
    print(f"    other status codes    {dict(Counter(rejected))}")
if lat:
    print(f"    latency ms  p50 {pct(lat,50)}  p95 {pct(lat,95)}  max {max(lat)}")
print(f"    wall time             {submit_s:.2f}s"
      f"  ({codes.count('202')/submit_s:.1f} accepted/s)" if submit_s > 0 else "")

print(f"  judging")
print(f"    verdicts persisted    {len(verdicts)}")
if verdicts:
    from collections import Counter
    for v, n in Counter(x[1] for x in verdicts).most_common():
        print(f"      {v:24} {n}")
    print(f"    wall time             {judge_s:.2f}s"
          f"  ({len(verdicts)/judge_s:.2f} verdicts/s)" if judge_s > 0 else "")

print(f"  GET /problems under judge load")
print(f"    requests              {len(reads)}")
bad = [r[0] for r in reads if r[0] != '200']
if bad:
    from collections import Counter
    print(f"    non-200               {dict(Counter(bad))}")
if read_lat:
    print(f"    latency ms  p50 {pct(read_lat,50)}  p95 {pct(read_lat,95)}  max {max(read_lat)}")
    print(f"    (the API stayed responsive while the judge was busy)"
          if pct(read_lat, 95) < 1000 else
          f"    (read latency degraded under load — see docs/LOADTEST.md)")
PY

say ""
say "Record these numbers together with the environment above."
say "Scrape $BASE/metrics for judge duration histograms and queue lag."
