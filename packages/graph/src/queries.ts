// Database-authoritative support reasoning; TypeScript schedules dependency layers only.
export const READY_CLAIMS = `
MATCH (c:ClaimVersion) WHERE c.evaluationStatus IS NULL
OPTIONAL MATCH (c)-[:HAS_SUPPORT]->(:SupportGroup)-[:REQUIRES]->(m)
WITH c, collect(m) AS premises
WHERE all(m IN premises WHERE m.kind = 'evidence' OR m.evaluationStatus IS NOT NULL)
RETURN c.id AS id`;

export const EVALUATE_GROUPS = `
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
    g.valid = size(reasons) = 0`;

export const EVALUATE_CLAIMS = `
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
    CASE WHEN g.polarity = 'support' AND g.valid THEN acc + g.originGroupIds ELSE acc END))`;

export const MEMBERSHIPS = `
MATCH (c:ClaimVersion)-[:HAS_SUPPORT]->(g:SupportGroup)-[r:REQUIRES]->(m)
WITH c, g, r, m ORDER BY c.position, g.position, r.position
RETURN c.id AS claimId, g.id AS id, g.polarity AS polarity, g.ruleId AS ruleId, g.position AS position,
  g.valid AS valid, g.reasons AS reasons, collect(m.id) AS memberIds`;

export const IMPACT = `
MATCH p=(c:ClaimVersion)-[:DERIVED_FROM*1..12]->(e:EvidenceVersion {id: $id})
RETURN c.id AS claimId, [n IN nodes(p) | n.id] AS path`;

export const SERVICE_IMPACT = `
MATCH (caller:Service), (dependency:Service {id: $serviceId}) WHERE caller <> dependency
WITH caller, shortestPath((caller)-[:DEPENDS_ON*]->(dependency)) AS p
WHERE p IS NOT NULL
RETURN caller.id AS serviceId, length(p) AS hops, [n IN nodes(p) | n.id] AS path
ORDER BY hops, serviceId`;

export const CENTRALITY = `
CALL algo.pageRank('Service', 'DEPENDS_ON') YIELD node, score
RETURN node.id AS serviceId, score ORDER BY score DESC, serviceId`;
