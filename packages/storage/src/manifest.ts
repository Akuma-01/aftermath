import { createHash } from 'node:crypto';
import type { Incident } from '@aftermath/contracts';

// JSONB may reorder object keys; a manifest hash must survive a database round trip.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function readArtifacts(incident: Incident) {
  const artifacts = [
    ...incident.evidence,
    ...incident.claims,
    ...incident.corrections,
    { id: 'current-report', report: incident.reports.at(-1) },
    {
      id: 'incident-context',
      title: incident.title,
      service: incident.service,
      severity: incident.severity,
      ...(incident.agentConfig ? { agentConfig: incident.agentConfig } : {}),
      topology: incident.topology ?? null,
      diagnosticRecipes: incident.diagnosticRecipes ?? null,
      completedDiagnosticIds: incident.completedDiagnosticIds ?? [],
    },
  ];
  return artifacts
    .map((artifact) => ({
      id: artifact.id,
      hash: createHash('sha256').update(canonical(artifact)).digest('hex'),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
