import { incidentSchema, type Incident } from '@aftermath/contracts';
import { validateGraph } from '@aftermath/domain';
import { canonical } from './manifest';
import { ConflictError } from './state';

export function validateIncident(incident: Incident) {
  incidentSchema.parse(incident);
  validateGraph(incident.evidence, incident.claims);
  const versions = new Set<string>();
  for (const evidence of incident.evidence) {
    const key = JSON.stringify([evidence.sourceId, evidence.version]);
    if (versions.has(key)) throw new ConflictError('Duplicate evidence source version');
    versions.add(key);
  }
  const corrections = new Set<string>();
  for (const correction of incident.corrections) {
    if (corrections.has(correction.id)) throw new ConflictError('Duplicate correction');
    corrections.add(correction.id);
    if (
      !incident.evidence.some((e) => e.id === correction.targetId && e.status === 'withdrawn') ||
      correction.evidenceEpoch > incident.evidenceEpoch
    )
      throw new ConflictError('Correction must identify a withdrawn version at a valid epoch');
  }
  for (const evidence of incident.evidence) {
    if (
      evidence.status === 'withdrawn' &&
      !incident.corrections.some((c) => c.targetId === evidence.id)
    )
      throw new ConflictError('Withdrawn evidence requires a correction record');
  }
  incident.reports.forEach((report, index) => {
    if (report.version !== index + 1 || report.evidenceEpoch > incident.evidenceEpoch)
      throw new ConflictError('Invalid report version or evidence epoch');
  });
  if (
    incident.reportStatus === 'current' &&
    incident.reports.at(-1)?.evidenceEpoch !== incident.evidenceEpoch
  )
    throw new ConflictError('Current report must match the evidence epoch');
  const events = incident.events ?? [];
  if (
    events.length !== incident.eventSeq ||
    events.some((event, index) => event.seq !== index + 1) ||
    new Set(events.map((e) => e.id)).size !== events.length
  )
    throw new ConflictError('Event sequence must be contiguous and unique');
}

export function assertHistory(before: Incident, after: Incident) {
  if (
    before.id !== after.id ||
    before.eventSeq !== after.eventSeq ||
    canonical(before.events) !== canonical(after.events)
  )
    throw new ConflictError('Incident identity and event history are ledger-owned');
  for (const old of before.evidence) {
    const current = after.evidence.find((e) => e.id === old.id);
    if (!current || canonical({ ...old, status: current.status }) !== canonical(current))
      throw new ConflictError('Evidence versions are immutable; append a new version');
    if (old.status !== 'active' && old.status !== current.status)
      throw new ConflictError('Unavailable evidence cannot be reactivated or rewritten');
  }
  for (const added of after.evidence.filter(
    (e) => !before.evidence.some((old) => old.id === e.id),
  )) {
    const maximum = Math.max(
      0,
      ...before.evidence.filter((e) => e.sourceId === added.sourceId).map((e) => e.version),
    );
    if (added.version <= maximum) throw new ConflictError('Evidence version must increase');
  }
  for (const old of before.claims) {
    const current = after.claims.find((c) => c.id === old.id);
    if (
      !current ||
      canonical({
        ...old,
        supportGroups: current.supportGroups,
        oppositionGroups: current.oppositionGroups,
      }) !== canonical(current)
    )
      throw new ConflictError('Claim versions cannot be overwritten');
    for (const key of ['supportGroups', 'oppositionGroups'] as const) {
      if (canonical(current[key].slice(0, old[key].length)) !== canonical(old[key]))
        throw new ConflictError('Existing claim support history cannot be overwritten');
    }
  }
  if (
    canonical(after.corrections.slice(0, before.corrections.length)) !==
    canonical(before.corrections)
  )
    throw new ConflictError('Corrections are append-only');
  if (
    canonical(after.reports) !== canonical(before.reports) ||
    canonical(after.reportManifest) !== canonical(before.reportManifest)
  )
    throw new ConflictError('Reports may only change through fenced publication');
}

export function reasoningInputs(incident: Incident) {
  return canonical({
    evidence: incident.evidence,
    claims: incident.claims,
    corrections: incident.corrections,
    topology: incident.topology,
    diagnosticRecipes: incident.diagnosticRecipes,
    completedDiagnosticIds: incident.completedDiagnosticIds,
  });
}
