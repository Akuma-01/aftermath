import {
  claimSchema,
  evaluationSchema,
  evidenceSchema,
  reportSchema,
  type Claim,
  type Evidence,
  type Evaluation,
  type Report,
  type Statement,
  type SupportGroup,
} from '@aftermath/contracts';

export const MAX_DEPENDENCY_DEPTH = 12;

/** Validate both support and opposition before evaluating any claim. */
export function validateGraph(evidence: readonly Evidence[], claims: readonly Claim[]): void {
  evidenceSchema.array().parse(evidence);
  claimSchema.array().parse(claims);

  const ids = new Set<string>();
  for (const artifact of [...evidence, ...claims]) {
    if (ids.has(artifact.id)) throw new Error(`Duplicate artifact: ${artifact.id}`);
    ids.add(artifact.id);
  }

  const groupIds = new Set<string>();
  for (const claim of claims) {
    for (const group of [...claim.supportGroups, ...claim.oppositionGroups]) {
      if (groupIds.has(group.id)) throw new Error(`Duplicate support group: ${group.id}`);
      groupIds.add(group.id);
      for (const id of group.memberIds) {
        if (!ids.has(id)) throw new Error(`Unknown premise: ${id}`);
      }
    }
  }

  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const depths = new Map<string, number>();
  function depth(id: string, visiting: Set<string>): number {
    if (visiting.has(id)) throw new Error(`Support cycle at ${id}`);
    const known = depths.get(id);
    if (known !== undefined) return known;
    const claim = byId.get(id);
    if (!claim) return 0;
    // Bound recursion itself, including reverse-ordered input with a very long chain.
    if (visiting.size >= MAX_DEPENDENCY_DEPTH)
      throw new Error(`Dependency depth exceeds ${MAX_DEPENDENCY_DEPTH}`);
    const next = new Set(visiting).add(id);
    const members = [...claim.supportGroups, ...claim.oppositionGroups].flatMap(
      (group) => group.memberIds,
    );
    const value = 1 + Math.max(0, ...members.map((member) => depth(member, next)));
    if (value > MAX_DEPENDENCY_DEPTH)
      throw new Error(`Dependency depth exceeds ${MAX_DEPENDENCY_DEPTH}`);
    depths.set(id, value);
    return value;
  }
  for (const claim of claims) depth(claim.id, new Set());
}

/** Independent TypeScript evaluator. No I/O, clock, persistence or graph-engine dependency. */
export function evaluateSupport(
  evidence: readonly Evidence[],
  claims: readonly Claim[],
): Evaluation[] {
  validateGraph(evidence, claims);
  const sources = new Map(evidence.map((source) => [source.id, source]));
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const results = new Map<string, Evaluation>();

  function evaluate(claim: Claim): Evaluation {
    const existing = results.get(claim.id);
    if (existing) return existing;

    function groupResult(group: SupportGroup) {
      const reasons: string[] = [];
      const origins = new Set<string>();
      for (const id of group.memberIds) {
        const source = sources.get(id);
        const premise = source ?? byId.get(id)!;
        if (
          premise.scope.environment !== claim.scope.environment ||
          premise.scope.timeWindow !== claim.scope.timeWindow
        ) {
          reasons.push(
            `${id}: scope does not match ${claim.scope.environment} / ${claim.scope.timeWindow}`,
          );
        }
        if (source) {
          if (source.status !== 'active') reasons.push(`${id}: ${source.status}`);
          else origins.add(source.originGroupId);
        } else {
          const result = evaluate(byId.get(id)!);
          if (result.status !== 'supported') reasons.push(`${id}: ${result.status}`);
          result.originGroupIds.forEach((origin) => origins.add(origin));
        }
      }
      return { id: group.id, reasons, origins };
    }

    const support = claim.supportGroups.map(groupResult);
    const valid = support.filter((group) => group.reasons.length === 0);
    const opposed = claim.oppositionGroups.some((group) => groupResult(group).reasons.length === 0);
    const result: Evaluation = {
      claimId: claim.id,
      status: valid.length ? (opposed ? 'contested' : 'supported') : 'unsupported',
      validGroupIds: valid.map((group) => group.id),
      invalidGroups: support
        .filter((group) => group.reasons.length > 0)
        .map(({ id, reasons }) => ({ id, reasons })),
      originGroupIds: [...new Set(valid.flatMap((group) => [...group.origins]))],
    };
    results.set(claim.id, result);
    return result;
  }

  return claims.map(evaluate);
}

/** Format a new revision without changing the previous one. Supply createdAt for reproducible data. */
export function makeReport(
  claims: readonly Claim[],
  evaluations: readonly Evaluation[],
  epoch: number,
  previous?: Report,
  createdAt = new Date().toISOString(),
): Report {
  claimSchema.array().parse(claims);
  evaluationSchema.array().parse(evaluations);
  if (previous) reportSchema.parse(previous);

  const claimIds = new Set(claims.map((claim) => claim.id));
  if (claimIds.size !== claims.length) throw new Error('Duplicate report claim');
  const byId = new Map<string, Evaluation>();
  for (const evaluation of evaluations) {
    if (!claimIds.has(evaluation.claimId))
      throw new Error(`Unknown evaluation claim: ${evaluation.claimId}`);
    if (byId.has(evaluation.claimId))
      throw new Error(`Duplicate evaluation: ${evaluation.claimId}`);
    byId.set(evaluation.claimId, evaluation);
  }

  const statements = claims.map((claim): Statement => {
    const evaluation = byId.get(claim.id);
    if (!evaluation) throw new Error(`Missing evaluation: ${claim.id}`);
    const { status } = evaluation;
    let text = claim.text;
    if (status === 'unsupported')
      text = `Insufficient current ${claim.scope.environment} evidence for: ${claim.title.toLowerCase()}. This finding remains unconfirmed.`;
    if (status === 'contested')
      text = `Conflicting evidence for: ${claim.title.toLowerCase()}. Resolve the conflicting observations before drawing a conclusion.`;
    if (status === 'needs_review')
      text = `Awaiting validation against current evidence for: ${claim.title.toLowerCase()}.`;

    const old = previous?.statements.find((statement) => statement.claimId === claim.id);
    return {
      id: `S-${claim.id}`,
      claimId: claim.id,
      title: claim.title,
      text,
      status,
      validatedEpoch: epoch,
      disposition: !old
        ? 'initial'
        : old.text === text && old.status === status
          ? 'preserved'
          : 'revised',
    };
  });

  return reportSchema.parse({
    version: (previous?.version ?? 0) + 1,
    createdAt,
    evidenceEpoch: epoch,
    statements,
  });
}
