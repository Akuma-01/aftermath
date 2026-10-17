import type { Claim, Evidence, SupportStatus } from '@aftermath/contracts';

export interface GraphInput {
  evidence: Evidence[];
  claims: Claim[];
}
export interface EvaluationCase {
  id: string;
  family: string;
  description: string;
  before: GraphInput;
  after: GraphInput;
  changedEvidenceIds: string[];
  initialCitations: Record<string, string[]>;
  oracle: {
    beforeStates: Record<string, SupportStatus>;
    afterStates: Record<string, SupportStatus>;
    afterOriginCounts: Record<string, number>;
    affectedClaimIds: string[];
    requiredReviewIds: string[];
  };
}
export interface InvalidCase {
  id: string;
  graph: GraphInput;
  expectedError: string;
}
const S = 'supported',
  U = 'unsupported',
  C = 'contested';
const scope = { environment: 'production', timeWindow: 'evaluation-window' };
function source(id: string): Evidence {
  return {
    id,
    sourceId: id,
    version: 1,
    title: id,
    summary: `Synthetic observation ${id}`,
    content: `Synthetic observation ${id}`,
    source: 'Evaluation fixture',
    service: 'evaluation',
    observedAt: '2026-09-25T10:00:00.000Z',
    scope: { ...scope },
    status: 'active',
    originGroupId: `origin-${id}`,
    kind: 'metric',
  };
}
function claim(id: string, groups: string[][], opposition: string[][] = []): Claim {
  return {
    id,
    title: id,
    text: `Synthetic finding ${id}`,
    type: 'observation',
    scope: { ...scope },
    supportGroups: groups.map((memberIds, n) => ({
      id: `${id}-G${n}`,
      memberIds,
      ruleId: 'evaluation-support',
    })),
    oppositionGroups: opposition.map((memberIds, n) => ({
      id: `${id}-O${n}`,
      memberIds,
      ruleId: 'evaluation-opposition',
    })),
  };
}
interface Spec {
  id: string;
  description: string;
  claims: Claim[];
  before?: (sources: Evidence[]) => void;
  change: (sources: Evidence[]) => void;
  changed?: string[];
  statesBefore?: SupportStatus[];
  statesAfter: SupportStatus[];
  origins: number[];
  affected: string[];
  review: string[];
  citations: string[][];
}
const chain = () => [claim('A', [['E1']]), claim('B', [['A']]), claim('X', [['E3']])];
const withdraw = (sources: Evidence[]) => {
  sources[0].status = 'withdrawn';
};

// Ground truth is specified here, without importing any production evaluator,
// traversal, citation expander, or report selector. Variants only rename/reorder inputs.
const specs: Spec[] = [
  {
    id: 'chain',
    description: 'Root withdrawal invalidates a dependent chain.',
    claims: chain(),
    change: withdraw,
    statesAfter: [U, U, S],
    origins: [0, 0, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [['E1'], ['E1'], ['E3']],
  },
  {
    id: 'and',
    description: 'One withdrawn member breaks a sufficient AND group.',
    claims: [claim('A', [['E1', 'E2']]), claim('B', [['A', 'E3']]), claim('X', [['E3']])],
    change: withdraw,
    statesAfter: [U, U, S],
    origins: [0, 0, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [['E1', 'E2'], ['E1', 'E2', 'E3'], ['E3']],
  },
  {
    id: 'or-uncited',
    description: 'An uncited alternative is withdrawn; accepted citations remain valid.',
    claims: [claim('A', [['E1'], ['E2']]), claim('X', [['E3']])],
    change: withdraw,
    statesAfter: [S, S],
    origins: [1, 1],
    affected: ['A'],
    review: [],
    citations: [['E2'], ['E3']],
  },
  {
    id: 'or-cited',
    description: 'Support survives but a withdrawn citation requires report revision.',
    claims: [claim('A', [['E1'], ['E2']]), claim('X', [['E3']])],
    change: withdraw,
    statesAfter: [S, S],
    origins: [1, 1],
    affected: ['A'],
    review: ['A'],
    citations: [['E1'], ['E3']],
  },
  {
    id: 'or-exhausted',
    description: 'Withdrawing both alternatives removes support.',
    claims: [claim('A', [['E1'], ['E2']]), claim('X', [['E3']])],
    change: (e) => {
      withdraw(e);
      e[1].status = 'withdrawn';
    },
    changed: ['E1', 'E2'],
    statesAfter: [U, S],
    origins: [0, 1],
    affected: ['A'],
    review: ['A'],
    citations: [['E1'], ['E3']],
  },
  {
    id: 'copied-origin',
    description:
      'Both copies stay active after an uncited copy changes; they still count as one origin.',
    claims: [claim('A', [['E1'], ['E2']]), claim('X', [['E3']])],
    before: (e) => {
      e[1].originGroupId = e[0].originGroupId;
    },
    change: (e) => {
      e[0].content = 'Updated copy from the same recorded origin';
    },
    statesAfter: [S, S],
    origins: [1, 1],
    affected: ['A'],
    review: [],
    citations: [['E2'], ['E3']],
  },
  {
    id: 'environment',
    description: 'A staging-scope correction invalidates production support.',
    claims: chain(),
    change: (e) => {
      e[0].scope.environment = 'staging';
    },
    statesAfter: [U, U, S],
    origins: [0, 0, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [['E1'], ['E1'], ['E3']],
  },
  {
    id: 'time-window',
    description: 'Evidence from another incident window is ineligible.',
    claims: chain(),
    change: (e) => {
      e[0].scope.timeWindow = 'earlier-window';
    },
    statesAfter: [U, U, S],
    origins: [0, 0, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [['E1'], ['E1'], ['E3']],
  },
  {
    id: 'opposition-added',
    description: 'New admissible opposition contests a claim and invalidates its dependent.',
    claims: [claim('A', [['E1']], [['E2']]), claim('B', [['A']]), claim('X', [['E3']])],
    before: (e) => {
      e[1].status = 'quarantined';
    },
    change: (e) => {
      e[1].status = 'active';
    },
    changed: ['E2'],
    statesAfter: [C, U, S],
    origins: [1, 0, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [['E1'], ['E1'], ['E3']],
  },
  {
    id: 'opposition-removed',
    description: 'Withdrawing opposition restores uncontested support.',
    claims: [claim('A', [['E1']], [['E2']]), claim('B', [['A']]), claim('X', [['E3']])],
    change: (e) => {
      e[1].status = 'withdrawn';
    },
    changed: ['E2'],
    statesBefore: [C, U, S],
    statesAfter: [S, S, S],
    origins: [1, 1, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [[], [], ['E3']],
  },
  {
    id: 'diamond',
    description: 'A shared invalid root reaches a diamond once per claim.',
    claims: [
      claim('A', [['E1']]),
      claim('B', [['E1']]),
      claim('D', [['A', 'B', 'E2']]),
      claim('X', [['E3']]),
    ],
    change: withdraw,
    statesAfter: [U, U, U, S],
    origins: [0, 0, 0, 1],
    affected: ['A', 'B', 'D'],
    review: ['A', 'B', 'D'],
    citations: [['E1'], ['E1'], ['E1', 'E2'], ['E3']],
  },
  {
    id: 'content-change',
    description: 'A changed cited artifact requires review even when support status is unchanged.',
    claims: [claim('A', [['E1']]), claim('X', [['E3']])],
    change: (e) => {
      e[0].content = 'Revised synthetic measurement';
    },
    statesAfter: [S, S],
    origins: [1, 1],
    affected: ['A'],
    review: ['A'],
    citations: [['E1'], ['E3']],
  },
  {
    id: 'replacement',
    description:
      'A valid replacement version restores support while the old version stays withdrawn.',
    claims: [claim('A', [['E1'], ['R']]), claim('B', [['A']]), claim('X', [['E3']])],
    before: (e) => {
      e[0].status = 'withdrawn';
      e.push({ ...source('R'), sourceId: 'E1', version: 2, status: 'quarantined' });
    },
    change: (e) => {
      e.find((s) => s.id === 'R')!.status = 'active';
    },
    changed: ['R'],
    statesBefore: [U, U, S],
    statesAfter: [S, S, S],
    origins: [1, 1, 1],
    affected: ['A', 'B'],
    review: ['A', 'B'],
    citations: [[], [], ['E3']],
  },
];

function materialize(spec: Spec, variant: number): EvaluationCase {
  const evidence = ['E1', 'E2', 'E3'].map(source);
  spec.before?.(evidence);
  const after = structuredClone(evidence);
  spec.change(after);
  const prefix = `${spec.id}-${variant}`;
  const rename = (id: string) => `${prefix}:${id}`;
  const transform = (sources: Evidence[]): GraphInput => {
    const result = {
      evidence: sources.map((e) => ({
        ...e,
        id: rename(e.id),
        sourceId: rename(e.sourceId),
        originGroupId: rename(e.originGroupId),
      })),
      claims: structuredClone(spec.claims).map((c) => ({
        ...c,
        id: rename(c.id),
        supportGroups: c.supportGroups.map((g) => ({
          ...g,
          id: rename(g.id),
          memberIds: g.memberIds.map(rename),
        })),
        oppositionGroups: c.oppositionGroups.map((g) => ({
          ...g,
          id: rename(g.id),
          memberIds: g.memberIds.map(rename),
        })),
      })),
    };
    if (variant === 1) {
      result.evidence.reverse();
      result.claims.reverse();
    }
    if (variant === 2) {
      result.evidence.push(result.evidence.shift()!);
      result.claims.push(result.claims.shift()!);
    }
    return result;
  };
  const keyed = <T>(values: T[]) =>
    Object.fromEntries(spec.claims.map((c, n) => [rename(c.id), values[n]]));
  return {
    id: prefix,
    family: spec.id,
    description: spec.description,
    before: transform(evidence),
    after: transform(after),
    changedEvidenceIds: (spec.changed ?? ['E1']).map(rename),
    initialCitations: keyed(spec.citations.map((ids) => ids.map(rename))),
    oracle: {
      beforeStates: keyed(spec.statesBefore ?? spec.claims.map(() => S)),
      afterStates: keyed(spec.statesAfter),
      afterOriginCounts: keyed(spec.origins),
      affectedClaimIds: spec.affected.map(rename),
      requiredReviewIds: spec.review.map(rename),
    },
  };
}

export function evaluationCases(): EvaluationCase[] {
  const cases = specs.flatMap((spec) => [0, 1, 2].map((variant) => materialize(spec, variant)));
  const ids = Array.from({ length: 12 }, (_, n) => `D${n + 1}`);
  cases.push(
    materialize(
      {
        id: 'depth-12',
        description: 'The deepest accepted chain is traversed completely.',
        claims: [...ids.map((id, n) => claim(id, [[n ? ids[n - 1] : 'E1']])), claim('X', [['E3']])],
        change: withdraw,
        statesAfter: [...ids.map<SupportStatus>(() => U), S],
        origins: [...ids.map(() => 0), 1],
        affected: ids,
        review: ids,
        citations: [...ids.map(() => ['E1']), ['E3']],
      },
      0,
    ),
  );
  cases.push(
    materialize(
      {
        id: 'unrelated-source',
        description: 'Withdrawing an unused source requires no statement review.',
        claims: [claim('A', [['E1']]), claim('X', [['E2']])],
        change: (e) => {
          e[2].status = 'withdrawn';
        },
        changed: ['E3'],
        statesAfter: [S, S],
        origins: [1, 1],
        affected: [],
        review: [],
        citations: [['E1'], ['E2']],
      },
      0,
    ),
  );
  return cases;
}

export function invalidCases(): InvalidCase[] {
  const base = () => ({
    evidence: ['E1', 'E2'].map(source),
    claims: [claim('A', [['E1']]), claim('B', [['A']])],
  });
  const result: InvalidCase[] = [];
  const add = (id: string, expectedError: string, mutate: (g: GraphInput) => void) => {
    const graph = base();
    mutate(graph);
    result.push({ id, graph, expectedError });
  };
  add('cycle', 'Support cycle', (g) => {
    g.claims[0].supportGroups[0].memberIds = ['B'];
  });
  add('unknown-premise', 'Unknown premise', (g) => {
    g.claims[0].supportGroups[0].memberIds = ['missing'];
  });
  add('empty-group', 'Empty support group', (g) => {
    g.claims[0].supportGroups[0].memberIds = [];
  });
  add('duplicate-premise', 'Duplicate premise', (g) => {
    g.claims[0].supportGroups[0].memberIds = ['E1', 'E1'];
  });
  add('duplicate-artifact', 'Duplicate artifact', (g) => {
    g.evidence.push(structuredClone(g.evidence[0]));
  });
  add('depth-13', 'Dependency depth exceeds 12', (g) => {
    g.claims = Array.from({ length: 13 }, (_, n) => claim(`D${n}`, [[n ? `D${n - 1}` : 'E1']]));
  });
  return result;
}
