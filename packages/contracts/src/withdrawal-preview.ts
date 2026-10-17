import { z } from 'zod';

const id = z.string().min(1);
const status = z.enum(['supported', 'unsupported', 'contested']);
const change = z.enum(['changed', 'unchanged']);
const state = z.strictObject({
  status,
  validGroupIds: z.array(id),
  originGroupIds: z.array(id),
});
const groupState = z.strictObject({ valid: z.boolean(), reasons: z.array(z.string()) });

/** Advisory simulation only: never a correction command or publication authorization. */
export const withdrawalPreviewSchema = z.strictObject({
  kind: z.literal('evidence-withdrawal-preview'),
  readOnly: z.literal(true),
  snapshot: z.strictObject({
    incidentId: id,
    eventSeq: z.number().int().nonnegative(),
    evidenceEpoch: z.number().int().positive(),
    reportVersion: z.number().int().positive().nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  evidenceId: id,
  affectedClaimIds: z.array(id),
  // All findings are returned, including unaffected/independently supported ones.
  claims: z.array(
    z.strictObject({
      claimId: id,
      reachable: z.boolean(),
      change,
      before: state,
      after: state,
      groups: z.array(
        z.strictObject({
          groupId: id,
          polarity: z.enum(['support', 'opposition']),
          memberIds: z.array(id),
          change,
          before: groupState,
          after: groupState,
        }),
      ),
    }),
  ),
  // Paths run from the withdrawn evidence toward dependent claims.
  paths: z.array(z.array(id)),
  conclusions: z.array(
    z.strictObject({
      statementId: id,
      claimId: id,
      storedStatus: z.enum(['supported', 'unsupported', 'contested', 'needs_review']),
      beforeStatus: status,
      afterStatus: status,
      change,
      requiresReview: z.boolean(),
      affectedCitationIds: z.array(id),
    }),
  ),
  // These are reasoning associations/exposure, not predicted service outages.
  services: z.array(
    z.strictObject({
      serviceId: id,
      artifactIds: z.array(id),
      dependencyPaths: z.array(
        z.strictObject({ serviceId: id, hops: z.number().int().nonnegative(), path: z.array(id) }),
      ),
    }),
  ),
});
export type WithdrawalPreview = z.infer<typeof withdrawalPreviewSchema>;
