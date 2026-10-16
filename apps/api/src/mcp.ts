import { Router } from 'express';
import { z } from 'zod';
import type { InvestigationService } from './service';

// Small, stateless MCP Streamable HTTP server: JSON responses, read-only tools, no SSE.
// Protocol: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
const version = '2025-06-18';
const incidentId = z.string().uuid();
const definitions = {
  list_incidents: {
    description: 'List local synthetic investigations and their IDs.',
    schema: z.strictObject({}),
  },
  inspect_support: {
    description:
      'Read graph-evaluated support, opposition, surviving alternatives, and premise memberships for an incident.',
    schema: z.strictObject({ incidentId }),
  },
  rank_diagnostics: {
    description:
      'Rank registered checks using unresolved claims and shortest service paths. Returns explanation paths; never runs a diagnostic.',
    schema: z.strictObject({ incidentId }),
  },
  service_blast_radius: {
    description:
      'Compute shortest incoming dependency paths and service PageRank in this incident. Dependency exposure and centrality do not establish a root cause.',
    schema: z.strictObject({ incidentId, serviceId: z.string().min(1).max(100) }),
  },
};
const request = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const rpcError = (id: string | number | null, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});
export async function dispatchMcp(service: InvestigationService, body: unknown) {
  const parsed = request.safeParse(body);
  if (!parsed.success) return rpcError(null, -32600, 'Invalid JSON-RPC request');
  const { id, method, params = {} } = parsed.data;
  if (id === undefined) return null; // Notifications never produce a JSON-RPC response.
  const success = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    const init = z
      .object({
        protocolVersion: z.string(),
        capabilities: z.object({}).passthrough(),
        clientInfo: z.object({ name: z.string(), version: z.string() }),
      })
      .safeParse(params);
    if (!init.success) return rpcError(id, -32602, 'Invalid initialization parameters');
    return success({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'aftermath', version: '0.2.0' },
      instructions:
        'Synthetic incident analysis. Read-only tools. Use returned incident IDs. Support and ranking come from FalkorDB; no raw Cypher or production actions are exposed.',
    });
  }
  if (method === 'ping') return success({});
  if (method === 'tools/list')
    return success({
      tools: Object.entries(definitions).map(([name, definition]) => {
        const { $schema: _schema, ...inputSchema } = z.toJSONSchema(definition.schema);
        return {
          name,
          description: definition.description,
          inputSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        };
      }),
    });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
  const name = params.name;
  if (typeof name !== 'string' || !Object.hasOwn(definitions, name))
    return rpcError(id, -32602, 'Unknown tool');
  const args = definitions[name as keyof typeof definitions].schema.safeParse(
    params.arguments ?? {},
  );
  if (!args.success) return rpcError(id, -32602, 'Invalid tool arguments');
  try {
    const input = args.data as { incidentId?: string; serviceId?: string };
    const output =
      name === 'list_incidents'
        ? {
            incidents: (await service.ledger.list()).map(({ id, title, eventSeq }) => ({
              id,
              title,
              eventSeq,
            })),
          }
        : await service.graphAnalysis(
            input.incidentId!,
            name === 'inspect_support'
              ? 'support'
              : name === 'rank_diagnostics'
                ? 'diagnostics'
                : 'service-impact',
            input.serviceId,
          );
    if (Buffer.byteLength(JSON.stringify(output)) > 262144)
      throw new Error('Graph tool response exceeds the 256 KiB limit');
    return success({
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    });
  } catch (error) {
    // Tool failures are visible; no fallback to ledger-only support or an empty graph.
    return success({
      isError: true,
      content: [
        { type: 'text', text: error instanceof Error ? error.message : 'Graph analysis failed' },
      ],
    });
  }
}

export function mcpRouter(service: InvestigationService, allowedOrigins: Set<string>) {
  const router = Router();
  router.use((req, res, next) => {
    if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) {
      res.status(403).json({ error: 'Origin is not allowed' });
      return;
    }
    const protocol = req.header('MCP-Protocol-Version');
    if (protocol && protocol !== version) {
      res.status(400).json(rpcError(null, -32600, 'Unsupported MCP protocol version'));
      return;
    }
    next();
  });
  router.post('/', async (req, res) => {
    if (!req.accepts('application/json') || !req.accepts('text/event-stream')) {
      res
        .status(406)
        .json(rpcError(null, -32600, 'Accept must include application/json and text/event-stream'));
      return;
    }
    const response = await dispatchMcp(service, req.body);
    if (response === null) res.status(202).end();
    else res.json(response);
  });
  router.all('/', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).end();
  });
  return router;
}
