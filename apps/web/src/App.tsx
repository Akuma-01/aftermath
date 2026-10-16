import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  Database,
  FileText,
  FlaskConical,
  GitBranch,
  History,
  Layers3,
  LoaderCircle,
  Network,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  TriangleAlert,
  Unplug,
  X,
} from 'lucide-react';
import type { Evidence, Evaluation, Incident, Snapshot } from '@aftermath/contracts';
import {
  getSnapshot,
  listIncidents,
  savedIncident,
  rememberIncident,
  request,
  type IncidentSummary,
} from './api';
import EvidenceMap from './EvidenceMap';
import ServiceMap from './ServiceMap';
import WorkHistory from './WorkHistory';
import AgentActivity from './AgentActivity';

const short = (id: string) => id.split('-')[0];
const time = (date: string) =>
  new Date(date).toLocaleTimeString('en-GB', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
  });
function Status({ value, label }: { value: string; label?: string }) {
  return (
    <span className={`status ${value}`}>
      <i />
      {label ?? value.replaceAll('_', ' ')}
    </span>
  );
}
function Logo() {
  return (
    <svg width="29" height="31" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path
        d="M8 30 20 8l12 22M13 22h14"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="20" cy="8" r="3.5" fill="currentColor" />
    </svg>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [incidents, setIncidents] = useState<IncidentSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reportVersion, setReportVersion] = useState<number | null>(null);
  const requestEpoch = useRef(0);
  const [support, setSupport] = useState<{
    incidentId: string;
    eventSeq: number;
    claimId: string;
    evaluation: Evaluation;
  } | null>(null);
  const [supportRetry, setSupportRetry] = useState(0);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('E1-v1');
  const [tab, setTab] = useState<'workspace' | 'activity' | 'memory'>('workspace');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [withdrawal, setWithdrawal] = useState<Evidence | null>(null);
  const [reason, setReason] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const mutationLock = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = snapshot?.incident.id ?? null;
  const refresh = useCallback(async () => {
    const ticket = ++requestEpoch.current;
    try {
      const choices = await listIncidents();
      const preferred = selectedRef.current ?? savedIncident();
      const id = choices.find((i) => i.id === preferred)?.id ?? choices[0]?.id;
      const next = id ? await getSnapshot(id) : null;
      if (ticket !== requestEpoch.current) return;
      setIncidents(choices);
      setSnapshot(next);
      if (id) {
        selectedRef.current = id;
        rememberIncident(id);
      }
      setError(null);
      setConnectionLost(false);
    } catch (e) {
      if (ticket === requestEpoch.current) setError((e as Error).message);
    } finally {
      if (ticket === requestEpoch.current) setLoaded(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      requestEpoch.current++;
    };
  }, [refresh]);
  async function selectIncident(id: string) {
    if (mutationLock.current || id === selectedRef.current) return;
    mutationLock.current = true;
    requestEpoch.current++;
    setBusy('Opening investigation');
    setError(null);
    setNotice(null);
    try {
      const next = await getSnapshot(id);
      selectedRef.current = id;
      rememberIncident(id);
      setSnapshot(next);
      setSelectedId(next.incident.evidence[0]?.id ?? next.incident.claims[0]?.id ?? '');
      setReportVersion(null);
      setShowDiff(false);
      setShowInspector(false);
      setWithdrawal(null);
      setConnectionLost(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      mutationLock.current = false;
      setBusy(null);
    }
  }
  useEffect(() => {
    if (withdrawal) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [withdrawal]);
  useEffect(() => {
    if (!snapshot) return;
    const id = snapshot.incident.id;
    let inFlight = false;
    const timer = setInterval(() => {
      if (mutationLock.current || inFlight) return;
      inFlight = true;
      const ticket = requestEpoch.current;
      void getSnapshot(id)
        .then((next) => {
          if (
            selectedRef.current === id &&
            !mutationLock.current &&
            ticket === requestEpoch.current
          ) {
            setSnapshot((old) =>
              !old || next.incident.eventSeq >= old.incident.eventSeq ? next : old,
            );
            setConnectionLost(false);
          }
        })
        .catch(() => {
          if (
            selectedRef.current === id &&
            !mutationLock.current &&
            ticket === requestEpoch.current
          )
            setConnectionLost(true);
        })
        .finally(() => {
          inFlight = false;
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [snapshot?.incident.id]);

  async function act(label: string, path: string, extra: Record<string, unknown> = {}) {
    if (!snapshot || mutationLock.current) return;
    mutationLock.current = true;
    requestEpoch.current++;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await request(`/incidents/${snapshot.incident.id}${path}`, {
        expectedEventSeq: snapshot.incident.eventSeq,
        idempotencyKey: crypto.randomUUID(),
        ...extra,
      });
      setSnapshot(await getSnapshot(snapshot.incident.id));
      setConnectionLost(false);
      setNotice(
        label === 'Repairing report'
          ? 'Repair queued. Progress and the accepted revision will appear automatically.'
          : label === 'Opening session'
            ? 'New session opened with persisted correction memory.'
            : label === 'Withdrawing source'
              ? 'Source withdrawn. Automatic repair has been queued.'
              : label === 'Preparing held report'
                ? 'A report is being prepared and held before publication.'
                : label === 'Resuming held report'
                  ? 'The held attempt will pass through the publication gate using its original input.'
                  : 'Diagnostic observation recorded. Automatic repair has been queued.',
      );
      return true;
    } catch (e) {
      setError((e as Error).message);
      try {
        setSnapshot(await getSnapshot(snapshot.incident.id));
      } catch {
        /* Keep the last known snapshot visibly marked by the error. */
      }
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(null);
    }
  }
  async function newInvestigation(scenario: 'checkout' | 'commerce' = 'checkout') {
    if (mutationLock.current) return;
    mutationLock.current = true;
    requestEpoch.current++;
    setBusy('Opening investigation');
    setError(null);
    setNotice(null);
    try {
      const incident = await request<Incident>('/incidents', { scenario });
      setSnapshot(await getSnapshot(incident.id));
      selectedRef.current = incident.id;
      rememberIncident(incident.id);
      setIncidents((old) => [
        { id: incident.id, title: incident.title, eventSeq: incident.eventSeq },
        ...old,
      ]);
      setReportVersion(null);
      setConnectionLost(false);
      setLoaded(true);
      setSelectedId('E1-v1');
      setTab('workspace');
      setShowDiff(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      mutationLock.current = false;
      setBusy(null);
    }
  }
  const incident = snapshot?.incident;
  const selectedEvidence = incident?.evidence.find((e) => e.id === selectedId);
  const selectedClaim = incident?.claims.find((c) => c.id === selectedId);
  const evaluation =
    support?.incidentId === incident?.id &&
    support?.eventSeq === incident?.eventSeq &&
    support?.claimId === selectedId &&
    snapshot?.graph
      ? support.evaluation
      : undefined;
  useEffect(() => {
    setSupport(null);
    setSupportError(null);
    if (!incident || !selectedClaim || !snapshot?.graph) return;
    const controller = new AbortController();
    void request<{ incidentId: string; eventSeq: number; evaluation: Evaluation }>(
      `/incidents/${incident.id}/claims/${encodeURIComponent(selectedClaim.id)}`,
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setSupport({ ...result, claimId: selectedClaim.id });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setSupportError(error.message);
      });
    return () => controller.abort();
  }, [incident?.id, incident?.eventSeq, selectedClaim?.id, Boolean(snapshot?.graph), supportRetry]);
  const report =
    incident?.reports.find((r) => r.version === reportVersion) ?? incident?.reports.at(-1);
  const previous = incident?.reports.find((r) => r.version === (report?.version ?? 0) - 1);
  const historical = !!report && report.version !== incident?.reports.at(-1)?.version;
  const stale = incident?.reportStatus === 'needs_review';
  const activeRepair = snapshot?.work.tasks.find(
    (task) =>
      task.kind === 'repair' &&
      task.evidenceEpoch === incident?.evidenceEpoch &&
      ['pending', 'running'].includes(task.status),
  );

  return (
    <div className="app-shell">
      <aside className="rail">
        <a className="brand-mark" href="/" aria-label="Aftermath home">
          <Logo />
        </a>
        <div className="rail-divider" />
        <button
          className={tab === 'workspace' ? 'rail-button active' : 'rail-button'}
          title="Investigation workspace"
          aria-label="Investigation workspace"
          onClick={() => setTab('workspace')}
        >
          <Layers3 size={21} />
        </button>
        <button
          className={tab === 'activity' ? 'rail-button active' : 'rail-button'}
          title="Activity ledger"
          aria-label="Activity ledger"
          onClick={() => setTab('activity')}
        >
          <Activity size={21} />
        </button>
        <button
          className={tab === 'memory' ? 'rail-button active' : 'rail-button'}
          title="Correction memory"
          aria-label="Correction memory"
          onClick={() => setTab('memory')}
        >
          <BookOpen size={21} />
        </button>
        <div className="rail-bottom">
          <span className="rail-live" title="Local workspace" />
          <div className="avatar">A</div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="wordmark">
            aftermath<span className="wordmark-dot">.</span>
          </div>
          <div className="breadcrumb">
            <span>Workspace</span>
            <span>/</span>
            <strong>Investigations</strong>
          </div>
          <span className="fixture-pill">
            <FlaskConical size={13} />
            Synthetic incident
            <span className="mode-divider" />
            {snapshot?.mode === 'live' ? 'Live agents' : 'Deterministic mode'}
          </span>
          <a
            className="source-link"
            href="https://github.com/FalkorDB/FalkorDB"
            target="_blank"
            rel="noreferrer"
            title="FalkorDB project"
          >
            Powered by FalkorDB
            <ArrowUpRight size={13} />
          </a>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                <span className="live-dot" />
                INCIDENT WORKSPACE <span className="eyebrow-slash">/</span>{' '}
                {incident?.id.slice(0, 8).toUpperCase() ?? 'CONNECTING'}
              </div>
              <h1>{incident?.title ?? 'Opening your investigation…'}</h1>
              <div className="incident-meta">
                <span className="severity">{incident?.severity ?? '—'}</span>
                <span>
                  <span className="meta-dot" />
                  {incident?.evidence[0]?.scope.environment ?? '—'}
                </span>
                <span>
                  <Terminal size={13} />
                  {incident?.service ?? '—'}
                </span>
                <span>
                  <Clock3 size={13} />
                  {incident?.evidence[0]?.scope.timeWindow ?? '—'}
                </span>
              </div>
            </div>
            <button
              className="button secondary commerce-demo"
              disabled={!!busy}
              onClick={() => void newInvestigation('commerce')}
            >
              Commerce demo
            </button>
            <button
              className="button secondary new-investigation"
              onClick={() => void newInvestigation()}
              disabled={!!busy}
            >
              <Plus size={15} />
              New investigation
            </button>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <TriangleAlert size={17} />
              <span>{error}</span>
              <button onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {connectionLost && (
            <div className="error-banner" role="alert">
              <Unplug size={17} />
              <span>Updates unavailable. Showing the last received snapshot.</span>
              <button onClick={() => void refresh()}>Reconnect</button>
            </div>
          )}
          {notice && (
            <div className="notice-banner" role="status">
              <CheckCircle2 size={15} />
              <span>{notice}</span>
              <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          {!snapshot && (
            <div className="loading-panel">
              {error ? <Unplug size={28} /> : <LoaderCircle className="spin" size={28} />}
              <h2>
                {error
                  ? 'Workspace unavailable'
                  : loaded
                    ? 'No incidents yet'
                    : 'Connecting the evidence'}
              </h2>
              <p>
                {loaded && !error
                  ? 'Create a new investigation or open the commerce demo to begin.'
                  : 'The local API and graph engine must be running.'}
              </p>
            </div>
          )}
          {incidents.length > 0 && (
            <label className="incident-picker">
              Investigation
              <select
                aria-label="Select investigation"
                disabled={!!busy}
                value={incident?.id ?? ''}
                onChange={(e) => void selectIncident(e.target.value)}
              >
                {incidents.map((i) => (
                  <option value={i.id} key={i.id}>
                    {i.title} · {i.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="workspace-toolbar">
            <div className="tabs">
              <button
                className={tab === 'workspace' ? 'tab active' : 'tab'}
                onClick={() => setTab('workspace')}
              >
                <Network size={15} />
                Investigation
              </button>
              <button
                className={tab === 'activity' ? 'tab active' : 'tab'}
                onClick={() => setTab('activity')}
              >
                <History size={15} />
                Activity<span className="tab-count">{incident?.events?.length ?? 0}</span>
              </button>
              <button
                className={tab === 'memory' ? 'tab active' : 'tab'}
                onClick={() => setTab('memory')}
              >
                <BookOpen size={15} />
                Memory<span className="tab-count">{incident?.corrections.length ?? 0}</span>
              </button>
            </div>
            <div className="toolbar-status">
              <span className={`live-dot ${snapshot?.graph && !connectionLost ? '' : 'offline'}`} />
              <span role="status">
                {connectionLost
                  ? 'Updates unavailable'
                  : snapshot?.graph
                    ? 'Graph connected'
                    : 'Memory unavailable'}
              </span>
              <span className="toolbar-separator" />
              {incident?.evidence.filter((e) => e.status === 'active').length ?? 0} active sources
            </div>
          </div>
          {snapshot && incident && report && (
            <>
              {tab === 'workspace' && (
                <>
                  <div className={`recovery-banner ${stale ? 'needs-review' : ''}`}>
                    <div className="recovery-icon">
                      {stale ? <TriangleAlert size={21} /> : <ShieldCheck size={22} />}
                    </div>
                    <div>
                      <strong>
                        {stale
                          ? incident.repairError
                            ? 'Repair needs attention.'
                            : 'The evidence changed. Repair is in progress.'
                          : incident.corrections.length
                            ? 'Correction applied. The investigation has recovered.'
                            : 'An investigation is only as strong as its evidence.'}
                      </strong>
                      <p>
                        {stale
                          ? (incident.repairError ??
                            'The previous revision is historical. A background worker will re-evaluate support and publish a current revision.')
                          : incident.corrections.length
                            ? 'Inspect the impact paths, review surviving support, or open a fresh session to retrieve the correction.'
                            : 'Select a source to inspect its provenance. Withdraw evidence to see exactly which findings need to change.'}
                      </p>
                    </div>
                    {stale ? (
                      <button
                        className="button primary"
                        disabled={!!busy || !snapshot.graph || !!activeRepair}
                        onClick={() => void act('Repairing report', '/repairs')}
                      >
                        <RotateCcw size={15} />
                        {activeRepair?.status === 'running'
                          ? 'Repairing…'
                          : activeRepair
                            ? 'Repair queued'
                            : 'Retry repair'}
                      </button>
                    ) : (
                      <span className="verified-label">
                        <Check size={14} />
                        Report current
                      </span>
                    )}
                  </div>
                  {snapshot.work.attempts.length > 0 && (
                    <div className="worker-summary">
                      <span>
                        <Activity size={14} />
                        {snapshot.work.attempts.filter((a) => a.status === 'accepted').length}{' '}
                        published attempts <span className="toolbar-separator" />
                        {snapshot.work.attempts.filter((a) => a.status === 'stale').length} stale
                        results rejected
                      </span>
                      <button className="text-button" onClick={() => setTab('activity')}>
                        Inspect worker history
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                  <div className="workspace-grid">
                    <section className="panel evidence-panel">
                      <div className="panel-heading">
                        <div>
                          <FileText size={15} />
                          <h2>Evidence</h2>
                          <span className="count">{incident.evidence.length}</span>
                        </div>
                        <span className="subtle-label">BY OBSERVATION</span>
                      </div>
                      <div className="evidence-list">
                        {incident.evidence.map((e) => (
                          <button
                            key={e.id}
                            className={`evidence-card ${selectedId === e.id ? 'selected' : ''} ${e.status === 'withdrawn' ? 'withdrawn' : ''}`}
                            onClick={() => {
                              setSelectedId(e.id);
                              setShowInspector(false);
                            }}
                          >
                            <div className="evidence-card-top">
                              <span className="source-id">{short(e.id)}</span>
                              <span className="source-type">{e.kind}</span>
                              <span className="source-time">{time(e.observedAt)}</span>
                            </div>
                            <strong>{e.title}</strong>
                            <p>{e.summary}</p>
                            <div className="evidence-card-foot">
                              <span>
                                <span className={`source-dot ${e.status}`} />
                                {e.status === 'active' ? e.source : 'Withdrawn'}
                              </span>
                              <ArrowUpRight size={13} />
                            </div>
                          </button>
                        ))}
                      </div>
                      <div className="evidence-footer">
                        <Database size={13} />
                        Versioned sources. Original history retained.
                      </div>
                    </section>
                    <div className="center-column">
                      <section className="panel graph-panel">
                        <div className="panel-heading">
                          <div>
                            <GitBranch size={16} />
                            <h2>Evidence graph</h2>
                          </div>
                          <span className="small-badge">{incident.claims.length} findings</span>
                        </div>
                        <div className="graph-subheader">
                          <span>Follow a finding back to its sources.</span>
                          <span className="graph-live">
                            <span className="live-dot" />
                            {snapshot.graph ? 'LIVE GRAPH' : 'GRAPH UNAVAILABLE'}
                          </span>
                        </div>
                        <div className="graph-canvas">
                          {snapshot.graph ? (
                            <EvidenceMap
                              key={incident.id}
                              graph={snapshot.graph}
                              incident={incident}
                              selectedId={selectedId}
                              onSelect={(id) => {
                                setSelectedId(id);
                                setShowInspector(false);
                              }}
                            />
                          ) : (
                            <div className="graph-unavailable">
                              <Unplug size={24} />
                              <strong>Graph memory is unavailable</strong>
                              <p>
                                Dependency results remain unavailable until projection succeeds.
                              </p>
                            </div>
                          )}
                        </div>
                        <div className="graph-legend">
                          <span>
                            <i className="legend-dot supported" />
                            Supported
                          </span>
                          <span>
                            <i className="legend-dot unsupported" />
                            Unsupported
                          </span>
                          <span>
                            <i className="legend-dot withdrawn" />
                            Withdrawn
                          </span>
                          <span>
                            <i className="legend-dot contested" />
                            Contested
                          </span>
                          <span className="legend-direction">Finding → premise</span>
                        </div>
                      </section>
                      <section className="panel inspector-panel">
                        <div className="panel-heading">
                          <div>
                            <CircleDot size={15} />
                            <h2>{selectedEvidence ? 'Source inspector' : 'Finding inspector'}</h2>
                          </div>
                          <span className="mono muted">{selectedId}</span>
                        </div>
                        {selectedEvidence && (
                          <div className="inspector-body">
                            <div className="inspector-title">
                              <h3>{selectedEvidence.title}</h3>
                              <Status value={selectedEvidence.status} />
                            </div>
                            <p>{selectedEvidence.summary}</p>
                            <div className="source-details">
                              <span>
                                Environment<strong>{selectedEvidence.scope.environment}</strong>
                              </span>
                              <span>
                                Service<strong>{selectedEvidence.service}</strong>
                              </span>
                              <span>
                                Source version<strong>v{selectedEvidence.version}</strong>
                              </span>
                            </div>
                            <details className="provenance">
                              <summary>Source provenance and scope</summary>
                              <p>
                                Source: {selectedEvidence.sourceId} · Origin:{' '}
                                {selectedEvidence.originGroupId}
                              </p>
                              <p>Window: {selectedEvidence.scope.timeWindow}</p>
                              <p>Observed: {selectedEvidence.observedAt}</p>
                            </details>
                            {incident.corrections
                              .filter((c) => c.targetId === selectedEvidence.id)
                              .map((c) => (
                                <div className="correction-note" key={c.id}>
                                  <ShieldCheck size={15} />
                                  <span>{c.reason}</span>
                                </div>
                              ))}
                            <button
                              className="text-button"
                              onClick={() => setShowInspector(!showInspector)}
                            >
                              <Terminal size={14} />
                              {showInspector ? 'Hide raw observation' : 'View raw observation'}
                              <ChevronDown size={14} className={showInspector ? 'rotate' : ''} />
                            </button>
                            {showInspector && (
                              <pre className="raw-observation">{selectedEvidence.content}</pre>
                            )}
                            <div className="inspector-actions">
                              <span>Evidence is versioned and scoped.</span>
                              <button
                                className="button danger-outline"
                                disabled={!!busy || selectedEvidence.status !== 'active'}
                                onClick={() => {
                                  setWithdrawal(selectedEvidence);
                                  setReason(
                                    selectedEvidence.id === 'E1-v1'
                                      ? 'Source environment verified as staging; imported production scope is incorrect.'
                                      : '',
                                  );
                                }}
                              >
                                <Unplug size={14} />
                                {selectedEvidence.status === 'active'
                                  ? 'Withdraw source'
                                  : 'Source withdrawn'}
                              </button>
                            </div>
                          </div>
                        )}
                        {selectedClaim && (
                          <div className="inspector-body">
                            <div className="inspector-title">
                              <h3>{selectedClaim.title}</h3>
                              <Status value={evaluation?.status ?? 'needs_review'} />
                            </div>
                            <p>{selectedClaim.text}</p>
                            {supportError && (
                              <p role="alert">
                                Support inspection unavailable: {supportError}{' '}
                                <button
                                  className="text-button"
                                  onClick={() => setSupportRetry((n) => n + 1)}
                                >
                                  Retry support
                                </button>
                              </p>
                            )}
                            {!evaluation && !supportError && (
                              <p role="status">
                                {snapshot.graph
                                  ? 'Loading current graph support…'
                                  : 'Current graph support is unavailable.'}
                              </p>
                            )}
                            <div className="support-caption">
                              {selectedClaim.type} · all premises within a group are required; any
                              valid group is sufficient
                            </div>
                            {selectedClaim.supportGroups.map((group, i) => (
                              <div className="support-group" key={group.id}>
                                <span className="group-label">{i === 0 ? 'SUPPORT' : 'OR'}</span>
                                {group.memberIds.map((id, index) => (
                                  <span className="premise" key={id}>
                                    {index > 0 && <span className="and-label">AND</span>}
                                    <button onClick={() => setSelectedId(id)}>
                                      {short(id)}
                                      <ArrowUpRight size={11} />
                                    </button>
                                  </span>
                                ))}
                                <Status
                                  value={
                                    !evaluation || evaluation.status === 'needs_review'
                                      ? 'needs_review'
                                      : evaluation?.validGroupIds.includes(group.id)
                                        ? 'supported'
                                        : 'unsupported'
                                  }
                                />
                              </div>
                            ))}
                            {selectedClaim.oppositionGroups.length > 0 && (
                              <div className="opposition-block">
                                <div className="support-caption">
                                  Contrary evidence — admissible opposing observations make a
                                  supported finding contested.
                                </div>
                                {selectedClaim.oppositionGroups.map((group) => (
                                  <div className="support-group" key={group.id}>
                                    <span className="group-label">CONFLICT</span>
                                    {group.memberIds.map((id) => (
                                      <span className="premise" key={id}>
                                        <button onClick={() => setSelectedId(id)}>
                                          {short(id)}
                                          <ArrowUpRight size={11} />
                                        </button>
                                      </span>
                                    ))}
                                  </div>
                                ))}
                              </div>
                            )}
                            {!!evaluation?.invalidGroups.length && (
                              <details className="provenance">
                                <summary>Rejected support and opposition</summary>
                                {evaluation.invalidGroups.map((group) => (
                                  <p key={group.id}>
                                    {group.id}: {group.reasons.join('; ')}
                                  </p>
                                ))}
                              </details>
                            )}
                            <p className="origin-note">
                              {evaluation
                                ? `${evaluation.originGroupIds.length} distinct recorded source origins. Copies of one source count once.`
                                : 'Provenance counts are awaiting graph inspection.'}
                            </p>
                          </div>
                        )}
                      </section>
                    </div>
                    <section className={`panel report-panel ${stale ? 'report-stale' : ''}`}>
                      <div className="panel-heading">
                        <div>
                          <BookOpen size={15} />
                          <h2>Investigation report</h2>
                        </div>
                        <span className="report-version">v{report.version}</span>
                      </div>
                      <div className="report-summary">
                        <label className="revision-picker">
                          Report version
                          <select
                            aria-label="Report version"
                            value={reportVersion ?? 'latest'}
                            onChange={(e) => {
                              setReportVersion(
                                e.target.value === 'latest' ? null : Number(e.target.value),
                              );
                              setShowDiff(false);
                            }}
                          >
                            <option value="latest">
                              Latest · v{incident.reports.at(-1)?.version}
                            </option>
                            {incident.reports.map((r) => (
                              <option key={r.version} value={r.version}>
                                v{r.version} · epoch {r.evidenceEpoch}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="report-overline">
                          {stale ? <TriangleAlert size={14} /> : <ShieldCheck size={14} />}
                          {historical
                            ? 'HISTORICAL REVISION'
                            : stale
                              ? 'PREVIOUS REVISION · NEEDS REVIEW'
                              : 'CURRENT REVISION'}
                        </div>
                        <h3>What we know so far</h3>
                        <p>Evidence-linked findings for this incident.</p>
                        <div className="report-view-tabs">
                          <button
                            className={!showDiff ? 'active' : ''}
                            onClick={() => setShowDiff(false)}
                          >
                            Findings
                          </button>
                          <button
                            className={showDiff ? 'active' : ''}
                            disabled={!previous}
                            onClick={() => setShowDiff(true)}
                          >
                            Revision diff
                            {previous && (
                              <span>
                                {
                                  report.statements.filter((s) => s.disposition === 'revised')
                                    .length
                                }
                              </span>
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="report-statements">
                        {report.statements.map((statement, index) => (
                          <article
                            className={`report-statement ${statement.status}`}
                            key={statement.id}
                          >
                            <div className="statement-heading">
                              <span className="statement-number">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <span className="statement-type">
                                {incident.claims.find((c) => c.id === statement.claimId)?.type}
                              </span>
                              {statement.disposition === 'preserved' && !stale && (
                                <span className="preserved-badge">
                                  <ShieldCheck size={11} />
                                  Preserved
                                </span>
                              )}
                              {statement.disposition === 'revised' && !stale && (
                                <span className="revised-badge">Revised</span>
                              )}
                            </div>
                            <h4>{statement.title}</h4>
                            {showDiff && statement.disposition === 'revised' && (
                              <p className="old-text">
                                {previous?.statements.find((s) => s.id === statement.id)?.text}
                              </p>
                            )}
                            <p
                              className={
                                showDiff && statement.disposition === 'revised' ? 'new-text' : ''
                              }
                            >
                              {statement.text}
                            </p>
                            <div className="statement-footer">
                              <button
                                className="citation"
                                onClick={() => setSelectedId(statement.claimId)}
                              >
                                <GitBranch size={11} />
                                {short(statement.claimId)}
                                <ArrowUpRight size={10} />
                              </button>
                              <Status
                                value={stale && !historical ? 'needs_review' : statement.status}
                              />
                            </div>
                          </article>
                        ))}
                      </div>
                      <div className="report-footer">
                        <FlaskConical size={13} />
                        Deterministic report · No model calls
                      </div>
                    </section>
                  </div>
                  {incident.lastImpact && (
                    <section className="impact-strip">
                      <div>
                        <GitBranch size={19} />
                        <strong>Correction impact</strong>
                      </div>
                      <span>
                        <b>{incident.lastImpact.affectedClaimIds.length}</b> affected findings
                      </span>
                      <span className="green-text">
                        <b>{incident.lastImpact.preservedClaimIds.length}</b> preserved by valid
                        support
                      </span>
                      <span className="amber-text">
                        <b>{incident.lastImpact.unresolvedClaimIds.length}</b> unresolved
                      </span>
                      <details>
                        <summary>Inspect returned paths</summary>
                        <div>
                          {incident.lastImpact.paths.length ? (
                            incident.lastImpact.paths.map((path, i) => (
                              <p key={i}>{path.map(short).join(' → ')}</p>
                            ))
                          ) : (
                            <p>No dependent claims were found in the recorded graph.</p>
                          )}
                        </div>
                      </details>
                    </section>
                  )}
                  {incident.topology && <ServiceMap key={incident.id} incident={incident} />}
                  <section className="diagnostics-section">
                    <div className="section-heading">
                      <div>
                        <FlaskConical size={17} />
                        <h2>Next checks</h2>
                        <span>Bounded diagnostics, informed by the evidence.</span>
                      </div>
                      <span className="read-only-label">
                        <ShieldCheck size={12} />
                        READ ONLY · SYNTHETIC DATA
                      </span>
                    </div>
                    {!snapshot.diagnostics.length && (
                      <p className="empty-state">
                        {snapshot.graph
                          ? 'No diagnostic recipes are registered for this incident.'
                          : 'Diagnostics are unavailable until graph analysis recovers.'}
                      </p>
                    )}
                    <div className="diagnostic-grid">
                      {snapshot.diagnostics.map((diagnostic, i) => (
                        <article className="diagnostic-card" key={diagnostic.id}>
                          <div className="diagnostic-top">
                            <span className="diagnostic-icon">
                              <Terminal size={17} />
                            </span>
                            {diagnostic.completed ? (
                              <span className="completed-label">
                                <CheckCircle2 size={12} />
                                Complete
                              </span>
                            ) : i === 0 && diagnostic.score > 0 ? (
                              <span className="suggested-label">Suggested check</span>
                            ) : (
                              <span className="subtle-label">AVAILABLE CHECK</span>
                            )}
                          </div>
                          <h3>{diagnostic.title}</h3>
                          <p>{diagnostic.description}</p>
                          <div className="diagnostic-reason">{diagnostic.reason}</div>
                          {!!diagnostic.paths?.length && (
                            <details className="diagnostic-paths">
                              <summary>Why this check ({diagnostic.paths.length} paths)</summary>
                              {diagnostic.paths.map((path) => (
                                <p key={path.claimId}>
                                  {short(path.claimId)} → {path.serviceIds.join(' → ')}
                                </p>
                              ))}
                            </details>
                          )}
                          <button
                            className="text-button"
                            disabled={!!busy || !diagnostic.available}
                            onClick={() =>
                              void act('Running diagnostic', `/diagnostics/${diagnostic.id}`)
                            }
                          >
                            {diagnostic.completed ? 'Observation recorded' : 'Run check'}
                            {diagnostic.completed ? <Check size={14} /> : <ArrowRight size={14} />}
                          </button>
                        </article>
                      ))}
                    </div>
                  </section>
                </>
              )}
              {tab === 'activity' && (
                <section className="panel activity-panel">
                  <div className="section-intro">
                    <span className="section-icon">
                      <History size={25} />
                    </span>
                    <h2>The investigation ledger</h2>
                    <p>
                      Every correction, diagnostic, and revision has a durable place in the
                      timeline.
                    </p>
                  </div>
                  <AgentActivity key={incident.id} snapshot={snapshot} busy={!!busy} />
                  <WorkHistory
                    work={snapshot.work}
                    busy={!!busy}
                    onAction={(label, path) => {
                      void act(label, path);
                    }}
                  />
                  <div className="event-list">
                    {[...(incident.events ?? [])].reverse().map((event) => (
                      <article className="event" key={event.id}>
                        <span className="event-seq">{String(event.seq).padStart(2, '0')}</span>
                        <div>
                          <div className="event-type">
                            {event.type.replaceAll('.', ' / ').replaceAll('_', ' ')}
                          </div>
                          <p>{event.message}</p>
                        </div>
                        <time>{time(event.occurredAt)} UTC</time>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {tab === 'memory' && (
                <section className="memory-layout">
                  <section className="panel memory-main">
                    <div className="section-intro">
                      <span className="section-icon">
                        <BookOpen size={25} />
                      </span>
                      <h2>Corrections outlive the conversation.</h2>
                      <p>
                        Open a fresh session to retrieve corrections from the graph, with no
                        previous conversation history. This prototype demonstrates deterministic
                        retrieval.
                      </p>
                      <button
                        className="button primary"
                        disabled={!!busy || !snapshot.graph}
                        onClick={() => void act('Opening session', '/sessions')}
                      >
                        <Plus size={15} />
                        Open fresh session
                      </button>
                    </div>
                    <div className="memory-sessions">
                      {(incident.sessions ?? []).length === 0 ? (
                        <div className="empty-state">
                          <Sparkles size={22} />
                          <h3>A clean context. The same memory.</h3>
                          <p>
                            Withdraw a source, then open a session to see which versions the gateway
                            excludes.
                          </p>
                        </div>
                      ) : (
                        [...(incident.sessions ?? [])].reverse().map((session) => (
                          <article className="session-card" key={session.id}>
                            <div className="session-heading">
                              <span>
                                <span className="live-dot" />
                                SESSION {session.id.slice(0, 8)}
                              </span>
                              <span>{time(session.createdAt)} UTC</span>
                            </div>
                            <p>{session.message}</p>
                            <div className="session-tags">
                              <span>0 prior chat messages</span>
                              <span>{session.correctionIds.length} corrections retrieved</span>
                            </div>
                            {session.rejectedSourceIds.length > 0 && (
                              <div className="rejected-sources">
                                <ShieldCheck size={15} />
                                Excluded from support: {session.rejectedSourceIds.join(', ')}
                              </div>
                            )}
                            <details>
                              <summary>Retrieval provenance</summary>
                              <p className="mono">Graph: {session.graphGeneration}</p>
                              {session.correctionIds.map((id) => (
                                <p className="mono" key={id}>
                                  Correction: {id}
                                </p>
                              ))}
                            </details>
                          </article>
                        ))
                      )}
                    </div>
                  </section>
                  <section className="panel correction-panel">
                    <div className="panel-heading">
                      <div>
                        <ShieldCheck size={15} />
                        <h2>Persisted corrections</h2>
                      </div>
                      <span className="count">{incident.corrections.length}</span>
                    </div>
                    {incident.corrections.length ? (
                      incident.corrections.map((correction) => (
                        <article key={correction.id} className="correction-card">
                          <span className="source-id">{correction.targetId}</span>
                          <p>{correction.reason}</p>
                          <span className="muted">Exact version · Incident scope</span>
                        </article>
                      ))
                    ) : (
                      <div className="empty-state">
                        <p>
                          No corrections yet. Withdraw a source from the investigation workspace.
                        </p>
                        <button className="text-button" onClick={() => setTab('workspace')}>
                          Back to investigation
                          <ArrowRight size={14} />
                        </button>
                      </div>
                    )}
                  </section>
                </section>
              )}
              <footer className="workspace-footer">
                <span>
                  <Logo />
                  AFTERMATH <span className="footer-separator">/</span>Trace the evidence. Repair
                  the investigation.
                </span>
                <span>
                  Local prototype · Evidence epoch {incident.evidenceEpoch} · Event{' '}
                  {incident.eventSeq}
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
      <dialog
        ref={dialogRef}
        className="withdraw-dialog"
        onCancel={(event) => {
          if (busy) event.preventDefault();
          else setWithdrawal(null);
        }}
        onClose={() => setWithdrawal(null)}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (withdrawal)
              void act('Withdrawing source', `/evidence/${withdrawal.id}/withdrawals`, {
                reason,
              }).then((ok) => {
                if (ok) setWithdrawal(null);
              });
          }}
        >
          <div className="dialog-icon">
            <Unplug size={24} />
          </div>
          <div className="dialog-heading">
            <h2>Withdraw this source</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close dialog"
              disabled={!!busy}
              onClick={() => setWithdrawal(null)}
            >
              <X size={20} />
            </button>
          </div>
          <p>
            Remove <strong>{withdrawal?.title}</strong> from accepted support. Its original content
            and your correction will stay in the investigation history.
          </p>
          <label htmlFor="withdrawal-reason">Reason for withdrawal</label>
          <textarea
            autoFocus
            id="withdrawal-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={5}
            maxLength={1000}
            required
            rows={4}
            placeholder="Describe what changed or why this evidence is no longer valid…"
          />
          <div className="dialog-note">
            <TriangleAlert size={16} />
            The current report will immediately be marked for review.
          </div>
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => setWithdrawal(null)}
            >
              Cancel
            </button>
            <button
              className="button danger"
              type="submit"
              disabled={!!busy || reason.trim().length < 5}
            >
              {busy ? <LoaderCircle size={15} className="spin" /> : <Unplug size={15} />}
              {busy ? 'Withdrawing…' : 'Withdraw evidence'}
            </button>
          </div>
        </form>
      </dialog>
      {busy && (
        <div className="busy-indicator" role="status">
          <LoaderCircle size={15} className="spin" />
          {busy}…
        </div>
      )}
    </div>
  );
}
