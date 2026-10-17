# Graph model and executable queries

These are the actual parameterized queries from `packages/graph/src/queries.ts`. They execute within an incident-specific graph generation. Evaluation writes run only while constructing a private generation, before `Projection.ready` is published. The API and MCP do not expose arbitrary Cypher.

Evidence and claims carry environment and exact time-window scope. `HAS_SUPPORT` connects claims to positive or opposition groups; `REQUIRES` expresses AND premises. Positive groups are OR alternatives. Only supported claims and active evidence can serve as premises. Valid opposition contests otherwise supported claims; opposition alone does not establish support. `DERIVED_FROM` includes transitive claim dependencies, and `RETRACTS` preserves correction provenance. Origin groups deduplicate source lineage without implying statistical independence.

`Service -DEPENDS_ON-> Service` points from caller to dependency. Blast radius traverses incoming callers; PageRank measures dependency importance, not confidence in a cause. Diagnostic `RUNS_ON`, `CHECKS`, `NEEDS`, and artifact `ABOUT` relationships provide prerequisite checks and coverage; see `packages/graph/src/services.ts` for the recipe queries and deterministic path tie-breaking.

## READY_CLAIMS

```cypher
MATCH (c:ClaimVersion) WHERE c.evaluationStatus IS NULL
OPTIONAL MATCH (c)-[:HAS_SUPPORT]->(:SupportGroup)-[:REQUIRES]->(m)
WITH c, collect(m) AS premises
WHERE all(m IN premises WHERE m.kind = 'evidence' OR m.evaluationStatus IS NOT NULL)
RETURN c.id AS id
```

## EVALUATE_GROUPS

```cypher
MATCH (c:ClaimVersion)-[:HAS_SUPPORT]->(g:SupportGroup)-[r:REQUIRES]->(m)
WHERE c.id IN $ids
WITH c, g, r, m ORDER BY g.position, r.position
WITH c, g, collect(
  CASE WHEN m.environment <> c.environment OR m.timeWindow <> c.timeWindow
    THEN [m.id + ': scope does not match ' + c.environment + ' / ' + c.timeWindow] ELSE [] END +
  CASE WHEN m.kind = 'evidence' AND m.status <> 'active'
    THEN [m.id + ': ' + m.status]
    WHEN m.kind = 'claim' AND m.evaluationStatus <> 'supported'
    THEN [m.id + ': ' + m.evaluationStatus] ELSE [] END
) AS problems, collect(coalesce(m.originGroupIds, [])) AS origins
WITH g, origins, reduce(acc = [], item IN problems | acc + item) AS reasons
SET g.reasons = reasons,
    g.originGroupIds = list.dedup(reduce(acc = [], item IN origins | acc + item)),
    g.valid = size(reasons) = 0
```

## EVALUATE_CLAIMS

```cypher
MATCH (c:ClaimVersion) WHERE c.id IN $ids
OPTIONAL MATCH (c)-[:HAS_SUPPORT]->(g:SupportGroup)
WITH c, g ORDER BY g.position
WITH c, collect(g) AS groups
SET c.evaluationStatus = CASE
  WHEN any(g IN groups WHERE g.polarity = 'support' AND g.valid)
  THEN CASE WHEN any(g IN groups WHERE g.polarity = 'opposition' AND g.valid)
    THEN 'contested' ELSE 'supported' END
  ELSE 'unsupported' END,
  c.originGroupIds = list.dedup(reduce(acc = [], g IN groups |
    CASE WHEN g.polarity = 'support' AND g.valid THEN acc + g.originGroupIds ELSE acc END))
```

## MEMBERSHIPS

```cypher
MATCH (c:ClaimVersion)-[:HAS_SUPPORT]->(g:SupportGroup)-[r:REQUIRES]->(m)
WITH c, g, r, m ORDER BY c.position, g.position, r.position
RETURN c.id AS claimId, g.id AS id, g.polarity AS polarity, g.ruleId AS ruleId, g.position AS position,
  g.valid AS valid, g.reasons AS reasons, collect(m.id) AS memberIds
```

## IMPACT

```cypher
MATCH p=(c:ClaimVersion)-[:DERIVED_FROM*1..12]->(e:EvidenceVersion {id: $id})
RETURN c.id AS claimId, [n IN nodes(p) | n.id] AS path
```

## SERVICE_IMPACT

```cypher
MATCH (caller:Service), (dependency:Service {id: $serviceId}) WHERE caller <> dependency
WITH caller, shortestPath((caller)-[:DEPENDS_ON*]->(dependency)) AS p
WHERE p IS NOT NULL
RETURN caller.id AS serviceId, length(p) AS hops, [n IN nodes(p) | n.id] AS path
ORDER BY hops, serviceId
```

## CENTRALITY

```cypher
CALL algo.pageRank('Service', 'DEPENDS_ON') YIELD node, score
RETURN node.id AS serviceId, score ORDER BY score DESC, serviceId
```

`$ids` identifies the next dependency layer; `$id` is an exact evidence-version ID; `$serviceId` identifies a service. SQL publication independently checks incident sequence, epoch, report version, artifact manifest and worker lease. A ready graph does not authorize stale publication. Failed projection never becomes active; a failed graph read never falls back to a successful TypeScript evaluation.

## Withdrawal preview isolation

`EvidenceGraph.previewWithdrawal()` creates two private projections from one captured incident: the baseline and a copy with only the selected active evidence version marked withdrawn. Both use the same Cypher evaluator above. `IMPACT` identifies potentially affected claims, `MEMBERSHIPS` supplies positive/opposition group comparisons, and `ABOUT` plus service dependency queries supply contextual service paths. The projections do not enter the live generation cache and are deleted after the request, including failed evaluation. Cleanup failure rejects the preview and may leave an orphan requiring operational cleanup.

No correction, report, sequence increment, epoch change or job is persisted by previewing. The returned fingerprint describes the captured input, not an authorization token or a persistent graph generation. See [withdrawal preview](withdrawal-preview.md) for confirmation checks and reproducible examples.
