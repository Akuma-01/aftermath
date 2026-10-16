import express from 'express';
import { mcpRouter } from './mcp';
import { z } from 'zod';
import { ConflictError, NotFoundError } from '@aftermath/storage';
import type { InvestigationService } from './service';

const command = z.strictObject({
  expectedEventSeq: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
});
const withdrawal = command.extend({ reason: z.string().trim().min(5).max(1000) });
export function createApp(service: InvestigationService, appOrigin = 'http://localhost:5173') {
  const app = express();
  const allowedOrigins = new Set([appOrigin]);
  const configuredOrigin = new URL(appOrigin);
  if (['localhost', '127.0.0.1'].includes(configuredOrigin.hostname)) {
    for (const host of ['localhost', '127.0.0.1']) {
      allowedOrigins.add(
        `${configuredOrigin.protocol}//${host}:${configuredOrigin.port || '5173'}`,
      );
      allowedOrigins.add(`http://${host}:${process.env.PORT ?? '4000'}`);
    }
  }
  app.disable('x-powered-by');
  // Local development boundary; no public multi-user deployment is implied.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      req.headers.origin &&
      !allowedOrigins.has(req.headers.origin)
    ) {
      res
        .status(403)
        .json({ error: 'This origin cannot modify the local workspace', code: 'ORIGIN_FORBIDDEN' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.param('id', (_req, _res, next, value) => {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) {
      next(parsed.error);
      return;
    }
    next();
  });
  app.use('/api/mcp', mcpRouter(service, allowedOrigins));
  app.get('/api/incidents/:id/service-impact/:serviceId', async (req, res) => {
    res.json(await service.graphAnalysis(req.params.id, 'service-impact', req.params.serviceId));
  });
  app.get('/api/health', async (_req, res) => {
    const incidents = await service.ledger.list();
    const ready = incidents[0] ? Boolean((await service.snapshot(incidents[0].id)).graph) : true;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'graph_unavailable',
      agentsConfigured: false,
    });
  });
  app.get('/api/incidents', async (_req, res) => {
    const incidents = await service.ledger.list();
    res.json(incidents.map(({ id, title, eventSeq }) => ({ id, title, eventSeq })));
  });
  app.post('/api/incidents', async (req, res) => {
    const { scenario } = z
      .strictObject({ scenario: z.enum(['checkout', 'commerce']).default('checkout') })
      .parse(req.body ?? {});
    res.status(201).json(await service.create(scenario));
  });
  app.get('/api/incidents/:id', async (req, res) => {
    res.json(await service.snapshot(req.params.id));
  });
  app.post('/api/incidents/:id/evidence/:evidenceId/withdrawals', async (req, res) => {
    const data = withdrawal.parse(req.body);
    res.json(
      await service.withdraw(
        req.params.id,
        req.params.evidenceId,
        data.reason,
        data.expectedEventSeq,
        data.idempotencyKey,
      ),
    );
  });
  app.post('/api/incidents/:id/repairs', async (req, res) => {
    const data = command.parse(req.body);
    res
      .status(202)
      .json(await service.repair(req.params.id, data.expectedEventSeq, data.idempotencyKey));
  });
  app.post('/api/incidents/:id/held-reports', async (req, res) => {
    const data = command.parse(req.body);
    res
      .status(202)
      .json(await service.holdReport(req.params.id, data.expectedEventSeq, data.idempotencyKey));
  });
  app.post('/api/incidents/:id/repairs/:taskId/resume', async (req, res) => {
    const data = command.parse(req.body);
    res
      .status(202)
      .json(
        await service.resumeReport(
          req.params.id,
          req.params.taskId,
          data.expectedEventSeq,
          data.idempotencyKey,
        ),
      );
  });
  app.get('/api/incidents/:id/events', async (req, res) => {
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.query.after ?? 0);
    const incident = await service.ledger.get(req.params.id);
    res.json({
      eventSeq: incident.eventSeq,
      events: (incident.events ?? []).filter((event) => event.seq > after),
    });
  });
  app.post('/api/incidents/:id/diagnostics/:recipeId', async (req, res) => {
    const data = command.parse(req.body);
    if (
      !['production-pool', 'payment-timeouts', 'source-environment'].includes(req.params.recipeId)
    ) {
      res.status(400).json({ error: 'Unknown diagnostic recipe', code: 'INVALID_REQUEST' });
      return;
    }
    res.json(
      await service.diagnose(
        req.params.id,
        req.params.recipeId,
        data.expectedEventSeq,
        data.idempotencyKey,
      ),
    );
  });
  app.post('/api/incidents/:id/sessions', async (req, res) => {
    const data = command.parse(req.body);
    res
      .status(201)
      .json(await service.freshSession(req.params.id, data.expectedEventSeq, data.idempotencyKey));
  });
  app.get('/api/incidents/:id/evidence', async (req, res) => {
    const incident = await service.ledger.get(req.params.id);
    res.json({
      eventSeq: incident.eventSeq,
      evidenceEpoch: incident.evidenceEpoch,
      evidence: incident.evidence,
      corrections: incident.corrections,
    });
  });
  app.get('/api/incidents/:id/evidence/:evidenceId', async (req, res) => {
    const incident = await service.ledger.get(req.params.id);
    const evidence = incident.evidence.find((e) => e.id === req.params.evidenceId);
    if (!evidence) throw new NotFoundError('Evidence version not found');
    res.json({
      eventSeq: incident.eventSeq,
      evidence,
      corrections: incident.corrections.filter((c) => c.targetId === evidence.id),
    });
  });
  app.get(
    ['/api/incidents/:id/support', '/api/incidents/:id/claims', '/api/incidents/:id/graph'],
    async (req, res) => {
      res.json(await service.graphAnalysis(z.string().uuid().parse(req.params.id), 'support'));
    },
  );
  app.get('/api/incidents/:id/claims/:claimId', async (req, res) => {
    const claimId = z.string().min(1).max(200).parse(req.params.claimId);
    res.json(await service.inspectClaim(req.params.id, claimId));
  });
  app.get('/api/incidents/:id/topology', async (req, res) => {
    res.json(await service.graphAnalysis(req.params.id, 'topology'));
  });
  app.get('/api/incidents/:id/diagnostics', async (req, res) => {
    res.json(await service.graphAnalysis(req.params.id, 'diagnostics'));
  });
  app.get('/api/incidents/:id/reports', async (req, res) => {
    const incident = await service.ledger.get(req.params.id);
    res.json({
      eventSeq: incident.eventSeq,
      reportStatus: incident.reportStatus,
      reports: incident.reports,
      manifest: incident.reportManifest ?? null,
    });
  });
  app.get('/api/incidents/:id/repairs', async (req, res) => {
    const snapshot = await service.snapshot(req.params.id);
    res.json({
      eventSeq: snapshot.incident.eventSeq,
      reportStatus: snapshot.incident.reportStatus,
      error: snapshot.incident.repairError ?? null,
      ...snapshot.work,
    });
  });
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
  });
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: error.issues.map((i) => i.message).join('; '),
          code: 'INVALID_REQUEST',
          issues: error.issues,
        });
        return;
      }
      const bodyError = error as { type?: string };
      if (_req.path === '/api/mcp' && bodyError.type === 'entity.parse.failed') {
        res
          .status(400)
          .json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
        return;
      }
      const status =
        bodyError.type === 'entity.too.large'
          ? 413
          : error instanceof ConflictError
            ? 409
            : error instanceof NotFoundError
              ? 404
              : error instanceof SyntaxError
                ? 400
                : 503;
      if (status === 503) console.error(error);
      res.status(status).json({
        code:
          status === 409
            ? 'CONFLICT'
            : status === 404
              ? 'NOT_FOUND'
              : status === 413
                ? 'PAYLOAD_TOO_LARGE'
                : status === 400
                  ? 'INVALID_REQUEST'
                  : 'SERVICE_UNAVAILABLE',
        error:
          status === 503
            ? 'The memory service is unavailable. Your recorded changes are retained; retry when the graph is ready.'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      });
    },
  );
  return app;
}
