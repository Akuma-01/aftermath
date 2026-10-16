import { useState } from 'react';
import { Bot, Play, TriangleAlert } from 'lucide-react';
import type { ModelCallDetail, Snapshot } from '@aftermath/contracts';
import { request } from './api';

export default function AgentActivity({
  snapshot,
  busy,
  onRun,
}: {
  snapshot: Snapshot;
  busy: boolean;
  onRun: () => void;
}) {
  const [detail, setDetail] = useState<ModelCallDetail | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = snapshot.work.tasks.some(
    (t) => t.kind === 'repair' && ['pending', 'running'].includes(t.status),
  );
  const config = snapshot.incident.agentConfig;
  const report = snapshot.incident.reports.at(-1);
  const diagnosticDecision = report?.agent?.diagnosticDecision;
  async function inspect(id: string) {
    if (detail?.id === id) {
      setDetail(null);
      return;
    }
    setLoading(id);
    setError(null);
    try {
      setDetail(
        await request<ModelCallDetail>(`/incidents/${snapshot.incident.id}/model-calls/${id}`),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(null);
    }
  }
  return (
    <section className="agent-activity">
      <div className="work-heading">
        <div>
          <h3>
            <Bot size={18} /> Investigator &amp; reporter
          </h3>
          <p>Two agents inspect shared evidence and propose a cited report.</p>
        </div>
        <button
          className="button primary"
          onClick={onRun}
          disabled={busy || running || !snapshot.agentAvailability.configured}
        >
          <Play size={14} />
          Run AI investigation
        </button>
      </div>
      <p className="agent-disclosure">
        {snapshot.agentAvailability.configured
          ? `${config?.provider ?? snapshot.agentAvailability.provider} / ${config?.model ?? snapshot.agentAvailability.model}. Live calls use the configured provider. Corrections in this investigation will also trigger live repair.`
          : 'Live agents are not configured on this server. The deterministic fixture remains available.'}
      </p>
      {config && (
        <p className="agent-disclosure">
          At most {config.maxCalls} calls per task, {config.maxOutputTokens.toLocaleString()} output
          tokens per call. Model wording is proposed interpretation; support eligibility and
          publication are checked by the application.
        </p>
      )}
      {diagnosticDecision && (
        <section
          className={`diagnostic-decision ${diagnosticDecision.status}`}
          aria-label="Recorded diagnostic decision"
        >
          <div>
            <strong>
              {diagnosticDecision.status === 'executed'
                ? 'Diagnostic executed'
                : diagnosticDecision.status === 'deferred'
                  ? 'Diagnostics deferred'
                  : 'No relevant diagnostic needed'}
            </strong>
            <span className="small-badge">Report v{report!.version}</span>
          </div>
          <p>{diagnosticDecision.reason}</p>
          {diagnosticDecision.consideredRecipeIds.length > 0 && (
            <p>
              Considered:{' '}
              {diagnosticDecision.consideredRecipeIds
                .map((id) => snapshot.diagnostics.find((d) => d.id === id)?.title ?? id)
                .join('; ')}
              .
            </p>
          )}
          {diagnosticDecision.recipeId && (
            <p>
              Executed:{' '}
              {snapshot.diagnostics.find((d) => d.id === diagnosticDecision.recipeId)?.title ??
                diagnosticDecision.recipeId}
              .
            </p>
          )}
          <small>
            {diagnosticDecision.source === 'agent' ? 'Agent decision' : 'Application constraint'} ·
            Evidence epoch {diagnosticDecision.evidenceEpoch}
            {diagnosticDecision.status === 'deferred'
              ? ' · No check was executed in this attempt; unresolved findings remain.'
              : ''}
          </small>
          {snapshot.incident.reportStatus !== 'current' && (
            <p>
              This decision belongs to the last published revision. The current attempt has not
              published.
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert">
          <TriangleAlert size={14} /> {error}
        </p>
      )}
      {!snapshot.work.modelCalls.length && (
        <p className="attempt-empty">No agent calls recorded for this incident.</p>
      )}
      {snapshot.work.modelCalls.length > 0 && (
        <div className="model-call-list">
          {[...snapshot.work.modelCalls].reverse().map((call) => (
            <article className={`model-call ${call.status}`} key={call.id}>
              <div className="model-call-heading">
                <strong>{call.role}</strong>
                <span className="small-badge">{call.status}</span>
                <span className="mono muted">{call.model}</span>
              </div>
              <div className="attempt-meta">
                {call.credentialSlot && (
                  <span>{call.credentialSlot === 'backup' ? 'Backup key' : 'Primary key'}</span>
                )}
                <span>Input: {call.inputTokens ?? 'not reported'}</span>
                <span>Output: {call.outputTokens ?? 'not reported'}</span>
                <span>
                  {call.latencyMs === null
                    ? 'In progress'
                    : `${(call.latencyMs / 1000).toFixed(1)}s`}
                </span>
              </div>
              {call.failoverFromCallId && (
                <p className="muted">Switched to the backup key after a provider failure.</p>
              )}
              <div className="tool-call-list">
                {snapshot.work.toolCalls
                  .filter((t) => t.modelCallId === call.id)
                  .map((tool) => (
                    <span key={tool.id} className="small-badge">
                      {tool.name} · {tool.status}
                    </span>
                  ))}
              </div>
              {call.error && <p className="model-error">{call.error}</p>}
              <button
                className="button secondary small"
                disabled={Boolean(loading)}
                onClick={() => void inspect(call.id)}
              >
                {loading === call.id
                  ? 'Loading…'
                  : detail?.id === call.id
                    ? 'Close recorded call'
                    : 'Inspect recorded call'}
              </button>
              {detail?.id === call.id && (
                <div className="model-call-detail">
                  <p>
                    Session {detail.manifest.sessionId?.slice(0, 8)} · Evidence epoch{' '}
                    {detail.manifest.evidenceEpoch} · {detail.manifest.readArtifacts.length} input
                    artifacts
                  </p>
                  <details>
                    <summary>Recorded request</summary>
                    <pre>{JSON.stringify(detail.request, null, 2)}</pre>
                  </details>
                  <details>
                    <summary>Provider response</summary>
                    <pre>{JSON.stringify(detail.response, null, 2)}</pre>
                  </details>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
