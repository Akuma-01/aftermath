import { expect, it } from 'vitest';
import { incidentSchema } from '@aftermath/contracts';
import { evaluateSupport } from '@aftermath/domain';
import { createDomainFixture, FIXTURE_CREATED_AT, fixtureScope } from '@aftermath/fixtures';

it('produces reproducible core test data with no clock or random identity dependence', () => {
  const first = createDomainFixture();
  expect(createDomainFixture()).toEqual(first);
  expect(incidentSchema.parse(first)).toEqual(first);
  expect(first.evidence).toHaveLength(6);
  expect(first.claims).toHaveLength(5);
  expect(first.evaluations.every((evaluation) => evaluation.status === 'supported')).toBe(true);
  expect(first.reports[0].createdAt).toBe(FIXTURE_CREATED_AT);
});

it('does not share mutable evidence, scopes, groups, evaluations or report statements', () => {
  const first = createDomainFixture();
  const baseline = structuredClone(first);
  first.evidence[0].status = 'withdrawn';
  first.evidence[0].scope.environment = 'staging';
  first.claims[0].scope.timeWindow = 'other';
  first.claims[0].supportGroups[0].memberIds.push('E1-v1');
  first.evaluations[0].originGroupIds.length = 0;
  first.reports[0].statements[0].text = 'Changed in one test';
  expect(createDomainFixture()).toEqual(baseline);
  expect(fixtureScope.environment).toBe('production');
  expect(first.evidence[1].scope).toEqual(fixtureScope);
});

it('contains metadata and unrelated context without treating them as proof of causality', () => {
  const incident = createDomainFixture();
  expect(incident.claims[2].text).toContain('does not establish causality');
  const before = evaluateSupport(incident.evidence, incident.claims);
  incident.evidence.find((evidence) => evidence.id === 'E5-v1')!.status = 'withdrawn';
  expect(evaluateSupport(incident.evidence, incident.claims)).toEqual(before);
  expect(incident.evidence.some((evidence) => evidence.kind === 'diagnostic')).toBe(false);
});
