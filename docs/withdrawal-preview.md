# Evidence withdrawal impact preview

Aftermath can show the consequences of withdrawing an evidence version before recording the correction. This extends the reference application's existing impact traversal and held-report workflow: those inspect dependencies or prepare reports, but do not provide this pre-withdrawal simulation and comparison.

## What the comparison means

| Result                              | Meaning                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Potentially affected claims         | FalkorDB finds dependency paths to the selected evidence, including opposition. Reachability does not necessarily mean loss of support.                                                                                                           |
| Changed / unchanged finding         | Comparison of graph-derived support status, surviving positive groups, provenance origins and group validity/reasons. A supported finding can have changed support while remaining supported.                                                     |
| Supported / unsupported / contested | Actual Cypher evaluation before and after withdrawal. AND applies within a group, OR across alternatives; valid opposition contests otherwise supported claims. Contested claims cannot support descendants.                                      |
| Support groups                      | Positive and opposition memberships, before/after validity and rejection reasons. Scope, active evidence and supported claim premises determine admissibility.                                                                                    |
| Citations                           | References to the withdrawn evidence or newly invalid claim premises require review. Existing unavailable citations can already require review without being newly affected by this withdrawal.                                                   |
| Report conclusions                  | Current report statements compared against graph support, with affected citations and review flags. Independently supported conclusions are preserved unless their recorded citations require attention. This is not generated replacement prose. |
| Related services                    | Evidence/claim `ABOUT` associations and incoming dependency paths. These indicate investigation context and possible exposure, not a prediction that services will fail.                                                                          |

The result includes all findings, not only changed ones. It compares the latest report, not every historical report version. No model is needed to calculate the preview.

## Architecture and snapshot safety

1. The API reads the authoritative SQL incident and checks the requested `expectedEventSeq`. Unknown evidence returns 404; unavailable evidence or a stale sequence returns 409.
2. The graph engine captures a validated copy before asynchronous work. It creates a private baseline graph and a second private graph with only the selected active evidence version marked withdrawn. Existing scope, origins, claim rules and topology remain identical.
3. Both projections run the normal FalkorDB evaluator. Dependency traversal uses the actual source query:

```cypher
MATCH p=(c:ClaimVersion)-[:DERIVED_FROM*1..12]->(e:EvidenceVersion {id: $id})
RETURN c.id AS claimId, [n IN nodes(p) | n.id] AS path
```

`HAS_SUPPORT`/`REQUIRES` relationships provide group comparisons; `ABOUT` and `DEPENDS_ON` provide service context. See the [graph model and queries](graph-model.md) and [preview implementation](../packages/graph/src/withdrawal-preview.ts).

4. Temporary projections stay outside the live generation cache and are deleted after calculation, including evaluation failure. The API rechecks the SQL snapshot fingerprint before returning. It rejects a concurrent change rather than silently previewing a newer snapshot. Graph or cleanup failure never becomes a successful preview.
5. The response identifies the incident, evidence version, event sequence, evidence epoch, latest report version and SHA-256 fingerprint of the canonical validated snapshot. No SQL event, correction, report revision, epoch increment or repair job is created by previewing.
6. Confirmation sends the preview reference with the ordinary withdrawal command. Under the SQL incident row lock, the application checks its target, sequence, epoch, report version and fingerprint before recording the correction and scheduling repair. Idempotency replay precedes the currentness check: an identical retry returns the original accepted result without another correction. Changing the preview while reusing that key is a conflict.

The fingerprint is an optimistic concurrency precondition, not a signed authorization token or proof that a preview was viewed. There is no time-based expiry: an intervening incident event can invalidate the preview immediately, including a fresh memory session. The result may become stale after it is returned, so confirmation must still validate it.

“Read-only” means no durable incident mutation. FalkorDB creates and deletes temporary derived graphs, so its connection still needs projection permissions. Existing API clients can omit the optional preview reference and retain ordinary sequence-checked withdrawal. The browser always submits a reference; the server does not enforce preview viewing for every client. MCP remains unchanged with four bounded read-only tools.

## Reproducible isolated demo

From the repository root, after installing dependencies:

```bash
npm ci
npm run demo:withdrawal-preview
```

The command starts an assigned loopback HTTP port, temporary PGlite, embedded FalkorDB and private queue Redis. It uses an explicit configuration without inherited database URLs or provider settings, does not load `.env`, and does not touch the normal `.data` workspace. No external database, Docker or paid API is required. It needs the installed native engine and permission to create local sockets.

The [demo script](../scripts/demo-withdrawal-preview.ts) asserts these outcomes through real HTTP requests:

1. Create checkout; preview E1-v1. C2-v1 and C3-v1 are affected and C2 loses support.
2. Preview E3-v1. C4 retains E4's alternative support and C5's report conclusion needs no review. Verify both previews left the incident and work ledger unchanged.
3. Create a fresh session to advance the incident. Confirm the old preview and verify 409 with no correction.
4. Refresh the E1 preview, confirm it, and wait for BullMQ repair. Verify a new report, C2 unsupported, C4 supported and the first report unchanged.
5. Replay the identical confirmation after repair and verify only one correction exists.

PASS lines are printed only after their assertions execute. Success also requires exit status zero, including resource cleanup. The script deletes its owned temporary directory in `finally`; process termination or a service outage can still prevent cleanup. Incident IDs, timestamps and ports vary; assertions and fixture semantics are reproducible. This demo does not benchmark performance.

## Browser walkthrough

1. Run `npm run dev`, open http://127.0.0.1:5173, and choose **New investigation**. Leave live-agent activation off.
2. Select **Database pool exhaustion** and click **Withdraw source**. Wait for **Impact comparison**. C2/C3 lose support; the payment findings remain supported. Expand support groups/provenance, report conclusions/citations, related services and evidence impact paths.
3. Click **Cancel**. The evidence remains active; no correction or repair has been created.
4. Select **Payment latency spike** (E3-v1) and reopen the dialog. C4 remains supported through the independent E4 alternative. Its provenance can change while the conclusion survives. Cancel again.
5. Reopen E1's dialog. In another tab viewing the same incident, open **Correction memory** and **Open fresh session**. Polling marks the original preview out of date and disables confirmation. Click **Refresh preview** to calculate against the new snapshot.
6. Enter a reason and click **Withdraw evidence**. Follow repair progress, then compare report versions. An actual correction is created only at this confirmation step.

For a presentation, capture the E1 before/after table, E3 surviving alternative groups, stale-preview message and repaired report history. The same dialog supports narrow screens. This is demo guidance, not a claim that screenshots or a separate human walkthrough were performed.

## API usage

Create an incident with `POST /api/incidents` and `{"scenario":"checkout"}`. Use its returned ID and sequence; all placeholders below must be replaced.

```http
POST /api/incidents/INCIDENT_ID/evidence/E1-v1/withdrawal-preview
Content-Type: application/json

{"expectedEventSeq":1}
```

The response conforms to [`withdrawalPreviewSchema`](../packages/contracts/src/withdrawal-preview.ts). Its fields are `kind`, `readOnly`, `snapshot`, `evidenceId`, `affectedClaimIds`, `claims`, `paths`, `conclusions` and `services`. The POST request computes an advisory read and returns `Cache-Control: no-store`; it does not require an idempotency key.

Send only the response's `snapshot` and `evidenceId` inside the confirmation's `preview` field, not the entire comparison:

```javascript
const confirmation = {
  expectedEventSeq: preview.snapshot.eventSeq,
  idempotencyKey: crypto.randomUUID(),
  reason: 'Source environment verified as staging',
  preview: { snapshot: preview.snapshot, evidenceId: preview.evidenceId },
};
// POST this JSON to /api/incidents/INCIDENT_ID/evidence/E1-v1/withdrawals.
```

The isolated demo executes this exact request pattern, including stale rejection and idempotent replay. Malformed requests return 400; unknown incident/evidence returns 404; stale/inapplicable preview returns 409; graph/service failure returns 503. Foreign browser origins are rejected with 403. On 409, fetch current state and calculate a new preview rather than changing the old reference's sequence. Preserve the original key and body only when retrying the identical confirmation.

The client validates successful responses against the shared schema, checks incident/evidence/sequence identity and cancels or ignores obsolete requests. Loading, failure, stale state and inactive evidence disable confirmation. A failed confirmation requires a refreshed preview before trying again.

## Verification and limits

Executed during the safety sub-milestone on Linux x64:

| Check                                                  | Observed result                                                                                                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph, API and client focused suite                    | 36 passed; one independent-PostgreSQL-client test skipped in local mode.                                                                                                     |
| Disposable PostgreSQL suite                            | 150 passed, including the independent-client test and concurrent confirmation checks.                                                                                        |
| Preview browser suite                                  | 6 passed after the final validation change: real confirmation, mobile/stale refresh, service failure, late cancelled response, update during loading and malformed response. |
| Final client unit suite                                | 5 passed.                                                                                                                                                                    |
| Typecheck, production build, formatting and whitespace | Passed. Runtime schema validation is loaded on demand; the final build had no oversized-chunk warning.                                                                       |

These are recorded executions, not a claim that every suite was rerun for this documentation change. The original release report remains a separate record. The isolated demo's execution is recorded below.

A regression first demonstrated that malformed HTTP 200 responses were accepted by the client. Runtime validation fixed that gap, and the focused/browser reruns passed. Earlier frontend testing found an incident-selection race in test setup; binding the test to the creation response fixed it. Concurrent browser runners also collided in their shared artifact directory; run browser commands sequentially.

- Preview cost includes two full graph projections and related service queries. No production load, latency, memory or large-incident performance guarantee has been measured.
- Cancelling a browser request stops or ignores client handling; it does not guarantee cancellation of server graph computation. Normal completion still performs cleanup.
- A process crash or failed graph deletion can leave temporary graphs behind. Deletion failure is surfaced as an error; automatic orphan sweeping is not implemented.
- Report comparison identifies support and citation risks; it does not evaluate prose quality or generate repaired language. Real repair still passes the existing sequence/manifest/lease checks.
- The deployment remains a trusted local workspace. Preview fingerprints do not add authentication or multi-tenant authorization.
- No paid model verification was performed. Chromium and Linux x64 were tested; other browsers/platforms and remote deployments remain unverified.

## Documentation demo execution

`npm run demo:withdrawal-preview` executed successfully with exit status zero. All three assertion groups passed:

- Previews made no durable changes; E1 affected C2/C3 and E3 retained alternative support.
- An intervening session invalidated the old preview; the rejected confirmation created no correction.
- A refreshed confirmation completed repair, retained the first report and independent findings, and replayed without a duplicate correction.

The command closed its owned services and removed its temporary directory. `npm run typecheck` also passed with the new demo script. This run used real local engines and no model requests. It was an automated execution, not a separate developer manual acceptance review.
