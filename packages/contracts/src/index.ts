import { z } from 'zod';

const nonEmpty = z.string().refine((value) => value.trim().length > 0, 'Must not be blank');
const revision = z.number().int().positive();
const timestamp = z.iso.datetime({ offset: true });

export const supportStatusSchema = z.enum([
  'supported',
  'unsupported',
  'contested',
  'needs_review',
]);
export const evidenceStatusSchema = z.enum(['active', 'withdrawn', 'superseded', 'quarantined']);

/** A time window is an opaque scope label, compared exactly rather than inferred from dates. */
export const scopeSchema = z.strictObject({
  environment: nonEmpty,
  timeWindow: nonEmpty,
});

export const evidenceSchema = z.strictObject({
  id: nonEmpty,
  sourceId: nonEmpty,
  version: revision,
  title: nonEmpty,
  summary: z.string(),
  content: z.string(),
  source: nonEmpty,
  service: nonEmpty,
  observedAt: timestamp,
  scope: scopeSchema,
  status: evidenceStatusSchema,
  // Copies and versions can share an origin; this is not statistical independence.
  originGroupId: nonEmpty,
  kind: z.enum(['log', 'metric', 'trace', 'event', 'manifest', 'diagnostic']),
});

export const supportGroupSchema = z.strictObject({
  id: nonEmpty,
  memberIds: z
    .array(nonEmpty)
    .min(1, 'Empty support group')
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate premise'),
  ruleId: nonEmpty,
});

export const claimSchema = z.strictObject({
  id: nonEmpty,
  title: nonEmpty,
  text: nonEmpty,
  scope: scopeSchema,
  type: z.enum(['observation', 'hypothesis', 'inference', 'recommendation']),
  serviceIds: z.array(nonEmpty).optional(),
  // No positive groups is allowed and evaluates as unsupported.
  supportGroups: z.array(supportGroupSchema),
  oppositionGroups: z.array(supportGroupSchema),
});

export const evaluationSchema = z.strictObject({
  claimId: nonEmpty,
  status: supportStatusSchema,
  validGroupIds: z.array(nonEmpty),
  invalidGroups: z.array(z.strictObject({ id: nonEmpty, reasons: z.array(nonEmpty) })),
  originGroupIds: z.array(nonEmpty),
});

export const correctionSchema = z.strictObject({
  id: nonEmpty,
  targetId: nonEmpty,
  reason: nonEmpty,
  createdAt: timestamp,
  evidenceEpoch: revision,
});

export const statementSchema = z.strictObject({
  id: nonEmpty,
  claimId: nonEmpty,
  title: nonEmpty,
  text: nonEmpty,
  status: supportStatusSchema,
  disposition: z.enum(['initial', 'preserved', 'revised']),
  validatedEpoch: revision,
});

export const reportSchema = z.strictObject({
  version: revision,
  createdAt: timestamp,
  evidenceEpoch: revision,
  statements: z.array(statementSchema),
});

export const serviceTopologySchema = z.strictObject({
  services: z
    .array(z.strictObject({ id: nonEmpty, name: nonEmpty, tier: z.number().int().nonnegative() }))
    .max(128),
  dependencies: z.array(z.strictObject({ caller: nonEmpty, dependency: nonEmpty })).max(512),
});
export const diagnosticRecipeSchema = z.strictObject({
  id: nonEmpty,
  title: nonEmpty,
  description: nonEmpty,
  informs: z
    .array(nonEmpty)
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate diagnostic claim'),
  estimatedCost: z.number().nonnegative(),
  serviceId: nonEmpty,
  prerequisiteIds: z
    .array(nonEmpty)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate prerequisite'),
});
export type ServiceTopology = z.infer<typeof serviceTopologySchema>;
export type DiagnosticRecipe = z.infer<typeof diagnosticRecipeSchema>;
export interface ServiceImpact {
  topology: ServiceTopology;
  serviceId: string;
  generation: string;
  projectedSeq: number;
  paths: Array<{ serviceId: string; hops: number; path: string[] }>;
  centrality: Array<{ serviceId: string; score: number }>;
}
export interface Diagnostic {
  id: string;
  title: string;
  description: string;
  informs: string[];
  estimatedCost: number;
  available: boolean;
  completed: boolean;
  score: number;
  reason: string;
  graphGeneration: string;
  paths: Array<{ claimId: string; serviceIds: string[] }>;
}

export const impactSchema = z.strictObject({
  targetId: nonEmpty,
  affectedClaimIds: z.array(nonEmpty),
  preservedClaimIds: z.array(nonEmpty),
  unresolvedClaimIds: z.array(nonEmpty),
  paths: z.array(z.array(nonEmpty)),
  graphGeneration: nonEmpty,
});
export type Impact = z.infer<typeof impactSchema>;

export const domainEventSchema = z.strictObject({
  id: nonEmpty,
  seq: revision,
  type: nonEmpty,
  message: nonEmpty,
  occurredAt: timestamp,
});
export const contextManifestSchema = z.strictObject({
  evidenceEpoch: revision,
  reportVersion: revision,
  graphGeneration: nonEmpty,
  projectedSeq: revision,
  readArtifacts: z.array(
    z.strictObject({ id: nonEmpty, hash: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
});
export type DomainEvent = z.infer<typeof domainEventSchema>;
export type ContextManifest = z.infer<typeof contextManifestSchema>;

/** Incident data through service analysis. Worker, session and agent contracts arrive later.
 * Schemas validate data shape; validateGraph enforces cross-artifact support invariants.
 */
export const sessionSchema = z.strictObject({
  id: nonEmpty,
  createdAt: timestamp,
  correctionIds: z.array(nonEmpty),
  rejectedSourceIds: z.array(nonEmpty),
  graphGeneration: nonEmpty,
  message: nonEmpty,
});
export type Session = z.infer<typeof sessionSchema>;

export const incidentSchema = z.strictObject({
  sessions: z.array(sessionSchema).optional(),
  events: z.array(domainEventSchema).optional(),
  lastImpact: impactSchema.nullable().optional(),
  repairError: z.string().nullable().optional(),
  reportManifest: contextManifestSchema.optional(),
  scenario: z.enum(['checkout', 'commerce']).optional(),
  topology: serviceTopologySchema.optional(),
  diagnosticRecipes: z.array(diagnosticRecipeSchema).optional(),
  completedDiagnosticIds: z.array(nonEmpty).optional(),
  id: nonEmpty,
  title: nonEmpty,
  service: nonEmpty,
  severity: nonEmpty,
  eventSeq: revision,
  evidenceEpoch: revision,
  reportStatus: z.enum(['current', 'needs_review']),
  evidence: z.array(evidenceSchema),
  claims: z.array(claimSchema),
  evaluations: z.array(evaluationSchema),
  corrections: z.array(correctionSchema),
  reports: z.array(reportSchema),
});

export type SupportStatus = z.infer<typeof supportStatusSchema>;
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type SupportGroup = z.infer<typeof supportGroupSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type Evaluation = z.infer<typeof evaluationSchema>;
export type Correction = z.infer<typeof correctionSchema>;
export type Statement = z.infer<typeof statementSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Incident = z.infer<typeof incidentSchema>;

export interface GraphNode {
  id: string;
  kind: 'evidence' | 'claim';
  title: string;
  status: string;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}
export interface GraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
  generation: string;
  projectedSeq: number;
}

export interface RepairProposal {
  evaluations: Evaluation[];
  report: Report;
  impact: Impact;
  manifest: ContextManifest;
}
export interface RepairTask {
  id: string;
  incidentId: string;
  evidenceEpoch: number;
  kind: 'repair' | 'report_preview';
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'superseded';
  attemptCount: number;
  maxAttempts: number;
  activeAttemptId: string | null;
  pauseBeforeCommit: boolean;
  deliveryVersion: number;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  reportVersion: number | null;
}
export interface RepairAttempt {
  id: string;
  taskId: string;
  incidentId: string;
  number: number;
  evidenceEpoch: number;
  status: 'running' | 'paused' | 'accepted' | 'stale' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  reason: string | null;
  manifest: ContextManifest | null;
  inputSeq: number;
  reportVersion: number | null;
}

/** HTTP snapshot shared with the browser; agent audit detail is deferred. */
export interface Snapshot {
  incident: Incident;
  diagnostics: Diagnostic[];
  graph: GraphView | null;
  graphError: string | null;
  mode: 'deterministic' | 'live';
  agentAvailability: { configured: boolean; provider: string | null; model: string | null };
  storage: 'PGlite + FalkorDB' | 'PostgreSQL + FalkorDB';
  work: {
    tasks: RepairTask[];
    attempts: RepairAttempt[];
    modelCalls: Array<{ id: string; status: string }>;
    toolCalls: Array<{ id: string; status: string }>;
  };
}
