import type { Graph } from 'falkordb';
import type { Diagnostic, DiagnosticRecipe, Incident, ServiceImpact } from '@aftermath/contracts';
import { diagnosticRecipes } from '@aftermath/fixtures';
import { CENTRALITY, SERVICE_IMPACT } from './queries';

export async function projectServices(graph: Graph, incident: Incident) {
  const topology = incident.topology ?? {
    services: [...new Set(incident.evidence.map((e) => e.service))].map((id) => ({
      id,
      name: id,
      tier: 0,
    })),
    dependencies: [],
  };
  const ids = new Set(topology.services.map((s) => s.id));
  if (ids.size !== topology.services.length || ids.size > 128 || topology.dependencies.length > 512)
    throw new Error('Invalid or oversized service topology');
  if (
    topology.dependencies.some(
      (d) => !ids.has(d.caller) || !ids.has(d.dependency) || d.caller === d.dependency,
    )
  )
    throw new Error('Invalid service dependency');
  if (incident.evidence.some((e) => !ids.has(e.service)))
    throw new Error('Unknown evidence service');
  if (incident.claims.some((c) => c.serviceIds?.some((id) => !ids.has(id))))
    throw new Error('Unknown claim service');
  const recipes =
    incident.diagnosticRecipes ??
    diagnosticRecipes.filter(
      (r) =>
        ids.has(r.serviceId) &&
        r.informs.every((id) => incident.claims.some((c) => c.id === id)) &&
        r.prerequisiteIds.every((id) => incident.evidence.some((e) => e.id === id)),
    );
  if (
    new Set(recipes.map((r) => r.id)).size !== recipes.length ||
    recipes.some(
      (r) =>
        !ids.has(r.serviceId) ||
        !Number.isFinite(r.estimatedCost) ||
        r.estimatedCost < 0 ||
        r.informs.some((id) => !incident.claims.some((c) => c.id === id)) ||
        r.prerequisiteIds.some((id) => !incident.evidence.some((e) => e.id === id)),
    )
  )
    throw new Error('Invalid diagnostic graph recipe');
  await graph.query(
    `UNWIND $rows AS row CREATE (:Service {id: row.id, name: row.name, tier: row.tier})`,
    { params: { rows: topology.services } },
  );
  await graph.query(
    `UNWIND $rows AS row MATCH (a:Service {id: row.caller}), (b:Service {id: row.dependency}) MERGE (a)-[:DEPENDS_ON]->(b)`,
    { params: { rows: topology.dependencies } },
  );
  await graph.query(
    `UNWIND $rows AS row MATCH (n {id: row.id}), (s:Service {id: row.serviceId}) WHERE n.kind IS NOT NULL MERGE (n)-[:ABOUT]->(s)`,
    {
      params: {
        rows: [
          ...incident.evidence.map((e) => ({ id: e.id, serviceId: e.service })),
          ...incident.claims.flatMap((c) =>
            (c.serviceIds ?? []).map((serviceId) => ({ id: c.id, serviceId })),
          ),
        ],
      },
    },
  );
  // Legacy ledgers lack claim service IDs. Derive those links from their actual evidence paths.
  await graph.query(
    `MATCH (c:ClaimVersion)-[:DERIVED_FROM*1..12]->(:EvidenceVersion)-[:ABOUT]->(s:Service)
    WHERE c.id IN $ids MERGE (c)-[:ABOUT]->(s)`,
    { params: { ids: incident.claims.filter((c) => !c.serviceIds).map((c) => c.id) } },
  );
  await graph.query(
    `UNWIND $rows AS row MATCH (s:Service {id: row.serviceId})
    CREATE (d:DiagnosticRecipe {id: row.id, payload: row.payload, completed: row.completed, estimatedCost: row.estimatedCost, environment: row.environment, timeWindow: row.timeWindow})-[:RUNS_ON]->(s)`,
    {
      params: {
        rows: recipes.map((r) => ({
          ...r,
          environment: incident.claims.find((c) => c.id === r.informs[0])?.scope.environment ?? '',
          timeWindow: incident.claims.find((c) => c.id === r.informs[0])?.scope.timeWindow ?? '',
          payload: JSON.stringify(r),
          completed: (incident.completedDiagnosticIds ?? []).includes(r.id),
        })),
      },
    },
  );
  await graph.query(
    `UNWIND $rows AS row MATCH (d:DiagnosticRecipe {id: row.recipeId}), (c:ClaimVersion {id: row.claimId}) CREATE (d)-[:CHECKS]->(c)`,
    {
      params: {
        rows: recipes.flatMap((r) => r.informs.map((claimId) => ({ recipeId: r.id, claimId }))),
      },
    },
  );
  await graph.query(
    `UNWIND $rows AS row MATCH (d:DiagnosticRecipe {id: row.recipeId}), (e:EvidenceVersion {id: row.evidenceId}) CREATE (d)-[:NEEDS]->(e)`,
    {
      params: {
        rows: recipes.flatMap((r) =>
          r.prerequisiteIds.map((evidenceId) => ({ recipeId: r.id, evidenceId })),
        ),
      },
    },
  );
}

export const DIAGNOSTIC_PATHS = `
MATCH (d:DiagnosticRecipe)-[:CHECKS]->(c:ClaimVersion)-[:ABOUT]->(s:Service), (d)-[:RUNS_ON]->(s)
WHERE c.evaluationStatus <> 'supported'
RETURN d.id AS recipeId, c.id AS claimId, [s.id] AS serviceIds
UNION
MATCH (d:DiagnosticRecipe)-[:CHECKS]->(c:ClaimVersion)-[:ABOUT]->(s:Service), (d)-[:RUNS_ON]->(target:Service)
WHERE c.evaluationStatus <> 'supported' AND s <> target
WITH d, c, shortestPath((s)-[:DEPENDS_ON*]->(target)) AS p
WHERE p IS NOT NULL
RETURN d.id AS recipeId, c.id AS claimId, [n IN nodes(p) | n.id] AS serviceIds`;

// FalkorDB computes shortest distances. Resolve equal-length choices by service ID,
// independent of insertion order, without enumerating exponentially many paths.
function canonicalPaths(
  paths: ServiceImpact['paths'],
  edges: ServiceImpact['topology']['dependencies'],
  target: string,
): ServiceImpact['paths'] {
  const distances = new Map(paths.map((p) => [p.serviceId, p.hops]));
  distances.set(target, 0);
  const outgoing = new Map<string, string[]>();
  for (const edge of edges)
    outgoing.set(edge.caller, [...(outgoing.get(edge.caller) ?? []), edge.dependency]);
  return paths
    .map((row) => {
      const path = [row.serviceId];
      for (let remaining = row.hops; remaining > 0; remaining--) {
        const next = (outgoing.get(path.at(-1)!) ?? [])
          .filter((id) => distances.get(id) === remaining - 1)
          .sort()[0];
        if (!next) throw new Error('Incomplete graph shortest-path result');
        path.push(next);
      }
      return { ...row, path };
    })
    .sort((a, b) => a.hops - b.hops || a.serviceId.localeCompare(b.serviceId));
}

async function dependencyEdges(graph: Graph) {
  const result = await graph.roQuery<{ caller: string; dependency: string }>(
    'MATCH (a:Service)-[:DEPENDS_ON]->(b:Service) RETURN a.id AS caller, b.id AS dependency ORDER BY caller, dependency',
  );
  if (!result.data) throw new Error('Missing service dependency result');
  return result.data;
}

export async function graphDiagnostics(graph: Graph, generation: string): Promise<Diagnostic[]> {
  const recipes = await graph.roQuery<{
    id: string;
    payload: string;
    completed: boolean;
    available: boolean;
    informs: string[];
  }>(`
    MATCH (d:DiagnosticRecipe)-[:CHECKS]->(c:ClaimVersion)
    WITH d, collect(c.id) AS informs
    OPTIONAL MATCH (d)-[:NEEDS]->(e:EvidenceVersion)
    WITH d, informs, collect(e) AS prerequisites
    RETURN d.id AS id, d.payload AS payload, d.completed AS completed, informs,
      NOT d.completed AND all(e IN prerequisites WHERE e.status = 'active' AND e.environment = d.environment AND e.timeWindow = d.timeWindow) AS available`);
  const found = await graph.roQuery<{ recipeId: string; claimId: string; serviceIds: string[] }>(
    DIAGNOSTIC_PATHS,
  );
  if (!recipes.data || !found.data) throw new Error('Missing diagnostic graph result');
  const edges = await dependencyEdges(graph);
  const canonical = new Map<string, Map<string, string[]>>();
  for (const target of new Set(found.data.map((p) => p.serviceIds.at(-1)!))) {
    const result = await graph.roQuery<ServiceImpact['paths'][number]>(SERVICE_IMPACT, {
      params: { serviceId: target },
    });
    if (!result.data) throw new Error('Missing diagnostic path result');
    canonical.set(
      target,
      new Map([
        [target, [target]],
        ...canonicalPaths(result.data, edges, target).map(
          (p) => [p.serviceId, p.path] as [string, string[]],
        ),
      ]),
    );
  }
  for (const path of found.data) {
    const resolved = canonical.get(path.serviceIds.at(-1)!)?.get(path.serviceIds[0]);
    if (!resolved) throw new Error('Missing diagnostic service path');
    path.serviceIds = resolved;
  }
  return (recipes.data ?? [])
    .map((row) => {
      const recipe = JSON.parse(row.payload) as DiagnosticRecipe;
      const shortest = new Map<string, string[]>();
      for (const path of found.data ?? []) {
        if (path.recipeId !== row.id) continue;
        const old = shortest.get(path.claimId);
        if (
          !old ||
          path.serviceIds.length < old.length ||
          (path.serviceIds.length === old.length &&
            JSON.stringify(path.serviceIds) < JSON.stringify(old))
        )
          shortest.set(path.claimId, path.serviceIds);
      }
      const paths = [...shortest]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([claimId, serviceIds]) => ({ claimId, serviceIds }));
      const proximity = paths.reduce((sum, p) => sum + 1 / p.serviceIds.length, 0);
      return {
        id: row.id,
        title: recipe.title,
        description: recipe.description,
        informs: [...row.informs].sort(),
        estimatedCost: recipe.estimatedCost,
        completed: row.completed,
        available: row.available,
        score: row.available ? (paths.length + 0.1 * proximity) / (1 + recipe.estimatedCost) : 0,
        reason: row.completed
          ? 'Observation already recorded.'
          : !row.available
            ? 'Required evidence is unavailable.'
            : paths.length
              ? `Graph paths connect this check to ${paths.length} unresolved findings. Ranked by coverage, path proximity, and relative fixture cost.`
              : 'Available as a follow-up check; no unresolved findings have an applicable service path.',
        graphGeneration: generation,
        paths,
      };
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export async function serviceImpact(
  graph: Graph,
  generation: string,
  seq: number,
  serviceId: string,
): Promise<ServiceImpact> {
  const exists = await graph.roQuery<{ id: string }>(
    'MATCH (s:Service {id: $serviceId}) RETURN s.id AS id',
    { params: { serviceId } },
  );
  if (!exists.data) throw new Error('Missing service lookup result');
  if (!exists.data.length) throw new Error('Unknown service');
  const paths = await graph.roQuery<ServiceImpact['paths'][number]>(SERVICE_IMPACT, {
    params: { serviceId },
  });
  const nodes = await graph.roQuery<{ id: string; name: string; tier: number }>(
    'MATCH (s:Service) RETURN s.id AS id, s.name AS name, s.tier AS tier ORDER BY s.tier, s.id',
  );
  const edges = await dependencyEdges(graph);
  const centrality = await graph.roQuery<ServiceImpact['centrality'][number]>(CENTRALITY);
  if (!paths.data || !nodes.data || !centrality.data)
    throw new Error('Missing service analysis result');
  return {
    topology: { services: nodes.data, dependencies: edges },
    serviceId,
    generation,
    projectedSeq: seq,
    paths: canonicalPaths(paths.data, edges, serviceId),
    centrality: centrality.data,
  };
}
