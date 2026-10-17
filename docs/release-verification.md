# Release verification

## Scope and comparison

This review compared the working `aftermath/` repository with the read-only `../Aftermath/` reference: root configuration, three applications, nine shared packages, migrations, tests, scripts and documentation. Source dependencies determined the comparison. Historical reference records were not modified or republished as current test evidence. No commit was created.

| Component               | Comparison and verification                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts / domain      | Strict runtime schemas, versioned artifacts, provenance, scope, AND/OR support, opposition, admissibility, dependency bounds, independent evaluator and immutable report formatting are present.                                                                 |
| Fixtures                | Both checkout and commerce fixtures, topology, recipes and withheld synthetic diagnostic outcomes are present. Fixture identities are deterministic; API creation assigns unique incident IDs and the ledger initializes events.                                 |
| FalkorDB                | Actual Cypher support evaluation, impact, provenance, service paths, PageRank and ranked prerequisite-aware diagnostics are present. Private ready generations preserve isolation; graph failures reject.                                                        |
| Storage                 | PostgreSQL/PGlite, migrations, snapshot/event ledger, corrections, evidence/report history, idempotency, row locks, outbox, leases and model/tool audits are present. The additional attempt-input-sequence migration strengthens diagnostic publication checks. |
| Repair / queue / worker | Durable outbox dispatch, Redis restart recovery, bounded retries, duplicate delivery, held proposals, heartbeat leases and stale publication checks are present. PostgreSQL tests exercise separate worker execution.                                            |
| Agents                  | Investigator/reporter roles, validated gateways, citations, budgets, audits, Gemini and OpenAI HTTP transports, failover and sequence checks are present. The reference's development SDK dependency is not an application runtime integration.                  |
| API / MCP               | Incident commands and reads, reports, repairs, graph/topology/diagnostics, session memory, agent audit details and benchmark artifact reads are present. All four read-only MCP tools and the reference stateless transport are covered.                         |
| Frontend                | Investigation layout, evidence and service maps, corrections, repair/history, activity, agents, memory, benchmarks and responsive/error states are present. Real API integration remains in place.                                                               |
| Evaluation              | Structural cases, malformed graphs, three selection strategies, diagnostic cases, reproducible artifact scripts and saved-results dashboard are present. Measurements are synthetic development workloads, not production/model-quality claims.                  |
| Acceptance tooling      | Missing recovery and diagnostic acceptance harnesses and their scripted tests were restored. They retain bounded calls, checkpoints, audit attribution and labeled simulated failover; a new explicit live opt-in protects the CLI.                              |

No remaining major reference runtime component was identified as missing. Equivalent code is deliberately not byte-identical: stronger validation, lifecycle modules, deterministic fixtures, explicit graph failures and publication safeguards remain intact.

## Changes

- `apps/api/src/app.ts`: derive same-origin loopback permission from the actual listening socket instead of global PORT; reject untrusted origins without trusting Host. This fixes custom/assigned-port deployments.
- `apps/web/vite.config.ts`: read configured API host/port for the development proxy without exposing provider configuration in the browser bundle.
- `scripts/support/live-recovery.ts`, `scripts/support/diagnostic-evaluation.ts`, `scripts/test-agents-live.ts`: restore reference acceptance workflows, adapt ledger-created events and oldest-first audit ordering, order fresh calls by their logical manifests, and require explicit live opt-in.
- `tests/live-recovery.test.ts`, `tests/agent-diagnostics.test.ts`, `tests/release.test.ts`: cover scripted recovery/diagnostics, offline CLI protection, custom-port origin handling and full HTTP correction/repair/report/MCP integration.
- `scripts/verify-workspace.ts` and root scripts: verify lockfile consistency, workspace links, unwanted files and common credential signatures.
- README and accompanying graph/demo documentation: architecture, actual source queries, setup, API/MCP examples, demonstration, troubleshooting and current limitations; obsolete deferred-feature statements removed.

## Executed checks

Environment: Linux x64; project-local Node 22.23.3, installed npm dependencies, embedded FalkorDB, PGlite, private queue Redis, disposable PostgreSQL 16 and Chromium. Socket-dependent checks ran with permission outside the restrictive sandbox. No paid model request was authorized or executed.

| Check                    | Observed result                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused acceptance       | 21 passed across three files; final recovery-only rerun passed all 8 tests after adding the pre-existing-call regression and logical audit ordering.                |
| Full Vitest              | Isolated rerun: 356 passed, 3 PostgreSQL-only checks skipped, all 26 files passed. Initial complete run: 355 passed, 1 failed, 3 skipped. See investigation below.  |
| PostgreSQL               | 139 passed across nine files, including independent-client concurrency, APIs/MCP, worker and agent persistence.                                                     |
| Chromium workspace       | 15 passed, including mobile/tablet layouts, withdrawal/repair, alternative support, contested findings, held-result rejection, history and benchmark UI.            |
| Chromium scripted agents | 1 passed: both roles through API/BullMQ/FalkorDB, audits, publication and correction repair.                                                                        |
| Build / TypeScript       | Passed; build runs `tsc --noEmit` before Vite production bundling.                                                                                                  |
| Workspace scan           | Passed: all 12 workspace links resolve; root dependency/lock records agree; no common credential signature or prohibited artifact found in tracked/candidate files. |
| Formatting / whitespace  | Passed: Prettier check and git diff whitespace check.                                                                                                               |

The initial restored diagnostic tests failed because reference fixtures already contained an event while working fixtures defer event creation to SQL. Removing that invalid setup assumption fixed all focused tests. The initial workspace scan hit sandbox EPERM from tsx's IPC socket; the permission-enabled rerun passed.

The first complete release suite returned `ignored` instead of `paused` while immediately claiming a newly queued held-report task on PGlite. The same test passed in PostgreSQL and in an isolated PGlite rerun (11 passed, one PostgreSQL-only skip). The cause has not been established; no publication check was weakened to make it pass. The initial run overlapped other verification processes. The complete isolated rerun passed. The final harness-only audit correction was subsequently verified by the eight recovery tests and TypeScript checking; the full-suite count above predates that additional regression test. Treat the original failure as an unresolved intermittent scheduling observation; investigate if it recurs rather than assuming a root cause.

## Limits and remaining work

- Live provider availability, output quality, real quota/failover behavior and paid acceptance runs remain unverified. Scripted provider and intercepted transport tests do not establish these properties.
- Registered diagnostics and benchmark incidents are synthetic. No production probes, real-world latency/cost savings or held-out incident accuracy are claimed. Benchmark CLIs and evaluation semantics are covered by the automated suite; no new paid benchmark was performed.
- Linux x64 and Chromium were exercised. Other OS/native binaries, browsers, remote service deployments and production load were not verified.
- PGlite is single-process storage. Separate workers require shared PostgreSQL, FalkorDB and queue Redis. Public deployment needs authentication, authorization and operational hardening beyond the reference's trusted local boundary.
- Graph generations remain cached until close; bounded eviction and crash-orphan cleanup need operational work for long-running deployments.
- The credential scan covers tracked and candidate files, not ignored local files, Git history or every possible secret format. No fresh dependency vulnerability audit or registry reinstall was performed.
- Automated checks were executed by the implementation assistant. No separate developer manual acceptance, visual review or production approval is asserted. The concise assistance disclosure remains in README acknowledgments.

Proposed commit after review: `test: verify complete application`.
