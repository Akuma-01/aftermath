import { Bot, Play } from 'lucide-react';
import type { Snapshot } from '@aftermath/contracts';

/** Milestone adapter: render the existing audit summary without calling deferred agent endpoints. */
export default function AgentActivity({ snapshot, busy }: { snapshot: Snapshot; busy: boolean }) {
  return (
    <section className="agent-activity" aria-label="Agent activity">
      <div className="work-heading">
        <div>
          <h3>
            <Bot size={18} /> Investigator &amp; reporter
          </h3>
          <p>Bounded agents will inspect shared evidence and propose cited reports.</p>
        </div>
        <button
          className="button primary"
          disabled
          aria-describedby="agent-availability"
          aria-busy={busy}
        >
          <Play size={14} />
          Run AI investigation
        </button>
      </div>
      <p className="agent-disclosure" id="agent-availability">
        AI investigation is unavailable in this build. Deterministic graph evaluation and background
        repair are available; no provider calls are made.
      </p>
      {snapshot.work.modelCalls.length === 0 && snapshot.work.toolCalls.length === 0 ? (
        <p className="attempt-empty">No agent calls recorded for this incident.</p>
      ) : (
        <div className="model-call-list">
          {snapshot.work.modelCalls.map((call) => (
            <article className="model-call" key={call.id}>
              <strong>Model call</strong>
              <p className="mono">{call.id}</p>
              <span className="small-badge">{call.status}</span>
            </article>
          ))}
          {snapshot.work.toolCalls.map((call) => (
            <article className="model-call" key={call.id}>
              <strong>Tool call</strong>
              <p className="mono">{call.id}</p>
              <span className="small-badge">{call.status}</span>
            </article>
          ))}
          <p className="agent-disclosure">
            Detailed agent inspection will be available with the agent runtime.
          </p>
        </div>
      )}
    </section>
  );
}
