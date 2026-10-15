# Aftermath

Aftermath is an incident investigation platform built around FalkorDB graph reasoning, PostgreSQL/PGlite persistence, and bounded AI investigator and reporter workflows. The intended application traces findings to versioned evidence and repairs reports when that evidence changes.

## Current scope

Milestones 1–3 provide validated core incident, evidence, claim, correction, and report contracts; an independently testable TypeScript support evaluator; immutable report formatting; and deterministic unit-test fixtures. Application entry points remain scaffolds. FalkorDB projects and evaluates the evidence graph, service topology, and diagnostic availability and coverage. HTTP endpoints, SQL persistence, workers, diagnostic execution, and investigation UI features remain deferred. The React entry mounts an empty root, so the development page is intentionally blank.

## Core model

`@aftermath/contracts` exports TypeScript types inferred from strict Zod schemas. The schemas validate data shape, while `validateGraph` in `@aftermath/domain` checks references, unique artifact/group identities, cycles, and the twelve-level dependency bound. A time window is an exact scope label, not a date interval inferred from source text.

`evaluateSupport` requires every premise within a support group; alternative groups are OR choices. Only active evidence and supported claim premises in the same environment and time window are admissible. Valid opposition makes an otherwise supported finding contested; contested findings cannot support descendants. Origins are deduplicated across surviving positive support, without claiming statistical independence.

`makeReport` produces a new revision with initial, preserved, or revised statements and a validation epoch. It validates evaluation coverage, keeps earlier reports unchanged, and distinguishes unsupported, contested, and pending findings. Its optional fifth `createdAt` argument allows reproducible report timestamps.

`createDomainFixture` in `@aftermath/fixtures` returns fresh deterministic test objects for the small checkout support graph. Its fixed ID and synthetic observation timestamps are test data, used for reproducible tests. `createIncident()` adds the small operational topology and recipe metadata; `createCommerceIncident()` supplies the complete commerce workload. Diagnostic execution remains deferred.

## FalkorDB graph reasoning

`@aftermath/graph` exports `EvidenceGraph`. `await EvidenceGraph.open()` starts the pinned embedded FalkorDB engine; `EvidenceGraph.open(undefined, url)` connects to a remote service. Always call `close()` to delete owned generations and release the connection. Local execution needs permission to create Unix sockets and the installed native platform binary. Remote connection failures reject; there is no local fallback or TypeScript evaluation fallback.

Each incident/event sequence receives a private generation. Projection snapshots its inputs, batches evidence, claims, groups and corrections, evaluates dependency layers, projects service and diagnostic relationships, then sets `Projection.ready=true`. Concurrent readers share that build. Reads check readiness; failed builds reject and retry in a new generation. Callers must increment `eventSeq` whenever incident state changes. Generations remain cached until close; crash cleanup and bounded eviction remain future operational concerns.

| Graph model                                                    | Meaning                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `EvidenceVersion`                                              | Exact source version, status, scope, provenance and descriptive payload                       |
| `ClaimVersion`                                                 | Claim scope and Cypher-computed evaluation status                                             |
| `SupportGroup`                                                 | Explicit support/opposition polarity, rule, validity and rejection reasons                    |
| `Correction`                                                   | Withdrawal reason linked to an exact withdrawn evidence version                               |
| `ClaimVersion -HAS_SUPPORT-> SupportGroup -REQUIRES-> premise` | Ordered AND premises; OR across positive groups; valid opposition contests supported findings |
| `ClaimVersion -DERIVED_FROM-> premise`                         | Dependency traversal for impact, including opposition                                         |
| `Correction -RETRACTS-> EvidenceVersion`                       | Persistent projection of the supplied correction record                                       |

The parameterized queries in [queries.ts](packages/graph/src/queries.ts) compute admissibility, scope matching, origin deduplication and claim status from actual relationships. TypeScript only schedules up to twelve dependency layers and formats returned rows. Claim payloads omit membership arrays; readback reconstructs them from edges. Graph-view claim status uses the computed result, even if supplied incident evaluations are stale. `impact()` returns dependency paths, and `corrections()` reads retraction relationships; neither performs repair or SQL mutation.

Run `npm run test:graph` against the real embedded engine. Tests compare results to the independent domain oracle, deliberately alter graph premises and polarity, and cover withdrawal, alternatives, contested descendants, isolation, readiness, retry, cleanup and unavailable services. These tests make no model calls. The pinned engine requires computing group reasons in a Cypher variable before assigning both reasons and validity; reading a just-assigned property in a following `SET` produced incorrect results during verification.

## Service topology and diagnostics

`serviceImpact(incident, serviceId)` returns the graph-projected topology, incoming blast radius with shortest paths, and FalkorDB PageRank scores. `DEPENDS_ON` points from caller to dependency. Blast radius identifies potential exposure, not observed failure; PageRank describes dependency importance, not causal confidence. Equal shortest paths use a stable service-ID tie-break based on graph-computed distances.

`diagnostics(incident)` reads `DiagnosticRecipe -RUNS_ON-> Service`, `-CHECKS-> ClaimVersion`, and `-NEEDS-> EvidenceVersion` relationships. Evidence and claims link to services through `ABOUT`; absent claim service IDs are derived from evidence dependency paths. Every prerequisite must be active and match the recipe scope (taken from its first informed claim). Completed recipes are unavailable. Invalid references and topologies exceeding 128 services or 512 dependencies reject projection before publication.

Coverage includes unsupported or contested findings connected to the recipe's service through directed dependency paths. Each claim contributes its shortest applicable path once. The ranking score is `(covered claims + 0.1 × sum(1 / path node count)) / (1 + estimated cost)`, with unavailable/completed recipes scoring zero and recipe IDs breaking ties. Cypher computes availability and reachable paths; TypeScript deterministically formats paths and applies this formula. No fixture-specific rank order is encoded.

The deterministic commerce fixture includes **24 services, 34 dependencies, 17 observations and 18 claims**. Database-evidence withdrawal invalidates dependent explanations while retaining an independently supported order finding. The three recipes contain metadata only; their hidden observations are absent from the initial graph. These fixtures use fixed test identities and synthetic timestamps, used for reproducible tests.

`npm run test:graph` runs both graph and diagnostic suites against the real embedded engine. API, UI, agents, SQL publication, and diagnostic execution are outside this milestone. Generation caching and cleanup limitations described above still apply.

## Local setup

Use Node.js 20.19 or newer and npm 10 or newer. npm 10.8.2 is recorded as the package manager. The dependencies include a pinned project-local Node 22 runtime used by npm scripts after installation.

```bash
npm ci
npm run dev
```

Vite serves the empty web entry at http://127.0.0.1:5173. The API watcher prints scaffold status; it does not listen on port 4000 yet. The Vite proxy reserves /api for the later API milestone.

To run the API or worker scaffold once:

```bash
npm start
npm run worker
```

Both commands print their status and exit. Use `npm run dev:api`, `npm run dev:web`, or `npm run dev:worker` for individual development processes.

No external database services, Docker, or provider credentials are required for local tests. Graph tests start the embedded FalkorDB engine and require permission to create local sockets. Installation requires registry access and may fetch native runtime/engine binaries. The Linux x64 engine has been tested; other platforms remain unverified.

The optional `.env.example` describes configuration names reserved for later milestones. The scaffold does not load it. Never commit local `.env` files or credentials.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run format:check
```

Run `npm run test:core` for contract, domain, and deterministic-fixture tests. These cover support alternatives, opposition, provenance, scope, malformed dependency graphs, and report revisions. The workspace smoke suite also checks TypeScript source exports. Core tests do not start databases, queues, or models; the full suite also starts embedded FalkorDB. The build typechecks all source and writes the web bundle to `dist/web`; server entries run as TypeScript through tsx, using the workspace source exports.

Use `npm run test:watch` for Vitest watch mode, `npm run format` to format project files, and `npm run preview` to inspect the built empty web entry. Existing instructions and planning records are excluded from automatic formatting.

## Workspace layout

| Path                  | Intended responsibility                         |
| --------------------- | ----------------------------------------------- |
| `apps/api`            | Express API and application startup             |
| `apps/web`            | React/Vite investigation workspace              |
| `apps/worker`         | Durable background repair worker                |
| `packages/contracts`  | Shared types and validated contracts            |
| `packages/domain`     | Evidence and claim support semantics            |
| `packages/fixtures`   | Synthetic incidents and registered diagnostics  |
| `packages/graph`      | FalkorDB projections and graph reasoning        |
| `packages/storage`    | PostgreSQL/PGlite ledger and publication checks |
| `packages/repair`     | Report repair orchestration                     |
| `packages/queue`      | Redis/BullMQ delivery                           |
| `packages/agents`     | Bounded provider tools and report proposals     |
| `packages/evaluation` | Structural evaluation and acceptance cases      |

Dependencies are centralized in the root manifest. Shared packages export `src/index.ts` directly and are private workspaces. The intended runtime stack uses FalkorDB for relationship-derived reasoning, SQL for durable state, dedicated Redis/BullMQ for delivery, Express for HTTP, and React/React Flow for the browser.

Dependencies, caches, build output, local databases, benchmark artifacts, and provider traces are excluded from Git. Further functionality is delivered through independently tested milestones.

## Acknowledgments

AI tools assisted with implementation and automated checks. Developer review and manual verification are reported separately when performed.
