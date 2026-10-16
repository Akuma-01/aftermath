import { expect, it, vi } from 'vitest';
import { dispatchMcp } from '../apps/api/src/mcp';
import type { InvestigationService } from '../apps/api/src/service';
import { createCommerceIncident } from '@aftermath/fixtures';
import { evaluateSupport, validateGraph } from '@aftermath/domain';
import { readArtifacts } from '@aftermath/storage';

const incidentId = '123e4567-e89b-42d3-a456-426614174000';
function service() {
  return {
    ledger: { list: vi.fn(async () => [{ id: incidentId, title: 'Fixture', eventSeq: 7 }]) },
    graphAnalysis: vi.fn(async (id: string, kind: string, serviceId?: string) => ({
      incidentId: id,
      eventSeq: 7,
      result: { kind, serviceId },
    })),
  };
}
async function rpc(mock: ReturnType<typeof service>, method: string, params = {}) {
  return (await dispatchMcp(mock as unknown as InvestigationService, {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  })) as { result?: Record<string, unknown>; error?: { code: number } };
}
it('negotiates MCP and exposes only the four validated read-only graph tools', async () => {
  const mock = service();
  expect(
    (
      await rpc(mock, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
    ).result,
  ).toMatchObject({
    protocolVersion: '2025-06-18',
    capabilities: { tools: { listChanged: false } },
  });
  const tools = (await rpc(mock, 'tools/list')).result!.tools as Array<{
    name: string;
    annotations: { readOnlyHint: boolean };
  }>;
  expect(tools.map((t) => t.name)).toEqual([
    'list_incidents',
    'inspect_support',
    'rank_diagnostics',
    'service_blast_radius',
  ]);
  expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  expect(
    await dispatchMcp(mock as unknown as InvestigationService, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  ).toBeNull();
});
it('dispatches tool calls to the incident-scoped graph path and rejects arbitrary queries', async () => {
  const mock = service();
  expect(
    (
      await rpc(mock, 'tools/call', {
        name: 'service_blast_radius',
        arguments: { incidentId, serviceId: 'database' },
      })
    ).result,
  ).toHaveProperty('structuredContent');
  expect(mock.graphAnalysis).toHaveBeenCalledWith(incidentId, 'service-impact', 'database');
  expect(
    (
      await rpc(mock, 'tools/call', {
        name: 'run_cypher',
        arguments: { query: 'MATCH (n) DELETE n' },
      })
    ).error?.code,
  ).toBe(-32602);
  expect(
    (
      await rpc(mock, 'tools/call', {
        name: 'inspect_support',
        arguments: { incidentId, query: 'anything' },
      })
    ).error?.code,
  ).toBe(-32602);
  expect(
    (
      await rpc(mock, 'tools/call', {
        name: 'inspect_support',
        arguments: { incidentId: '../../' },
      })
    ).error?.code,
  ).toBe(-32602);
  expect(mock.graphAnalysis).toHaveBeenCalledTimes(1);
});
it('returns graph failure as a tool error, never a fabricated success', async () => {
  const mock = service();
  mock.graphAnalysis.mockRejectedValueOnce(new Error('Graph unavailable'));
  expect(
    (await rpc(mock, 'tools/call', { name: 'rank_diagnostics', arguments: { incidentId } })).result,
  ).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Graph unavailable' }] });
});
it('authors a bounded commerce fixture with a consequential withdrawal and independent support', () => {
  const incident = createCommerceIncident();
  expect(incident.topology!.services).toHaveLength(24);
  expect(incident.topology!.dependencies).toHaveLength(34);
  expect(incident.evidence).toHaveLength(17);
  expect(incident.claims).toHaveLength(18);
  validateGraph(incident.evidence, incident.claims);
  incident.evidence[0].status = 'withdrawn';
  const results = evaluateSupport(incident.evidence, incident.claims);
  expect(results.filter((e) => e.status === 'unsupported').map((e) => e.claimId)).toEqual([
    'C2-v1',
    'C3-v1',
    'C11-v1',
    'C13-v1',
    'C15-v1',
    'C16-v1',
  ]);
  expect(results.find((e) => e.claimId === 'C17-v1')?.validGroupIds).toEqual(['C17-G2']);
  expect(incident.evidence.some((e) => ['E7-v1', 'E8-v1', 'E9-v1'].includes(e.id))).toBe(false);
});
it('includes topology and diagnostic rules in publication hashes', () => {
  const incident = createCommerceIncident();
  const before = readArtifacts(incident);
  incident.topology!.dependencies.pop();
  expect(readArtifacts(incident)).not.toEqual(before);
  const topologyHash = readArtifacts(incident);
  incident.diagnosticRecipes![0].informs.pop();
  expect(readArtifacts(incident)).not.toEqual(topologyHash);
});

it('handles ping, invalid initialization, unknown methods and invalid request envelopes', async () => {
  const mock = service();
  expect((await rpc(mock, 'ping')).result).toEqual({});
  expect((await rpc(mock, 'initialize', {})).error?.code).toBe(-32602);
  expect((await rpc(mock, 'not_supported')).error?.code).toBe(-32601);
  expect(await dispatchMcp(mock as unknown as InvestigationService, {})).toMatchObject({
    error: { code: -32600 },
  });
  expect(
    await dispatchMcp(mock as unknown as InvestigationService, {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'list_incidents' },
    }),
  ).toBeNull();
  expect(mock.ledger.list).not.toHaveBeenCalled();
});

it('caps tool output rather than silently truncating graph results', async () => {
  const mock = service();
  mock.ledger.list.mockResolvedValueOnce([
    { id: incidentId, title: 'x'.repeat(262145), eventSeq: 1 },
  ]);
  expect(
    (await rpc(mock, 'tools/call', { name: 'list_incidents', arguments: {} })).result,
  ).toMatchObject({ isError: true });
});
