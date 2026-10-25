# VoidRun backend

Java / Spring Boot backend of VoidRun, an online judge with execution replay.
The React client is in `../frontend`.

```
backend/
├── pom.xml                 parent: Spring Boot 4.1, Java 21
├── mvnw                    Maven wrapper; no Maven install needed
├── voidrun-common/         languages, verdicts, topic names, Kafka event payloads
├── voidrun-schema/         Flyway migrations (applied by the API, reused by the workers' tests)
├── voidrun-api/            Spring Boot control plane: REST, auth (password, Google, GitHub),
│                           outbox relay to Kafka, replay API
├── voidrun-worker/         Spring Boot Kafka consumers: judges runs and submissions, records
│                           Debug replays, each in a Docker sandbox
├── voidrun-recorder/       execution recorder and replay
├── scripts/gen_seed.py     generates the seeded practice problems
└── docker/
    ├── api.Dockerfile      the API image
    ├── worker.Dockerfile   the worker image
    ├── runner.Dockerfile   judge sandbox: g++ (+ precompiled bits/stdc++.h), Java 21, Node 22
    ├── runner/vr-run.c     runs one test under limits and measures it from inside
    └── recorder.Dockerfile sandbox image for recording (g++, LLDB)
```

## Build and test

Needs JDK 21+ (Homebrew's `openjdk` works: `export JAVA_HOME=/opt/homebrew/opt/openjdk`)
and Docker running: the integration tests start PostgreSQL, Redis and Kafka with Testcontainers.

```bash
./mvnw verify                                              # unit + API and worker integration tests
VOIDRUN_RECORDER_IMAGE=voidrun-recorder:latest \
VOIDRUN_RUNNER_IMAGE=voidrun-runner:latest ./mvnw verify       # + real programs in both sandbox images
```

The recorder's real-toolchain tests run inside the sandbox image (build it with
`make recorder-image` from the repository root), exactly as the worker records.
`VOIDRUN_CXX=g++-16` runs them on the host instead, which needs a g++ that ships
`<bits/stdc++.h>` (Homebrew GCC on macOS) and a `python3` that can import LLDB.

## Run the API

```bash
docker compose -f ../docker-compose.yml up -d --wait postgres redis
./mvnw -q -pl voidrun-api -am package -DskipTests
export JWT_SECRET=$(openssl rand -hex 32)
java -jar voidrun-api/target/voidrun-api-0.1.0-SNAPSHOT.jar   # :8080, migrations applied on start
```

The defaults match the compose services; every setting is listed in `.env.example`.
The API speaks the web client's `/api/v1` contract (snake_case JSON,
`{"error": {"code", "message"}}` errors).

### Sign in with Google and GitHub

A provider is enabled once both of its variables are set; until then it is
simply not offered (`GET /api/v1/auth/providers`).

| Provider | Create credentials at | Variables |
| --- | --- | --- |
| Google | Google Cloud console → APIs & Services → Credentials → OAuth client (Web) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| GitHub | GitHub → Settings → Developer settings → OAuth Apps | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |

The authorised redirect URI is `<origin>/login/oauth2/code/google` (or `/github`),
where `<origin>` is the address the browser uses to reach `/oauth2/**`:
`http://localhost:8080` when talking to the API directly, the web client's origin
once it proxies those paths.

How it fits together:

1. The browser opens `/oauth2/authorization/{provider}`; Spring Security runs the
   redirect, holding OAuth state in a session that lives only for that redirect.
2. The provider account is matched to a user: an already-linked identity first; else a
   **provider-verified** email that matches an account whose own email is verified;
   else a new user. A password account's email is never verified, so a Google sign-in
   with the same address is refused (`email_in_use`) rather than merged: otherwise
   anyone could pre-register a victim's address and inherit their sign-in later.
3. The browser returns to `FRONTEND_URL/auth/callback?code=…`. The code is single-use,
   lives 60 s, and only redeems together with an HttpOnly cookie set on the same
   browser, via `POST /api/v1/auth/oauth/exchange`. Tokens never appear in a URL.
4. A signed-in user connects another provider with `POST /api/v1/auth/oauth/link-intent`,
   which returns the redirect URL carrying a single-use, browser-bound link token.
   `DELETE /api/v1/users/me/identities/{provider}` disconnects one, unless it is the
   last way left to sign in.

## Execution recorder

`voidrun-recorder` records a C++ program for step-through replay, separate
from the fast judge path. It never decides a verdict.

```
source + stdin
   │  g++ -std=c++17 -g -O0 -include vr_prelude.h      (unbuffered stdout)
   ▼
vr_trace.py under LLDB    single-steps user lines, steps out of the
   │                      standard library, and prints the FULL flattened
   │                      state at every stop:  f0.v.memo[3] = 2
   ▼
RecordingBuilder          diff each state against the previous one
   │                      → one Delta per step
   │                      + a full keyframe every K steps
   ▼
Recording                 keyframes + deltas + stdout + how it ended
   │
ReplayCursor              forward: apply the next delta
                          back / jump: nearest keyframe ≤ target, then
                          at most K-1 deltas, so every move is O(K)
```

* **Stable keys.** Frames are numbered from the bottom of the stack (`f0` is
  `main`), so a call adds keys instead of renaming every frame above it, and
  a step usually changes a handful of keys. On a recursive Fibonacci with
  K=32, the recording stores ~1.5k entries where full states would be ~7.9k.
* **No garbage.** A local is shown only once its declaration line (or a
  later line) has run in that activation of the function; until then its
  stack slot holds whatever was there before.
* **Bounded.** A step budget, a wall-clock budget enforced by interrupting
  the process (a one-line `while(true){}` never finishes a step on its own),
  a per-step key budget, and a cap on kept stdout. A cut-short recording is
  still a valid prefix and keeps the step it stopped on.
* **Crashes.** A segfault ends the recording on the faulting line with the
  whole stack intact.

Try it from the terminal, in the sandbox image:

```bash
./mvnw -q -pl voidrun-recorder package -DskipTests
java -cp voidrun-recorder/target/classes \
  dev.voidrun.recorder.RecorderCli prog.cpp input.txt --docker voidrun-recorder:latest
#  n next · b back · g N goto · e end · q quit      (--verify checks every step)
```

## Judging

```
Run / Submit ─▶ runs or submissions row + outbox row ─▶ relay ─▶ voidrun.runs / voidrun.submissions
                                                                   │  own consumer group and pool each,
                                                                   │  so a submission burst never delays Run
                                                                   ▼
   claim (status <> FINISHED) → one container of voidrun-runner for the job
     → compile once (or reuse the cached build) → docker exec vr-run per test
     → verdict + per-test rows in one transaction, guarded by status <> 'FINISHED'
     → commit the Kafka offset
```

* **Sandbox.** `--network none --read-only --tmpfs /tmp --cap-drop ALL
  --security-opt no-new-privileges --user 65534:65534 --pids-limit 256
  --memory` (no swap) `--cpus 1`. Inside it, `vr-run` gives each test a
  CPU-time limit, an output-size limit (16 MB), no core dumps and, for C++, an
  address-space limit, and measures wall time, CPU time and peak memory
  (`wait4`) from inside the container, so container start-up never counts
  against the time limit.
* **Verdicts.** Output is compared after whitespace normalisation (line
  endings, trailing spaces, trailing blank lines), then exactly. Tests run in
  order and the first failure decides the verdict. Java and Node.js get twice
  the problem's time limit for VM start-up; their memory limit is their heap
  limit (`-Xmx`, `--max-old-space-size`).
* **Speed.** `<bits/stdc++.h>` is precompiled in the image with the judge's
  flags (a typical compile drops to ~0.1 s), and compiled programs are cached
  by `sha256(image, compile command, source)` (LRU, 500 entries), so Run then
  Submit compiles once.
* **Failures.** The sandbox failing (Docker down, image missing) is retried
  through `voidrun.runs-retry-*` / `voidrun.submissions-retry-*`; after the
  last attempt the job ends as `INTERNAL_ERROR` ("please try again") with the
  reason in `internal_error` and `dead_letter_events`.

```bash
VOIDRUN_RUNNER_IMAGE=voidrun-runner:latest ./mvnw -pl voidrun-worker test   # real programs in the real image
```

## Contests

* **Phases come from the clock.** UPCOMING before `starts_at`, RUNNING until
  `ends_at`, then ENDED; nothing has to run at the start or the end.
* **Hidden until it ends.** One set of SQL rules (`ProblemAccess`) decides who
  sees a problem: practice, its authors, or contestants while it runs.
* **Contest submissions** go to `voidrun.contest-submissions`, judged by their
  own consumer group and a larger pool, so practice traffic never delays them.
* **Live standings.** The worker writes a `voidrun.verdicts` event to the outbox
  in the transaction that stores a contest verdict (the API does the same for a
  new, pending one). Every API instance reads that topic in a consumer group of
  its own, so each hears every verdict, and pushes an SSE event to its open
  pages, which refetch the standings. Standings are always computed from the
  database (`Standings`), so a lost event costs freshness, never correctness.

## Debug replays end to end

```
editor "Debug" ─ POST /replays ─▶ replays row + outbox row      one transaction
                                     │
                    OutboxRelay ─────┘ FOR UPDATE SKIP LOCKED, publish, stamp published_at
                                     ▼
                              voidrun.replays (Kafka, keyed by replay id)
                                     │  consumer group voidrun-replay-recorders,
                                     │  one record per poll, commit after the DB write
                                     ▼
                       voidrun-worker: claim (status <> FINISHED) → record in the
                       sandbox → guarded UPDATE ... WHERE status <> 'FINISHED'
                         │ failure                        │
                         ▼                                ▼
   voidrun.replays-retry-2000, -retry-4000      GET /replays/{id}/steps
                         │ still failing           ReplayCursor rebuilds each page
                         ▼                         from the nearest keyframe
            voidrun.replays-dlt → RECORDER_ERROR + dead_letter_events
```

* **Sandbox.** Every compile and trace is its own `docker run` of the recorder
  image: `--network none --read-only --cap-drop ALL --security-opt
  no-new-privileges`, 512 MB, 1 CPU, 256 processes, as an unprivileged user.
  LLDB traces its own child, which Docker's default seccomp profile allows.
* **At least once, recorded once.** A redelivered job finds the replay
  finished and is acknowledged without recording again; two workers racing on
  the same replay keep whichever finishes first.
* **No head-of-line blocking.** A failing job moves to a retry topic instead
  of being retried in place, so the partition keeps flowing; a malformed one
  goes straight to the dead-letter topic.
* **The worker in Docker** starts sandboxes through the host's daemon socket
  and shares `/tmp/voidrun-replays` at the same path, because the daemon
  resolves the sandbox's `-v` mount on the host.

## Status

| Area | Status |
| --- | --- |
| Execution recorder, snapshot reconstruction | **done**, `voidrun-recorder` |
| Debug replays: API, worker, sandboxed recording, step-through viewer | **done**, `voidrun-api`, `voidrun-worker`, `frontend` |
| Control plane: problems, admin, runs, submissions, profile; submission + outbox in one transaction | **done**, `voidrun-api` |
| Sign-up and sign-in with password, Google and GitHub; link and unlink | **done**, `voidrun-api` |
| Outbox relay to Kafka; topics declared by the API | **done**, `voidrun-api` |
| Judging runs and submissions: C++17, Java 21, Node.js 22 | **done**, `voidrun-worker` |
| Consumer groups, one record per poll, offsets committed after the result, conditional writes | **done** for runs, submissions and replays |
| Separate topics, non-blocking retry topics, dead-letter topic | **done** for runs, submissions and replays |
| Docker sandbox: no network, read-only root, dropped privileges, limits | **done** (`voidrun-runner`, `voidrun-recorder` images) |
| Precompiled `bits/stdc++.h`, compiled-program cache keyed by source hash | **done** |
| Import problems and editorials from Codeforces and AtCoder | **done**, `voidrun-api/.../problems/importer`; `POST /studio/problems/import` and `/import-editorial` |
| Community problems (studio) and contests: co-authors, registration, live standings over Kafka + SSE, four scoring formats | **done** |
| Failure testing: kill workers mid-job, restart Kafka, duplicate deliveries | duplicates, retries and dead letters tested for replays; the rest not started |
