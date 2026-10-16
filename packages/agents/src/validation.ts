import { z } from 'zod';
import type {
  AgentFinding,
  Claim,
  Evaluation,
  Evidence,
  Report,
  Statement,
} from '@aftermath/contracts';

const id = z.string().min(1).max(100);
const text = z.string().trim().min(1).max(1000);
export const emptyArguments = z.strictObject({});
export const diagnosticArguments = z.strictObject({ recipeId: id });
export const deferDiagnosticArguments = z.strictObject({
  recipeIds: z.array(id).min(1).max(5),
  reason: z.string().trim().min(10).max(500),
});
export const findingsArguments = z.strictObject({
  findings: z
    .array(
      z.strictObject({
        claimId: id,
        summary: text,
        supportGroupIds: z.array(id).max(12),
        citationIds: z.array(id).max(24),
        uncertainty: text.nullable(),
      }),
    )
    .min(1)
    .max(20),
});
export const reportArguments = z.strictObject({
  statements: z
    .array(
      z.strictObject({
        claimId: id,
        text,
        citationIds: z.array(id).max(24),
        uncertainty: text.nullable(),
      }),
    )
    .max(20),
});

export function citationOptions(
  claim: Claim,
  claims: Claim[],
  evaluations: Evaluation[],
  evidence: Evidence[],
  depth = 0,
): string[][] {
  if (depth > 12) throw new Error('Support expansion depth exceeded');
  const evaluation = evaluations.find((e) => e.claimId === claim.id);
  if (evaluation?.status !== 'supported') return [];
  return claim.supportGroups
    .filter((g) => evaluation.validGroupIds.includes(g.id))
    .map((group) => {
      const roots = group.memberIds.flatMap((memberId) => {
        const source = evidence.find((e) => e.id === memberId);
        if (source) return source.status === 'active' ? [source.id] : [];
        const child = claims.find((c) => c.id === memberId);
        if (!child) throw new Error('Unknown support member');
        // Nested OR groups are conservatively expanded together; no invented shortcuts.
        return citationOptions(child, claims, evaluations, evidence, depth + 1).flat();
      });
      return [...new Set(roots)].sort();
    });
}
function assertCitations(ids: string[], options: string[][]) {
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate citations are not allowed');
  const allowed = new Set(options.flat());
  if (ids.some((item) => !allowed.has(item)))
    throw new Error('Citation is withdrawn, unknown, out of scope, or outside valid support');
  if (
    options.length &&
    !options.some((option) => option.length && option.every((item) => ids.includes(item)))
  )
    throw new Error('Citations must cover a complete valid support group');
  if (!options.length && ids.length)
    throw new Error('Unsupported findings cannot cite evidence as valid support');
}
function requireUncertainty(
  claim: Claim,
  status: Evaluation['status'],
  uncertainty: string | null,
) {
  if ((status !== 'supported' || claim.type !== 'observation') && !uncertainty)
    throw new Error(
      `${claim.id}: uncertainty must be a non-empty statement for a ${status} ${claim.type}`,
    );
}
export function validateFindings(
  input: unknown,
  claims: Claim[],
  evaluations: Evaluation[],
  evidence: Evidence[],
): AgentFinding[] {
  const { findings } = findingsArguments.parse(input);
  if (
    findings.length !== claims.length ||
    new Set(findings.map((f) => f.claimId)).size !== claims.length
  )
    throw new Error(
      `Propose exactly one finding for each supplied claim, including unsupported claims. Required claimIds: ${claims.map((c) => c.id).join(', ')}. Missing: ${
        claims
          .filter((c) => !findings.some((f) => f.claimId === c.id))
          .map((c) => c.id)
          .join(', ') || 'none'
      }. Do not duplicate claimIds.`,
    );
  const errors: string[] = [];
  for (const finding of findings) {
    const claim = claims.find((c) => c.id === finding.claimId);
    const evaluation = evaluations.find((e) => e.claimId === finding.claimId);
    if (!claim || !evaluation) throw new Error('Unknown claim');
    if (
      new Set(finding.supportGroupIds).size !== finding.supportGroupIds.length ||
      finding.supportGroupIds.some((id) => !evaluation.validGroupIds.includes(id)) ||
      (evaluation.status === 'supported'
        ? !finding.supportGroupIds.length
        : finding.supportGroupIds.length > 0)
    )
      errors.push(
        `${claim.id}: supportGroupIds must contain unique IDs from [${evaluation.validGroupIds.join(', ')}]${evaluation.status === 'supported' ? ' and at least one group' : '; this finding has no usable support, so submit []'}.`,
      );
    const selectedClaim = {
      ...claim,
      supportGroups: claim.supportGroups.filter((g) => finding.supportGroupIds.includes(g.id)),
    };
    try {
      assertCitations(
        finding.citationIds,
        citationOptions(selectedClaim, claims, evaluations, evidence),
      );
    } catch (error) {
      errors.push(`${claim.id}: ${error instanceof Error ? error.message : 'Invalid citations'}`);
    }
    try {
      requireUncertainty(claim, evaluation.status, finding.uncertainty);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${claim.id}: Invalid uncertainty`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return findings;
}
/** Application-owned notices cannot repeat an unsupported assertion or actionable directive. */
export function supportNotice(
  claim: Claim,
  statement: Statement,
  previous: Report,
  evaluation: Evaluation,
): Statement | undefined {
  if (statement.status === 'supported') return undefined;
  const reason =
    statement.status === 'contested'
      ? 'the accepted evidence is conflicting'
      : statement.status === 'needs_review'
        ? 'its support has not yet been validated'
        : 'required support is missing or invalid';
  const text =
    claim.type === 'recommendation'
      ? `Recommendation withheld because ${reason}.`
      : statement.status === 'contested'
        ? 'This finding remains unresolved because accepted evidence conflicts.'
        : statement.status === 'needs_review'
          ? 'This finding is awaiting validation against the current evidence.'
          : 'This finding is not supported by the current evidence.';
  const reasons = [...new Set(evaluation.invalidGroups.flatMap((g) => g.reasons))];
  const uncertainty =
    statement.status === 'contested'
      ? 'Accepted support and opposing evidence conflict; neither is a settled conclusion.'
      : reasons.length
        ? `Support issues: ${reasons.join('; ')}.`
        : 'Current, non-conflicting support has not been established.';
  const old = previous.statements.find((s) => s.claimId === statement.claimId);
  return {
    ...statement,
    text,
    uncertainty,
    citationIds: [],
    author: 'gateway',
    disposition:
      old?.author === 'gateway' &&
      old.text === text &&
      old.uncertainty === uncertainty &&
      old.status === statement.status
        ? 'preserved'
        : 'revised',
  };
}

export function reportTargets(
  report: Report,
  previous: Report,
  claims: Claim[],
  evaluations: Evaluation[],
  evidence: Evidence[],
  artifacts: Array<{ id: string; hash: string }> = [],
  useSupportNotices = false,
) {
  return report.statements
    .filter((statement) => {
      if (useSupportNotices && statement.status !== 'supported') return false;
      if (!previous.agent) return true;
      const old = previous.statements.find((s) => s.claimId === statement.claimId);
      if (!old || old.status !== statement.status) return true;
      const unchanged = [statement.claimId, ...(old.citationIds ?? [])].every(
        (id) =>
          artifacts.find((a) => a.id === id)?.hash ===
          previous.agent!.inputArtifacts.find((a) => a.id === id)?.hash,
      );
      if (!unchanged) return true;
      try {
        assertCitations(
          old?.citationIds ?? [],
          citationOptions(
            claims.find((c) => c.id === statement.claimId)!,
            claims,
            evaluations,
            evidence,
          ),
        );
      } catch {
        return true;
      }
      return false;
    })
    .map((s) => s.claimId);
}
export function validateReport(
  input: unknown,
  report: Report,
  previous: Report,
  claims: Claim[],
  evaluations: Evaluation[],
  evidence: Evidence[],
  artifacts: Array<{ id: string; hash: string }> = [],
  useSupportNotices = false,
): Statement[] {
  const { statements } = reportArguments.parse(input);
  const targets = reportTargets(
    report,
    previous,
    claims,
    evaluations,
    evidence,
    artifacts,
    useSupportNotices,
  );
  if (
    statements.length !== targets.length ||
    new Set(statements.map((s) => s.claimId)).size !== targets.length ||
    statements.some((s) => !targets.includes(s.claimId))
  )
    throw new Error(
      useSupportNotices
        ? 'Report must contain exactly the requested statements; preserved or application-withheld statements cannot be rewritten'
        : 'Report must contain exactly the requested statements; preserved statements cannot be rewritten',
    );
  for (const statement of statements) {
    const claim = claims.find((c) => c.id === statement.claimId)!;
    const evaluation = evaluations.find((e) => e.claimId === claim.id)!;
    assertCitations(statement.citationIds, citationOptions(claim, claims, evaluations, evidence));
    requireUncertainty(claim, evaluation.status, statement.uncertainty);
  }
  return report.statements.map((statement) => {
    if (useSupportNotices) {
      const withheld = supportNotice(
        claims.find((c) => c.id === statement.claimId)!,
        statement,
        previous,
        evaluations.find((e) => e.claimId === statement.claimId)!,
      );
      if (withheld) return withheld;
    }
    const proposed = statements.find((s) => s.claimId === statement.claimId);
    if (!proposed)
      return {
        ...previous.statements.find((s) => s.claimId === statement.claimId)!,
        disposition: 'preserved',
        validatedEpoch: report.evidenceEpoch,
      };
    const prefix =
      statement.status === 'unsupported'
        ? 'Insufficient current evidence. '
        : statement.status === 'contested'
          ? 'Conflicting evidence. '
          : '';
    return {
      ...statement,
      ...proposed,
      text: prefix + proposed.text,
      author: 'reporter',
      disposition: 'revised',
    };
  });
}
