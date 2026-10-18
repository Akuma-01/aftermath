# Submission notes

## Product pitch

An incident report can become misleading when one of its sources is withdrawn. Aftermath uses FalkorDB relationships and Cypher support evaluation to preview which findings, support groups, citations, services and report conclusions change, then repairs the report while preserving independently supported conclusions. SQL retains the correction and report history; background workers publish only against current incident state.

See the [screenshots and reproducible demo](demo.md) and [graph model with actual Cypher](graph-model.md).

## Track positioning

Track selection is awaiting developer confirmation. The supplied review recommends Track 1 as the primary entry and identifies Track 3 as a possible additional entry for source traceability and keeping knowledge current. This is a positioning proposal, not a verification of the event's official criteria. Name the selected tracks explicitly in the submission after checking those criteria; Track 2 is not proposed.

## Demonstrated behavior and limits

- The supplied screenshots show fixture-based evidence inspection, withdrawal impact comparison and repaired report revisions. The commerce preview and checkout screenshots are different scenarios.
- The deterministic lifecycle demo uses actual FalkorDB, SQL and background repair operations. Synthetic evidence does not imply mocked graph reasoning.
- The developer-reported Gemini attempt exhausted three investigator attempts, each timing out after 45 seconds. No successful live report or live-model quality is claimed. Usage was not reported; timeout does not prove zero usage or zero cost. Provider availability and the cause remain unverified.
- Benchmark comparisons concern statements flagged for re-review on synthetic cases. Report fewer flagged statements only when supported by an executed comparison; no LLM token or cost savings are measured.

## Architectural tradeoffs

**Graph lifetime.** Published incident generations remain cached until the graph client closes. Memory can grow with incident event sequences in a long-running process. Immutable generations protect snapshot consistency, but bounded eviction and crash-orphan cleanup remain operational work. Temporary withdrawal-preview graphs have a separate disposable lifecycle; they do not solve retained-generation growth.

**Ledger enforcement.** SQL is authoritative, and application commands use transactions, row locks, sequence checks and idempotency. TypeScript history validators enforce evidence-history preservation, immutable report revisions and event continuity inside those commands. Job and audit tables have SQL constraints; the nested JSONB incident snapshot does not have equivalent database triggers for every history invariant. Direct database writes can bypass the application validators. This is the current storage tradeoff, not a claim that all invariants are database-enforced.

## Submission checklist

- Confirm and explicitly name entered tracks against the official rules.
- Include the repository URL and a recording of a fresh deterministic incident: graph, preview, confirmed withdrawal and repaired revision diff.
- Describe the demo as synthetic incident data with real graph reasoning and repair, without claiming successful live Gemini execution.
- Use the concrete [AI-assistance disclosure](../README.md#acknowledgments); distinguish the supplied reference architecture from the added withdrawal-preview work. Confirm reuse eligibility with the organizer rather than implying all components originated during the event.
- Keep keys, local databases and provider traces out of the submission. Explain AND premises, OR alternatives and contested support using the linked Cypher queries.

Historical verification reports retain their original scope. This documentation pass does not rerun the application suites or establish new performance results.
