import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Diagnostic, Evaluation } from '@aftermath/contracts';
import { createIncident, applyDiagnostic } from '@aftermath/fixtures';
import { EvidenceGraph } from '@aftermath/graph';
import { diagnosticCases, type DiagnosticCase } from './diagnostic-cases';
import { checksum, fraction } from './runner';

const states = (evaluations: Evaluation[]) =>
  Object.fromEntries(evaluations.map((e) => [e.claimId, e.status]));
const sameStates = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** Exercises the graph ranker and registered synthetic outcomes, without an agent or SQL worker. */
export async function runDiagnosticCase(graph: EvidenceGraph, scenario: DiagnosticCase) {
  const started = performance.now();
  const errors: string[] = [];
  const incident = createIncident();
  incident.id = randomUUID();

  let candidates: Diagnostic[] = [];
  let selectedDiagnostic: string | null = null;
  let beforeStates: Record<string, string> = {};
  let afterStates: Record<string, string> = {};
  let selectionAssessed = false;
  try {
    for (const recipe of scenario.precompleted) {
      applyDiagnostic(incident, recipe);
      incident.eventSeq++;
    }
    for (const withdrawal of scenario.withdrawals) {
      const evidence = incident.evidence.find((e) => e.id === withdrawal.id);
      if (!evidence) throw new Error('Unknown withdrawal target');
      evidence.status = 'withdrawn';
      incident.eventSeq++;
      incident.evidenceEpoch++;
    }
    const before = await graph.read(incident);
    beforeStates = states(before.evaluations);
    if (!sameStates(beforeStates, scenario.beforeStates))
      errors.push('Initial graph states differ from oracle');
    candidates = await graph.diagnostics(incident);
    if (candidates.some((c) => c.graphGeneration !== before.view.generation))
      throw new Error('Diagnostic graph generation mismatch');
    selectedDiagnostic = candidates.find((c) => c.available && c.score > 0)?.id ?? null;
    selectionAssessed = true;
    if (selectedDiagnostic !== scenario.expectedDiagnostic)
      errors.push('Graph ranking differs from expected diagnostic');
    if (selectedDiagnostic) {
      applyDiagnostic(incident, selectedDiagnostic);
      incident.eventSeq++;
    }
    afterStates = states((await graph.read(incident)).evaluations);
    if (!sameStates(afterStates, scenario.afterStates))
      errors.push('Final graph states differ from oracle');
    if (
      scenario.newEvidenceId &&
      !incident.evidence.some((e) => e.id === scenario.newEvidenceId && e.status === 'active')
    )
      errors.push('Expected observation was not recorded');
    if (
      scenario.withdrawals.some(
        (w) => incident.evidence.find((e) => e.id === w.id)?.status !== 'withdrawn',
      )
    )
      errors.push('Withdrawn evidence was reactivated');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Diagnostic evaluation failed');
  }
  return {
    caseId: scenario.id,
    caseChecksum: checksum(scenario),
    outcome: errors.length ? ('failed' as const) : ('passed' as const),
    errors,
    expectedDiagnostic: scenario.expectedDiagnostic,
    selectedDiagnostic,
    selectionAssessed,
    candidates,
    beforeStates,
    afterStates,
    elapsedMs: performance.now() - started,
    modelCalls: 0 as const,
  };
}

export async function runDiagnosticEvaluation() {
  const cases = diagnosticCases();
  const graph = await EvidenceGraph.open();
  const results: Awaited<ReturnType<typeof runDiagnosticCase>>[] = [];
  try {
    for (const scenario of cases) results.push(await runDiagnosticCase(graph, scenario));
  } finally {
    await graph.close();
  }
  return {
    version: 'deterministic-diagnostics-v1',
    completedAt: new Date().toISOString(),
    scope:
      'Five development conditions of one synthetic incident family. Actual FalkorDB ranking and local elapsed times; no AI selection, semantic quality, production probes, SQL worker latency or token savings measured.',
    datasetChecksum: checksum(cases),
    cases,
    results,
    outcome: results.every((r) => r.outcome === 'passed') ? 'passed' : 'failed',
    rankingAccuracy: fraction(
      results.filter((r) => r.selectionAssessed && r.selectedDiagnostic === r.expectedDiagnostic)
        .length,
      cases.length,
    ),
    modelCalls: 0,
  };
}
