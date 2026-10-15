import { describe, expect, it } from 'vitest';
import type { Claim, Evidence, Incident } from '@aftermath/contracts';
import {
  evaluateSupport,
  makeReport,
  MAX_DEPENDENCY_DEPTH,
  validateGraph,
} from '@aftermath/domain';
import { createDomainFixture, FIXTURE_CREATED_AT, fixtureScope } from '@aftermath/fixtures';

function results(incident: Incident) {
  return evaluateSupport(incident.evidence, incident.claims);
}
function status(incident: Incident, id: string) {
  return results(incident).find((evaluation) => evaluation.claimId === id)!;
}
function chain(length: number): Claim[] {
  return Array.from({ length }, (_, index) => ({
    id: `chain-${index}`,
    title: 'Dependent finding',
    text: 'A dependent interpretation.',
    scope: { ...fixtureScope },
    type: 'inference',
    supportGroups: [
      {
        id: `group-${index}`,
        ruleId: 'chain',
        memberIds: [index === 0 ? 'E1-v1' : `chain-${index - 1}`],
      },
    ],
    oppositionGroups: [],
  }));
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

describe('support and provenance', () => {
  it('withdraws an exact source version and invalidates dependents without affecting unrelated findings', () => {
    const incident = createDomainFixture();
    incident.evidence[0].status = 'withdrawn';
    expect(results(incident).map((evaluation) => [evaluation.claimId, evaluation.status])).toEqual([
      ['C1-v1', 'supported'],
      ['C2-v1', 'unsupported'],
      ['C3-v1', 'unsupported'],
      ['C4-v1', 'supported'],
      ['C5-v1', 'supported'],
    ]);
    expect(status(incident, 'C2-v1').invalidGroups).toEqual([
      { id: 'C2-G1', reasons: ['E1-v1: withdrawn'] },
    ]);
    expect(status(incident, 'C3-v1').invalidGroups[0].reasons).toEqual(['C2-v1: unsupported']);
  });

  it('preserves a surviving OR alternative and its downstream finding', () => {
    const incident = createDomainFixture();
    incident.evidence[2].status = 'withdrawn';
    expect(status(incident, 'C4-v1')).toMatchObject({
      status: 'supported',
      validGroupIds: ['C4-G2'],
      originGroupIds: ['origin-E4'],
      invalidGroups: [{ id: 'C4-G1', reasons: ['E3-v1: withdrawn'] }],
    });
    expect(status(incident, 'C5-v1').status).toBe('supported');
    incident.evidence[3].status = 'withdrawn';
    expect(status(incident, 'C4-v1').status).toBe('unsupported');
    expect(status(incident, 'C5-v1').status).toBe('unsupported');
  });

  it('requires every AND premise even when the other premise has surviving alternatives', () => {
    const incident = createDomainFixture();
    incident.evidence[2].status = 'withdrawn';
    incident.evidence[5].status = 'withdrawn';
    expect(status(incident, 'C4-v1').status).toBe('supported');
    expect(status(incident, 'C5-v1')).toMatchObject({
      status: 'unsupported',
      originGroupIds: [],
      invalidGroups: [{ id: 'C5-G1', reasons: ['E6-v1: withdrawn'] }],
    });
  });

  it.each(['withdrawn', 'superseded', 'quarantined'] as const)(
    'excludes %s evidence from support',
    (unavailable) => {
      const incident = createDomainFixture();
      incident.evidence[0].status = unavailable;
      expect(status(incident, 'C2-v1')).toMatchObject({
        status: 'unsupported',
        originGroupIds: [],
        invalidGroups: [{ id: 'C2-G1', reasons: [`E1-v1: ${unavailable}`] }],
      });
    },
  );

  it.each([
    ['environment', 'staging'],
    ['timeWindow', 'another-window'],
  ] as const)('requires matching evidence %s', (field, value) => {
    const incident = createDomainFixture();
    incident.evidence[0].scope[field] = value;
    expect(status(incident, 'C2-v1')).toMatchObject({
      status: 'unsupported',
      originGroupIds: [],
      invalidGroups: [
        {
          id: 'C2-G1',
          reasons: [
            `E1-v1: scope does not match ${fixtureScope.environment} / ${fixtureScope.timeWindow}`,
          ],
        },
      ],
    });
  });

  it('checks the scope of supported claim premises as well as evidence', () => {
    const incident = createDomainFixture();
    incident.claims[0].scope.environment = 'staging';
    incident.evidence[1].scope.environment = 'staging';
    expect(status(incident, 'C1-v1').status).toBe('supported');
    expect(status(incident, 'C3-v1').invalidGroups[0].reasons).toEqual([
      `C1-v1: scope does not match production / ${fixtureScope.timeWindow}`,
    ]);
  });

  it('deduplicates copied origins across alternatives and nested support', () => {
    const incident = createDomainFixture();
    incident.evidence[3].originGroupId = 'origin-E3';
    expect(status(incident, 'C4-v1')).toMatchObject({
      validGroupIds: ['C4-G1', 'C4-G2'],
      originGroupIds: ['origin-E3'],
    });
    expect(status(incident, 'C5-v1').originGroupIds).toEqual(['origin-E3', 'origin-E6']);
    incident.claims[4].supportGroups[0].memberIds.push('E3-v1');
    expect(status(incident, 'C5-v1').originGroupIds).toEqual(['origin-E3', 'origin-E6']);
  });

  it('restores support using an active replacement without reviving the withdrawn version', () => {
    const incident = createDomainFixture();
    incident.evidence[0].status = 'withdrawn';
    const replacement: Evidence = {
      ...structuredClone(incident.evidence[0]),
      id: 'E1-v2',
      version: 2,
      status: 'active',
    };
    incident.evidence.push(replacement);
    incident.claims[1].supportGroups.push({
      id: 'replacement-group',
      ruleId: 'replacement',
      memberIds: ['E1-v2'],
    });
    expect(status(incident, 'C2-v1')).toMatchObject({
      status: 'supported',
      validGroupIds: ['replacement-group'],
      originGroupIds: ['origin-E1'],
    });
    expect(status(incident, 'C3-v1').status).toBe('supported');
    expect(incident.evidence[0].status).toBe('withdrawn');
    expect(replacement.sourceId).toBe(incident.evidence[0].sourceId);
  });

  it('handles a diamond and input order without duplicating provenance', () => {
    const incident = createDomainFixture();
    const base = incident.claims[0];
    const claims: Claim[] = [
      {
        ...base,
        id: 'top',
        supportGroups: [{ id: 'top-group', ruleId: 'and', memberIds: ['left', 'right'] }],
      },
      {
        ...base,
        id: 'right',
        supportGroups: [{ id: 'right-group', ruleId: 'copy', memberIds: ['root'] }],
      },
      {
        ...base,
        id: 'left',
        supportGroups: [{ id: 'left-group', ruleId: 'copy', memberIds: ['root'] }],
      },
      {
        ...base,
        id: 'root',
        supportGroups: [{ id: 'root-group', ruleId: 'source', memberIds: ['E1-v1'] }],
      },
    ];
    const evaluated = evaluateSupport(incident.evidence, claims);
    expect(evaluated.map((evaluation) => evaluation.claimId)).toEqual([
      'top',
      'right',
      'left',
      'root',
    ]);
    expect(evaluated.every((evaluation) => evaluation.status === 'supported')).toBe(true);
    expect(evaluated[0].originGroupIds).toEqual(['origin-E1']);
    const reversed = evaluateSupport([...incident.evidence].reverse(), [...claims].reverse());
    expect(reversed).toEqual([...evaluated].reverse());
    incident.evidence[0].status = 'withdrawn';
    expect(
      evaluateSupport(incident.evidence, claims).every(
        (evaluation) => evaluation.status === 'unsupported',
      ),
    ).toBe(true);
  });

  it('does not mutate frozen evidence or claims during validation or evaluation', () => {
    const incident = freeze(createDomainFixture());
    const baseline = structuredClone(incident);
    expect(results(incident)).toEqual(incident.evaluations);
    expect(incident).toEqual(baseline);
  });
});

describe('opposition and contested findings', () => {
  function opposed() {
    const incident = createDomainFixture();
    incident.claims[1].oppositionGroups = [
      {
        id: 'normal-pool',
        ruleId: 'test-opposition',
        memberIds: ['E2-v1'],
      },
    ];
    return incident;
  }

  it('makes positive support contested and rejects it as a downstream premise', () => {
    const incident = opposed();
    expect(status(incident, 'C2-v1')).toMatchObject({
      status: 'contested',
      validGroupIds: ['C2-G1'],
      originGroupIds: ['origin-E1'],
    });
    expect(status(incident, 'C3-v1')).toMatchObject({
      status: 'unsupported',
      originGroupIds: [],
      invalidGroups: [{ id: 'C3-G1', reasons: ['C2-v1: contested'] }],
    });
  });

  it('keeps a finding unsupported when opposition exists without positive support', () => {
    const incident = opposed();
    incident.evidence[0].status = 'withdrawn';
    expect(status(incident, 'C2-v1').status).toBe('unsupported');
    incident.claims[1].supportGroups = [];
    expect(status(incident, 'C2-v1').status).toBe('unsupported');
  });

  it.each(['withdrawn', 'superseded', 'quarantined'] as const)(
    'ignores %s opposing evidence',
    (unavailable) => {
      const incident = opposed();
      incident.evidence[1].status = unavailable;
      expect(status(incident, 'C2-v1').status).toBe('supported');
    },
  );

  it.each(['environment', 'timeWindow'] as const)('ignores opposition outside the %s', (field) => {
    const incident = opposed();
    incident.evidence[1].scope[field] = 'different';
    expect(status(incident, 'C2-v1').status).toBe('supported');
  });

  it('uses AND within opposition groups and OR between opposition alternatives', () => {
    const incident = opposed();
    incident.claims[1].oppositionGroups[0].memberIds = ['E3-v1', 'E4-v1'];
    incident.evidence[2].status = 'withdrawn';
    expect(status(incident, 'C2-v1').status).toBe('supported');
    incident.claims[1].oppositionGroups.push({
      id: 'other-opposition',
      ruleId: 'independent',
      memberIds: ['E6-v1'],
    });
    expect(status(incident, 'C2-v1').status).toBe('contested');
  });

  it('requires a claim used as opposition to be supported, not contested or unsupported', () => {
    const incident = opposed();
    incident.claims[1].oppositionGroups[0].memberIds = ['C1-v1'];
    expect(status(incident, 'C2-v1').status).toBe('contested');
    incident.claims[0].oppositionGroups = [
      {
        id: 'oppose-C1',
        ruleId: 'conflict',
        memberIds: ['E3-v1'],
      },
    ];
    expect(status(incident, 'C1-v1').status).toBe('contested');
    expect(status(incident, 'C2-v1').status).toBe('supported');
    incident.evidence[1].status = 'withdrawn';
    expect(status(incident, 'C1-v1').status).toBe('unsupported');
    expect(status(incident, 'C2-v1').status).toBe('supported');
  });

  it('returns to supported after the only opposing version is withdrawn', () => {
    const incident = opposed();
    expect(status(incident, 'C2-v1').status).toBe('contested');
    incident.evidence[1].status = 'withdrawn';
    expect(status(incident, 'C2-v1').status).toBe('supported');
  });
});

describe('accepted graph constraints', () => {
  const invalid: Array<[string, (incident: Incident) => void, string]> = [
    [
      'duplicate evidence IDs',
      (i) => {
        i.evidence.push(structuredClone(i.evidence[0]));
      },
      'Duplicate artifact',
    ],
    [
      'claim/evidence ID collision',
      (i) => {
        i.claims[0].id = 'E1-v1';
      },
      'Duplicate artifact',
    ],
    [
      'duplicate claim IDs',
      (i) => {
        i.claims[1].id = i.claims[0].id;
      },
      'Duplicate artifact',
    ],
    [
      'duplicate group IDs across claims',
      (i) => {
        i.claims[1].supportGroups[0].id = i.claims[0].supportGroups[0].id;
      },
      'Duplicate support group',
    ],
    [
      'duplicate group IDs across polarities',
      (i) => {
        i.claims[0].oppositionGroups = [structuredClone(i.claims[0].supportGroups[0])];
      },
      'Duplicate support group',
    ],
    [
      'unknown support premise',
      (i) => {
        i.claims[0].supportGroups[0].memberIds = ['missing'];
      },
      'Unknown premise',
    ],
    [
      'unknown opposing premise',
      (i) => {
        i.claims[0].oppositionGroups = [
          { id: 'opposition', ruleId: 'rule', memberIds: ['missing'] },
        ];
      },
      'Unknown premise',
    ],
    [
      'empty positive group',
      (i) => {
        i.claims[0].supportGroups[0].memberIds = [];
      },
      'Empty support group',
    ],
    [
      'empty opposing group',
      (i) => {
        i.claims[0].oppositionGroups = [{ id: 'opposition', ruleId: 'rule', memberIds: [] }];
      },
      'Empty support group',
    ],
    [
      'duplicate premises',
      (i) => {
        i.claims[0].supportGroups[0].memberIds = ['E2-v1', 'E2-v1'];
      },
      'Duplicate premise',
    ],
    [
      'self-cycle',
      (i) => {
        i.claims[0].supportGroups[0].memberIds = ['C1-v1'];
      },
      'cycle',
    ],
    [
      'support cycle',
      (i) => {
        i.claims[0].supportGroups[0].memberIds = ['C3-v1'];
      },
      'cycle',
    ],
    [
      'opposition cycle',
      (i) => {
        i.claims[0].oppositionGroups = [{ id: 'opposition', ruleId: 'rule', memberIds: ['C3-v1'] }];
      },
      'cycle',
    ],
  ];
  it.each(invalid)('rejects %s before evaluation', (_name, mutate, message) => {
    const incident = createDomainFixture();
    mutate(incident);
    expect(() => validateGraph(incident.evidence, incident.claims)).toThrow(message);
    expect(() => results(incident)).toThrow(message);
  });

  it('validates runtime data instead of trusting a TypeScript annotation', () => {
    const incident = createDomainFixture();
    incident.evidence[0].version = 0;
    expect(() => results(incident)).toThrow();
  });

  it('accepts the twelve-edge boundary and rejects thirteen in either input order', () => {
    const { evidence } = createDomainFixture();
    const accepted = chain(MAX_DEPENDENCY_DEPTH);
    expect(
      evaluateSupport(evidence, accepted).every((evaluation) => evaluation.status === 'supported'),
    ).toBe(true);
    expect(() => validateGraph(evidence, [...accepted].reverse())).not.toThrow();
    for (const claims of [chain(13), chain(13).reverse()]) {
      expect(() => validateGraph(evidence, claims)).toThrow('Dependency depth exceeds 12');
    }
    expect(() => validateGraph(evidence, chain(1000).reverse())).toThrow(
      'Dependency depth exceeds 12',
    );
  });

  it('counts opposition dependencies in the same depth bound', () => {
    const { evidence } = createDomainFixture();
    const claims = chain(13);
    claims[12].oppositionGroups = claims[12].supportGroups;
    claims[12].supportGroups = [];
    expect(() => validateGraph(evidence, claims)).toThrow('Dependency depth exceeds 12');
  });

  it('supports empty graphs and treats a claim with no groups as unsupported', () => {
    expect(evaluateSupport([], [])).toEqual([]);
    const incident = createDomainFixture();
    const unsupported = { ...incident.claims[0], supportGroups: [], oppositionGroups: [] };
    expect(evaluateSupport([], [unsupported])).toEqual([
      {
        claimId: 'C1-v1',
        status: 'unsupported',
        validGroupIds: [],
        invalidGroups: [],
        originGroupIds: [],
      },
    ]);
  });
});

describe('immutable report revisions', () => {
  it('revises changed findings, preserves unrelated text, and revalidates every statement', () => {
    const incident = createDomainFixture();
    const previous = freeze(incident.reports[0]);
    const baseline = structuredClone(previous);
    incident.evidence[0].status = 'withdrawn';
    const report = makeReport(incident.claims, results(incident), 2, previous, FIXTURE_CREATED_AT);
    expect(report.version).toBe(2);
    expect(report.evidenceEpoch).toBe(2);
    expect(
      report.statements.filter((s) => s.disposition === 'revised').map((s) => s.claimId),
    ).toEqual(['C2-v1', 'C3-v1']);
    expect(report.statements.filter((s) => s.disposition === 'preserved')).toHaveLength(3);
    expect(report.statements.every((s) => s.validatedEpoch === 2)).toBe(true);
    expect(report.statements[1].text).toContain('unconfirmed');
    expect(previous).toEqual(baseline);
  });

  it('preserves report wording when an uncited alternative support group survives', () => {
    const incident = createDomainFixture();
    incident.evidence[2].status = 'withdrawn';
    const report = makeReport(
      incident.claims,
      results(incident),
      2,
      incident.reports[0],
      FIXTURE_CREATED_AT,
    );
    expect(report.statements.every((s) => s.disposition === 'preserved')).toBe(true);
  });

  it('uses explicit conflict and pending-review wording without presenting the original assertion as settled', () => {
    const incident = createDomainFixture();
    incident.claims[1].oppositionGroups = [
      { id: 'opposition', ruleId: 'conflict', memberIds: ['E2-v1'] },
    ];
    const evaluations = results(incident);
    evaluations[0].status = 'needs_review';
    const report = makeReport(
      incident.claims,
      evaluations,
      2,
      incident.reports[0],
      FIXTURE_CREATED_AT,
    );
    expect(report.statements[0].text).toContain('Awaiting validation');
    expect(report.statements[0].text).not.toBe(incident.claims[0].text);
    expect(report.statements[1].text).toContain('Conflicting evidence');
    expect(report.statements[1].status).toBe('contested');
  });

  it('uses the claim environment in unsupported report wording', () => {
    const incident = createDomainFixture();
    incident.claims[0].scope.environment = 'staging';
    const report = makeReport(incident.claims, results(incident), 1, undefined, FIXTURE_CREATED_AT);
    expect(report.statements[0].text).toContain('Insufficient current staging evidence');
  });

  it('marks a new finding initial and a changed supported statement revised', () => {
    const incident = createDomainFixture();
    const added: Claim = {
      ...incident.claims[0],
      id: 'new-claim',
      supportGroups: [{ id: 'new-group', ruleId: 'new-rule', memberIds: ['E2-v1'] }],
    };
    incident.claims.push(added);
    incident.claims[0].text = 'Updated wording for the same supported observation.';
    const report = makeReport(
      incident.claims,
      results(incident),
      2,
      incident.reports[0],
      FIXTURE_CREATED_AT,
    );
    expect(report.statements[0].disposition).toBe('revised');
    expect(report.statements.at(-1)?.disposition).toBe('initial');
  });

  it('rejects missing, duplicate and unknown evaluations rather than publishing partial reports', () => {
    const { claims, evaluations } = createDomainFixture();
    expect(() => makeReport(claims, evaluations.slice(1), 1)).toThrow('Missing evaluation');
    expect(() => makeReport(claims, [...evaluations, evaluations[0]], 1)).toThrow(
      'Duplicate evaluation',
    );
    expect(() =>
      makeReport(claims, [...evaluations, { ...evaluations[0], claimId: 'unknown' }], 1),
    ).toThrow('Unknown evaluation claim');
    expect(() => makeReport([...claims, claims[0]], evaluations, 1)).toThrow(
      'Duplicate report claim',
    );
  });

  it('validates report epoch and timestamp and can reproduce an empty report', () => {
    expect(() => makeReport([], [], 0)).toThrow();
    expect(() => makeReport([], [], 1, undefined, 'not-a-date')).toThrow();
    expect(makeReport([], [], 1, undefined, FIXTURE_CREATED_AT)).toEqual({
      version: 1,
      createdAt: FIXTURE_CREATED_AT,
      evidenceEpoch: 1,
      statements: [],
    });
  });
});
