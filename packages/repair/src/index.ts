import type { Incident, RepairProposal } from '@aftermath/contracts';
import { makeReport } from '@aftermath/domain';
import type { EvidenceGraph } from '@aftermath/graph';
import { Ledger, readArtifacts, StaleContextError } from '@aftermath/storage';
export class RepairProcessor {
  constructor(
    readonly ledger: Ledger,
    readonly graph: EvidenceGraph,
  ) {}
  async prepare(incident: Incident): Promise<RepairProposal> {
    return this.prepareFromModel(incident, await this.graph.read(incident));
  }
  private async prepareFromModel(
    incident: Incident,
    model: Awaited<ReturnType<EvidenceGraph['read']>>,
  ): Promise<RepairProposal> {
    const evaluations = model.evaluations;
    const previous = incident.reports.at(-1)!;
    const corrections = incident.corrections.filter(
      (c) => c.evidenceEpoch > previous.evidenceEpoch,
    );
    const paths = await Promise.all(
      corrections.map((c) => this.graph.impact(incident, c.targetId)),
    );
    if (paths.some((p) => p.generation !== model.view.generation))
      throw new Error('Graph generation changed during repair');
    const affected = [...new Set(paths.flatMap((p) => p.affectedClaimIds))];
    const claimOrder = new Map(incident.claims.map((claim, index) => [claim.id, index]));
    affected.sort((a, b) => claimOrder.get(a)! - claimOrder.get(b)!);
    return {
      evaluations,
      report: makeReport(
        [...model.claims].sort((a, b) => claimOrder.get(a.id)! - claimOrder.get(b.id)!),
        evaluations,
        incident.evidenceEpoch,
        previous,
      ),
      impact: {
        targetId: corrections.at(-1)?.targetId ?? 'diagnostic',
        affectedClaimIds: affected,
        preservedClaimIds: affected.filter(
          (id) => evaluations.find((e) => e.claimId === id)?.status === 'supported',
        ),
        unresolvedClaimIds: affected.filter(
          (id) => evaluations.find((e) => e.claimId === id)?.status !== 'supported',
        ),
        paths: paths.flatMap((p) => p.paths),
        graphGeneration: model.view.generation,
      },
      manifest: {
        evidenceEpoch: incident.evidenceEpoch,
        reportVersion: previous.version,
        graphGeneration: model.view.generation,
        projectedSeq: model.view.projectedSeq,
        readArtifacts: readArtifacts(incident),
      },
    };
  }
  async process(taskId: string) {
    const claimed = await this.ledger.jobs.claim(taskId);
    if (!claimed) return 'ignored';
    const heartbeat = setInterval(
      () => {
        void this.ledger.jobs
          .heartbeat(taskId, claimed.attempt.id)
          .catch((error) =>
            console.error(
              'Repair heartbeat failed:',
              error instanceof Error ? error.message : 'Database unavailable',
            ),
          );
      },
      Math.max(10, Math.floor(this.ledger.jobs.leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const proposal = claimed.proposal ?? (await this.prepare(claimed.incident));
      return await this.ledger.jobs.finish(taskId, claimed.attempt.id, proposal);
    } catch (error) {
      if (error instanceof StaleContextError) {
        await this.ledger.jobs.rejectStale(taskId, claimed.attempt.id, error.message);
        return 'stale';
      }
      await this.ledger.jobs.fail(
        taskId,
        claimed.attempt.id,
        error instanceof Error ? error.message : 'Repair failed',
      );
      return 'failed';
    } finally {
      clearInterval(heartbeat);
    }
  }
}
