import { randomUUID } from 'node:crypto';
import { createIncident, createCommerceIncident } from '@aftermath/fixtures';
import { Ledger } from '@aftermath/storage';
import { EvidenceGraph } from '@aftermath/graph';
import { RepairProcessor } from '@aftermath/repair';

export function repairHarness(ledger: Ledger, graph: EvidenceGraph) {
  return {
    ledger,
    graph,
    processor: new RepairProcessor(ledger, graph),
    async create(scenario?: string) {
      const incident = scenario === 'commerce' ? createCommerceIncident() : createIncident();
      incident.id = randomUUID();
      return ledger.create(incident);
    },
    withdraw: ledger.withdraw.bind(ledger),
    async repair(id: string, seq: number, key: string) {
      return ledger.mutate(
        id,
        seq,
        { key, fingerprint: 'repair' },
        'repair.queued',
        'Repair requested',
        () => {},
        true,
      );
    },
    async holdReport(id: string, seq: number, key: string) {
      return ledger.mutate(
        id,
        seq,
        { key, fingerprint: 'hold' },
        'repair.held',
        'Preview requested',
        async (i, tx) => {
          await ledger.jobs.ensure(tx, i, 'report_preview');
        },
      );
    },
    async resumeReport(id: string, taskId: string, seq: number, key: string) {
      return ledger.mutate(
        id,
        seq,
        { key, fingerprint: `resume:${taskId}` },
        'repair.resumed',
        'Resume requested',
        (i, tx) => ledger.jobs.resume(tx, i, taskId),
      );
    },
    async close() {
      try {
        await graph.close();
      } finally {
        await ledger.close();
      }
    },
  };
}
