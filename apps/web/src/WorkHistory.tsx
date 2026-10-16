import { CheckCircle2, Clock3, Pause, Play, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { Snapshot } from '@aftermath/contracts';

export default function WorkHistory({
  work,
  busy,
  onAction,
}: {
  work: Snapshot['work'];
  busy: boolean;
  onAction: (label: string, path: string) => void;
}) {
  const held = work.tasks.filter(
    (task) =>
      task.kind === 'report_preview' && ['pending', 'running', 'paused'].includes(task.status),
  );
  return (
    <section className="work-history">
      <div className="work-heading">
        <div>
          <h3>Repair attempts</h3>
          <p>Each execution keeps its input context and publication result.</p>
        </div>
        <span className="small-badge">{work.attempts.length} recorded</span>
      </div>
      <div className="race-control">
        <span className="race-icon">
          <ShieldCheck size={22} />
        </span>
        <div>
          <strong>See outdated work get rejected</strong>
          <p>Hold a report, withdraw a source in the workspace, then resume the held attempt.</p>
        </div>
        <button
          className="button secondary"
          disabled={busy || held.length > 0}
          onClick={() => onAction('Preparing held report', '/held-reports')}
        >
          <Pause size={14} />
          Hold a report
        </button>
      </div>
      {held.map((task) => (
        <div className="held-task" key={task.id}>
          <div>
            <strong>
              {task.status === 'paused'
                ? 'Report held before publication'
                : 'Preparing the held report…'}
            </strong>
            <p>
              Original evidence epoch {task.evidenceEpoch}. Its input stays fixed when you resume.
            </p>
          </div>
          <button
            className="button primary"
            disabled={busy || task.status !== 'paused'}
            onClick={() => onAction('Resuming held report', `/repairs/${task.id}/resume`)}
          >
            <Play size={14} />
            Resume held report
          </button>
        </div>
      ))}
      {work.attempts.length === 0 ? (
        <div className="attempt-empty">
          No worker attempts yet. Withdrawing a source automatically schedules a repair.
        </div>
      ) : (
        <div className="attempt-list">
          {work.attempts.map((attempt) => (
            <article className={`attempt-card ${attempt.status}`} key={attempt.id}>
              <div className="attempt-card-heading">
                <span className={`attempt-state ${attempt.status}`}>
                  {attempt.status === 'accepted' ? (
                    <CheckCircle2 size={15} />
                  ) : attempt.status === 'stale' || attempt.status === 'failed' ? (
                    <TriangleAlert size={15} />
                  ) : attempt.status === 'paused' ? (
                    <Pause size={15} />
                  ) : (
                    <Clock3 size={15} />
                  )}
                  {attempt.status === 'stale'
                    ? 'Rejected · stale evidence'
                    : attempt.status === 'accepted'
                      ? 'Published'
                      : attempt.status}
                </span>
                <span className="mono muted">
                  Attempt {attempt.number} · {attempt.id.slice(0, 8)}
                </span>
              </div>
              <p>
                {attempt.reason ??
                  (attempt.status === 'accepted'
                    ? `Report v${attempt.reportVersion} passed the publication checks.`
                    : attempt.status === 'paused'
                      ? 'Prepared output is retained. Publication is waiting for your resume action.'
                      : 'Reading the graph and evaluating accepted support.')}
              </p>
              <div className="attempt-meta">
                <span>Evidence epoch {attempt.evidenceEpoch}</span>
                <span>
                  {new Date(attempt.startedAt).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC
                </span>
                <span>Deterministic worker</span>
              </div>
              {attempt.manifest && (
                <details>
                  <summary>Inspect input context</summary>
                  <div className="manifest-grid">
                    <span>
                      Input report<strong>v{attempt.manifest.reportVersion}</strong>
                    </span>
                    <span>
                      Artifacts read<strong>{attempt.manifest.readArtifacts.length}</strong>
                    </span>
                    <span>
                      Graph sequence<strong>{attempt.manifest.projectedSeq}</strong>
                    </span>
                  </div>
                  <p className="mono">{attempt.manifest.graphGeneration}</p>
                  <p className="mono">
                    {attempt.manifest.readArtifacts.map((artifact) => artifact.id).join(' · ')}
                  </p>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
