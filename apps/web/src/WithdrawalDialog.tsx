import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Unplug, X } from 'lucide-react';
import type {
  Evidence,
  Incident,
  WithdrawalPreview,
  WithdrawalPreviewGuard,
} from '@aftermath/contracts';
import { previewWithdrawal } from './api';

export default function WithdrawalDialog({
  incident,
  evidence,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  incident: Incident;
  evidence: Evidence;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (reason: string, preview: WithdrawalPreviewGuard) => Promise<boolean | undefined>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState(
    evidence.id === 'E1-v1'
      ? 'Source environment verified as staging; imported production scope is incorrect.'
      : '',
  );
  const [preview, setPreview] = useState<WithdrawalPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [request, setRequest] = useState({ seq: incident.eventSeq, revision: 0 });
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    setPreview(null);
    void previewWithdrawal(incident.id, evidence.id, request.seq, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.snapshot.incidentId !== incident.id ||
          result.evidenceId !== evidence.id ||
          result.snapshot.eventSeq !== request.seq
        )
          throw new Error('Preview does not match this investigation. Refresh the preview.');
        setPreview(result);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setFailure(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [incident.id, evidence.id, request]);
  const active = incident.evidence.some((e) => e.id === evidence.id && e.status === 'active');
  const stale =
    preview !== null &&
    (preview.snapshot.eventSeq !== incident.eventSeq ||
      preview.snapshot.evidenceEpoch !== incident.evidenceEpoch ||
      preview.snapshot.reportVersion !== (incident.reports.at(-1)?.version ?? null));
  const canConfirm =
    !!preview && !stale && active && !loading && !busy && reason.trim().length >= 5;
  const title = (id: string) => incident.claims.find((c) => c.id === id)?.title ?? id;
  return (
    <dialog
      ref={dialog}
      className="withdraw-dialog withdrawal-comparison"
      aria-labelledby="withdrawal-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canConfirm || !preview) return;
          void onConfirm(reason, {
            snapshot: preview.snapshot,
            evidenceId: preview.evidenceId,
          }).then((ok) => {
            if (ok) onClose();
            else {
              setPreview(null);
              setFailure('Refresh the preview before trying again.');
            }
          });
        }}
      >
        <div className="dialog-heading">
          <h2 id="withdrawal-title">Withdraw this source</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p>
          Preview removing <strong>{evidence.title}</strong> from accepted support. Nothing changes
          until you confirm. The source and correction remain in the investigation history.
        </p>
        <section
          className="withdrawal-preview"
          aria-label="Withdrawal impact preview"
          aria-busy={loading}
        >
          <h3>Impact comparison</h3>
          {loading && (
            <p role="status">
              <LoaderCircle size={15} className="spin" /> Calculating impact with FalkorDB…
            </p>
          )}
          {!active && (
            <p role="status">
              This evidence is no longer active. Close this dialog to inspect the current
              investigation.
            </p>
          )}
          {stale && <p role="status">This preview is out of date. Refresh it before confirming.</p>}
          {preview && (
            <>
              <p>
                {preview.claims.filter((c) => c.change === 'changed').length} findings changed ·{' '}
                {preview.claims.filter((c) => c.change === 'unchanged').length} unchanged ·{' '}
                {preview.claims.filter((c) => c.after.status === 'contested').length} contested
                after withdrawal
              </p>
              <div className="preview-table-scroll">
                <table>
                  <caption>Claim support before and after withdrawal</caption>
                  <thead>
                    <tr>
                      <th>Finding</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.claims.map((claim) => (
                      <tr key={claim.claimId}>
                        <th scope="row">
                          {title(claim.claimId)}
                          <small>
                            {claim.change === 'changed' ? 'Support changed' : 'Unchanged'}
                            {claim.before.status === 'supported' &&
                            claim.after.status === 'supported'
                              ? ' · Conclusion remains supported'
                              : ''}
                          </small>
                          <details>
                            <summary>Support groups and provenance</summary>
                            <p>
                              Origins: {claim.before.originGroupIds.join(', ') || 'None'} →{' '}
                              {claim.after.originGroupIds.join(', ') || 'None'}
                            </p>
                            {claim.groups.length === 0 && <p>No support groups.</p>}
                            {claim.groups.map((group) => (
                              <p key={group.groupId}>
                                {group.groupId} ({group.polarity}):{' '}
                                {group.before.valid ? 'valid' : 'invalid'} →{' '}
                                {group.after.valid ? 'valid' : 'invalid'} · {group.change}
                                <br />
                                Requires all: {group.memberIds.join(' AND ')}
                                {group.after.reasons.length > 0 && (
                                  <>
                                    <br />
                                    {group.after.reasons.join('; ')}
                                  </>
                                )}
                              </p>
                            ))}
                          </details>
                        </th>
                        <td>
                          <span className={`status ${claim.before.status}`}>
                            {claim.before.status}
                          </span>
                        </td>
                        <td>
                          <span className={`status ${claim.after.status}`}>
                            {claim.after.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>Report conclusions and citations</summary>
                {preview.conclusions.length === 0 && <p>No report conclusions yet.</p>}
                {preview.conclusions.map((conclusion) => (
                  <p key={conclusion.statementId}>
                    <strong>{title(conclusion.claimId)}</strong>: {conclusion.beforeStatus} →{' '}
                    {conclusion.afterStatus} · {conclusion.change}
                    {conclusion.requiresReview ? ' · Requires review' : ' · Preserved'}
                    {conclusion.affectedCitationIds.length > 0 && (
                      <>
                        <br />
                        Citations needing review: {conclusion.affectedCitationIds.join(', ')}
                      </>
                    )}
                  </p>
                ))}
                <p>This is a support comparison, not proposed replacement report wording.</p>
              </details>
              <details>
                <summary>Related services and dependency paths ({preview.services.length})</summary>
                <p>
                  These relationships indicate investigation scope, not predicted service outages.
                </p>
                {preview.services.map((service) => (
                  <div key={service.serviceId}>
                    <strong>{service.serviceId}</strong>
                    <p>Related evidence and claims: {service.artifactIds.join(', ')}</p>
                    {service.dependencyPaths.map((path) => (
                      <p key={path.serviceId}>{path.path.join(' → ')}</p>
                    ))}
                  </div>
                ))}
              </details>
              <details>
                <summary>Evidence impact paths ({preview.paths.length})</summary>
                {preview.paths.map((path) => (
                  <p key={JSON.stringify(path)}>{path.join(' → ')}</p>
                ))}
              </details>
            </>
          )}
          {!loading && (
            <button
              type="button"
              className="button secondary"
              disabled={busy || !active}
              onClick={() => {
                setPreview(null);
                setLoading(true);
                setRequest({ seq: incident.eventSeq, revision: request.revision + 1 });
              }}
            >
              Refresh preview
            </button>
          )}
        </section>
        {(error || failure) && (
          <p className="dialog-error" role="alert">
            {[error, failure].filter(Boolean).join(' ')}
          </p>
        )}
        <label htmlFor="withdrawal-reason">Reason for withdrawal</label>
        <textarea
          id="withdrawal-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={5}
          maxLength={1000}
          required
          rows={3}
        />
        <p>The current report will be marked for review when you confirm.</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button danger" type="submit" disabled={!canConfirm}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Unplug size={15} />}{' '}
            {busy ? 'Withdrawing…' : 'Withdraw evidence'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
