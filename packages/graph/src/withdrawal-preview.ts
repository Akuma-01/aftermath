import { createHash } from 'node:crypto';
import type { Incident, Evaluation, WithdrawalPreview } from '@aftermath/contracts';
import { incidentSchema } from '@aftermath/contracts';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Recompute against a fresh authoritative snapshot before accepting a later command. */
export function withdrawalSnapshotFingerprint(incident: Incident): string {
  return createHash('sha256')
    .update(canonical(incidentSchema.parse(incident)))
    .digest('hex');
}
export type PreviewGroup = {
  claimId: string;
  id: string;
  polarity: 'support' | 'opposition';
  memberIds: string[];
  valid: boolean;
  reasons: string[];
};
export function compareWithdrawal(
  incident: Incident,
  evidenceId: string,
  before: Evaluation[],
  after: Evaluation[],
  beforeGroups: PreviewGroup[],
  afterGroups: PreviewGroup[],
  affected: Set<string>,
): Pick<WithdrawalPreview, 'claims' | 'conclusions'> {
  const state = (evaluation: Evaluation) => {
    if (evaluation.status === 'needs_review') throw new Error('Incomplete preview evaluation');
    return {
      status: evaluation.status,
      validGroupIds: [...evaluation.validGroupIds].sort(),
      originGroupIds: [...evaluation.originGroupIds].sort(),
    };
  };
  const groupState = (group: PreviewGroup) => ({
    valid: group.valid,
    reasons: [...group.reasons].sort(),
  });
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const claims = before
    .map((old): WithdrawalPreview['claims'][number] => {
      const next = after.find((item) => item.claimId === old.claimId);
      if (!next) throw new Error('Missing preview claim');
      const groups = beforeGroups
        .filter((g) => g.claimId === old.claimId)
        .map((g): WithdrawalPreview['claims'][number]['groups'][number] => {
          const next = afterGroups.find((item) => item.claimId === g.claimId && item.id === g.id);
          if (!next) throw new Error('Missing preview support group');
          return {
            groupId: g.id,
            polarity: g.polarity,
            memberIds: g.memberIds,
            before: groupState(g),
            after: groupState(next),
            change: same(groupState(g), groupState(next)) ? 'unchanged' : 'changed',
          };
        })
        .sort((a, b) => a.groupId.localeCompare(b.groupId));
      return {
        claimId: old.claimId,
        reachable: affected.has(old.claimId),
        before: state(old),
        after: state(next),
        groups,
        change:
          same(state(old), state(next)) && groups.every((g) => g.change === 'unchanged')
            ? 'unchanged'
            : 'changed',
      };
    })
    .sort((a, b) => a.claimId.localeCompare(b.claimId));
  // Evidence withdrawal is supplied via the simulated evidence statuses. No report is rewritten.
  const conclusions = (incident.reports.at(-1)?.statements ?? [])
    .map((statement): WithdrawalPreview['conclusions'][number] => {
      const claim = claims.find((c) => c.claimId === statement.claimId);
      if (!claim) throw new Error('Report references an unknown claim');
      const affectedCitationIds = [
        ...new Set(
          (statement.citationIds ?? []).filter(
            (id) =>
              id === evidenceId ||
              claims.some(
                (c) =>
                  c.claimId === id &&
                  c.before.status === 'supported' &&
                  c.after.status !== 'supported',
              ),
          ),
        ),
      ].sort();
      const changed = claim.before.status !== claim.after.status || affectedCitationIds.length > 0;
      return {
        statementId: statement.id,
        claimId: statement.claimId,
        storedStatus: statement.status,
        beforeStatus: claim.before.status,
        afterStatus: claim.after.status,
        change: changed ? 'changed' : 'unchanged',
        requiresReview:
          changed ||
          statement.status !== claim.after.status ||
          (statement.citationIds ?? []).some(
            (id) =>
              incident.evidence.some((e) => e.id === id && e.status !== 'active') ||
              claims.some((c) => c.claimId === id && c.after.status !== 'supported'),
          ),
        affectedCitationIds,
      };
    })
    .sort((a, b) => a.statementId.localeCompare(b.statementId));
  return { claims, conclusions };
}
