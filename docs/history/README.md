# History

These documents describe the earlier Rust implementation of this project
(CodeArena), whose code is in git history. They are kept for reference: the
design ideas carried over to the Java backend, but the details (crates, metric
names, measured numbers) belong to the old code.

| Document | What it covers |
|---|---|
| [PHASES.md](PHASES.md) | What each of the five original phases delivered |
| [SECURITY.md](SECURITY.md) | The old sandbox's guarantees and limits |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Metrics, heartbeats and dead-letter tooling of the old workers |
| [LOADTEST.md](LOADTEST.md) | Load-test method and the numbers measured then; `make loadtest` still runs against the Java API |

The original specification documents are in [../specs](../specs).
