import { EvidenceGraph } from '@aftermath/graph';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createCommerceIncident } from '@aftermath/fixtures';
import {
  runAgents,
  GeminiProvider,
  SUPPORT_NOTICE_PROMPT_VERSION,
  type AgentContext,
  type ModelInput,
  type ModelReply,
} from '@aftermath/agents';
import { evaluateSupport, makeReport } from '@aftermath/domain';
import { readArtifacts } from '@aftermath/storage';
import { ScriptedProvider, testConfig } from './support/scripted-provider';

class GraphToolProvider extends ScriptedProvider {
  override async invoke(request: unknown): Promise<ModelReply> {
    const input = request as ModelInput;
    if (input.tools.some((t) => t.name === 'inspectServiceImpact')) {
      this.inputs.push(structuredClone(input));
      return {
        calls: [{ name: 'inspectServiceImpact', arguments: { serviceId: 'database' } }],
        raw: {},
        inputTokens: 1,
        outputTokens: 1,
        error: null,
      };
    }
    return super.invoke(input);
  }
}
async function run(maxCalls: number, promptVersion = testConfig.promptVersion, unresolved = false) {
  const incident = createCommerceIncident();
  if (unresolved) {
    incident.evidence[0].status = 'withdrawn';
    incident.evaluations = evaluateSupport(incident.evidence, incident.claims);
  }
  const graph = await EvidenceGraph.open();
  let diagnostics;
  try {
    diagnostics = await graph.diagnostics(incident);
  } finally {
    await graph.close();
  }
  const graphGeneration = 'test-generation';
  const context: AgentContext = {
    incident,
    claims: incident.claims,
    evidence: incident.evidence,
    corrections: [],
    diagnostics: unresolved ? diagnostics : [],
    proposal: {
      evaluations: incident.evaluations,
      report: makeReport(incident.claims, incident.evaluations, 1, incident.reports[0]),
      impact: {
        targetId: 'diagnostic',
        affectedClaimIds: [],
        preservedClaimIds: [],
        unresolvedClaimIds: [],
        paths: [],
        graphGeneration,
      },
      manifest: {
        evidenceEpoch: 1,
        reportVersion: 1,
        graphGeneration,
        projectedSeq: 1,
        readArtifacts: readArtifacts(incident),
      },
    },
  };
  const provider = new GraphToolProvider();
  const inspected: string[] = [];
  const recorded: string[] = [];
  const result = await runAgents({
    maxCalls,
    maxOutputTokens: 4096,
    allowDiagnostic: true,
    promptVersion,
    read: async () => context,
    diagnose: async () => {
      throw new Error('No diagnostic was offered');
    },
    inspectServiceImpact: async (id) => {
      inspected.push(id);
      return { serviceId: id, paths: [], centrality: [] };
    },
    call: async (input) => {
      const request = provider.buildRequest(input);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
        testConfig.maxContextBytes,
      );
      const native = new GeminiProvider('test-model', 'unused-test-key').buildRequest(input);
      expect(Buffer.byteLength(JSON.stringify(native))).toBeLessThanOrEqual(
        testConfig.maxContextBytes,
      );
      const reply = await provider.invoke(request);
      return { id: randomUUID(), ...reply.calls[0] };
    },
    record: async (_id, _role, name, _args, _result, _context, rejected) => {
      expect(rejected).toBe(false);
      recorded.push(name);
    },
  });
  return { inspected, recorded, result, inputs: provider.inputs };
}
it('allows one graph algorithm tool while reserving proposal and reporter calls', async () => {
  const { inspected, recorded, result } = await run(6);
  expect(inspected).toEqual(['database']);
  expect(recorded).toContain('inspectServiceImpact');
  expect(recorded).toHaveLength(5);
  expect(result.proposal.report.statements).toHaveLength(18);
});
it('omits the optional algorithm when it would consume the reserved correction slot', async () => {
  expect((await run(5)).inspected).toEqual([]);
});
it('keeps v3 runs on their original tool set', async () => {
  expect((await run(6, SUPPORT_NOTICE_PROMPT_VERSION)).inspected).toEqual([]);
});

it('preserves six diagnostic calls before offering optional graph inspection', async () => {
  const constrained = await run(7, testConfig.promptVersion, true);
  expect(constrained.inputs[1].tools.map((t) => t.name)).not.toContain('inspectServiceImpact');
  const roomy = await run(8, testConfig.promptVersion, true);
  expect(roomy.inputs[1].tools.map((t) => t.name)).toContain('inspectServiceImpact');
  expect(roomy.inputs[2].tools.map((t) => t.name)).toContain('runDiagnostic');
});
