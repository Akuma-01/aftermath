import { describe, expect, it } from 'vitest';
import {
  claimSchema,
  correctionSchema,
  evidenceSchema,
  incidentSchema,
  reportSchema,
  scopeSchema,
  supportGroupSchema,
} from '@aftermath/contracts';
import { createDomainFixture, FIXTURE_CREATED_AT } from '@aftermath/fixtures';

describe('runtime contracts', () => {
  it('parses the core incident without losing source provenance or raw content', () => {
    const fixture = createDomainFixture();
    expect(incidentSchema.parse(fixture)).toEqual(fixture);
    expect(evidenceSchema.parse(fixture.evidence[0])).toMatchObject({
      id: 'E1-v1',
      sourceId: 'E1',
      version: 1,
      originGroupId: 'origin-E1',
      source: 'Imported log',
      service: 'database',
      observedAt: '2026-09-25T09:43:00.000Z',
      scope: fixture.evidence[0].scope,
      content: fixture.evidence[0].content,
    });
  });

  it.each(['active', 'withdrawn', 'superseded', 'quarantined'])('accepts %s evidence', (status) => {
    expect(evidenceSchema.safeParse({ ...createDomainFixture().evidence[0], status }).success).toBe(
      true,
    );
  });

  it.each([
    { version: 0 },
    { version: 1.5 },
    { version: Number.MAX_SAFE_INTEGER + 1 },
    { status: 'deleted' },
    { sourceId: '' },
    { originGroupId: '  ' },
    { observedAt: 'yesterday' },
    { scope: { environment: 'production', timeWindow: '' } },
    { unexpected: true },
  ])('rejects malformed evidence: %j', (override) => {
    expect(
      evidenceSchema.safeParse({ ...createDomainFixture().evidence[0], ...override }).success,
    ).toBe(false);
  });

  it('compares opaque scope labels without rewriting provenance text', () => {
    expect(
      scopeSchema.parse({ environment: 'production', timeWindow: 'incident-window-A' }),
    ).toEqual({
      environment: 'production',
      timeWindow: 'incident-window-A',
    });
    const evidence = createDomainFixture().evidence[0];
    evidence.content = '  original bytes\n';
    expect(evidenceSchema.parse(evidence).content).toBe(evidence.content);
  });

  it('rejects empty and duplicate premises but allows a claim with no positive support', () => {
    const group = { id: 'g', ruleId: 'rule', memberIds: [] };
    expect(supportGroupSchema.safeParse(group).success).toBe(false);
    expect(supportGroupSchema.safeParse({ ...group, memberIds: ['E1-v1', 'E1-v1'] }).success).toBe(
      false,
    );
    expect(
      claimSchema.safeParse({ ...createDomainFixture().claims[0], supportGroups: [] }).success,
    ).toBe(true);
  });

  it('records an exact corrected version and validates correction metadata', () => {
    const correction = {
      id: 'correction-1',
      targetId: 'E1-v1',
      reason: 'Source belongs to staging',
      createdAt: FIXTURE_CREATED_AT,
      evidenceEpoch: 2,
    };
    expect(correctionSchema.parse(correction)).toEqual(correction);
    expect(correctionSchema.safeParse({ ...correction, reason: ' ' }).success).toBe(false);
    expect(correctionSchema.safeParse({ ...correction, evidenceEpoch: 0 }).success).toBe(false);
    expect(correctionSchema.safeParse({ ...correction, targetId: '' }).success).toBe(false);
  });

  it('rejects invalid aggregate and report revisions', () => {
    const incident = createDomainFixture();
    expect(incidentSchema.safeParse({ ...incident, reportStatus: 'supported' }).success).toBe(
      false,
    );
    expect(incidentSchema.safeParse({ ...incident, eventSeq: -1 }).success).toBe(false);
    expect(reportSchema.safeParse({ ...incident.reports[0], version: 0 }).success).toBe(false);
    expect(reportSchema.safeParse({ ...incident.reports[0], createdAt: 'invalid' }).success).toBe(
      false,
    );
  });
});
