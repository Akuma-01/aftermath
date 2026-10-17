import { useEffect, useState } from 'react';
import { BarChart3, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  BenchmarkDetail,
  BenchmarkIndex,
  BenchmarkResult,
  BenchmarkTrial,
} from '@aftermath/contracts';
import { request } from './api';

const methodNames = {
  'full-rerun': 'Full rerun',
  'descendant-invalidation': 'Descendant invalidation',
  aftermath: 'Aftermath',
};
const date = (value: string) =>
  new Date(value).toLocaleString('en-GB', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const ms = (value: number | null) => (value === null ? 'N/A' : `${value.toFixed(3)} ms`);
const ids = (values: string[] | null) =>
  values === null ? 'Not measured' : values.length ? values.join(', ') : 'None';
type Metric = keyof BenchmarkTrial['metrics'];
const metricLabels: [Metric, string][] = [
  ['stateAccuracy', 'Support-state accuracy'],
  ['originAccuracy', 'Origin-count accuracy'],
  ['reviewPrecision', 'Review precision'],
  ['reviewRecall', 'Required-review recall'],
  ['affectedStatementPreservation', 'Eligible affected statements preserved'],
  ['unsupportedAssertionRate', 'Structurally unsupported assertions'],
];
function Ratio({ value }: { value: BenchmarkTrial['metrics'][Metric] }) {
  return (
    <>
      <strong>{value.value === null ? 'N/A' : `${(value.value * 100).toFixed(1)}%`}</strong>
      <small>
        {value.numerator} / {value.denominator}
      </small>
    </>
  );
}
function RunStatus({ status }: { status: BenchmarkDetail['status'] }) {
  return <span className={`benchmark-status ${status}`}>{status}</span>;
}

function Comparison({ result }: { result: BenchmarkResult }) {
  return (
    <section className="panel benchmark-comparison" aria-labelledby="policy-heading">
      <div className="benchmark-section-heading">
        <h3 id="policy-heading">Policy comparison</h3>
        <p>All methods evaluate the full support graph. Counts include every repetition.</p>
      </div>
      <div
        className="benchmark-table-scroll"
        role="region"
        aria-label="Policy comparison table; scroll horizontally on small screens"
        tabIndex={0}
      >
        <table className="benchmark-table">
          <caption>Correctness, requested revisions, and latency for this run only</caption>
          <thead>
            <tr>
              <th scope="col">Measurement</th>
              {result.summary.map((s) => (
                <th scope="col" key={s.method}>
                  {methodNames[s.method]}
                  <small>
                    {s.trials} trials · {s.failures} failed
                  </small>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metricLabels.map(([key, label]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                {result.summary.map((s) => (
                  <td key={s.method}>
                    <Ratio value={s.metrics[key]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="benchmark-work-row">
              <th scope="row">Requested statement revisions</th>
              {result.summary.map((s) => (
                <td key={s.method}>
                  <strong>{s.requestedStatementRevisions}</strong>
                  <div className="benchmark-bar" aria-hidden="true">
                    <i
                      style={{
                        width: `${(100 * s.requestedStatementRevisions) / Math.max(1, ...result.summary.map((v) => v.requestedStatementRevisions))}%`,
                      }}
                    />
                  </div>
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Avoidable revisions</th>
              {result.summary.map((s) => (
                <td key={s.method}>{s.avoidableStatementRevisions}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Claims evaluated</th>
              {result.summary.map((s) => (
                <td key={s.method}>{s.claimsEvaluated}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">
                Median total latency<small>Range includes failed trials</small>
              </th>
              {result.summary.map((s) => (
                <td key={s.method}>
                  <strong>{ms(s.totalLatencyMs.median)}</strong>
                  <small>
                    {ms(s.totalLatencyMs.min)} – {ms(s.totalLatencyMs.max)}
                  </small>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="benchmark-footnote">
        Preservation covers affected statements that still have valid support and need no citation
        or text update. Unsupported assertions are checked against structural support truth. Neither
        metric grades model-written prose. A zero denominator is N/A.
      </p>
    </section>
  );
}

function Trials({ result }: { result: BenchmarkResult }) {
  const [method, setMethod] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const rows = result.trials.filter(
    (t) =>
      (method === 'all' || t.method === method) &&
      (outcome === 'all' || t.outcome === outcome) &&
      `${t.caseId} ${t.family}`.toLowerCase().includes(query.toLowerCase()),
  );
  const pages = Math.ceil(rows.length / 10);
  return (
    <details className="panel benchmark-details">
      <summary>Inspect individual trials ({result.trials.length})</summary>
      <div className="benchmark-details-body">
        <div className="benchmark-filters">
          <label>
            Policy
            <select
              value={method}
              onChange={(e) => {
                setMethod(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All policies</option>
              {Object.entries(methodNames).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Outcome
            <select
              value={outcome}
              onChange={(e) => {
                setOutcome(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All outcomes</option>
              <option value="failed">Failed</option>
              <option value="passed">Passed</option>
            </select>
          </label>
          <label>
            Find a case
            <input
              type="search"
              value={query}
              placeholder="Case ID or family"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
        </div>
        <p className="benchmark-footnote" aria-live="polite">
          {rows.length} matching trials{rows.length > 0 ? ` · page ${page + 1} of ${pages}` : ''}
        </p>
        {rows.slice(page * 10, (page + 1) * 10).map((t) => (
          <details className="benchmark-trial" key={t.order}>
            <summary>
              <span>
                <strong>{t.caseId}</strong>
                <small>
                  {methodNames[t.method]} · repetition {t.repetition + 1} · {ms(t.timing.totalMs)}
                </small>
              </span>
              <RunStatus status={t.outcome} />
            </summary>
            <dl className="benchmark-provenance">
              <div>
                <dt>Family</dt>
                <dd>{t.family}</dd>
              </div>
              <div>
                <dt>Required review</dt>
                <dd>{ids(t.requiredReviewIds)}</dd>
              </div>
              <div>
                <dt>Selected review</dt>
                <dd>{ids(t.selectedReviewIds)}</dd>
              </div>
              <div>
                <dt>Affected findings</dt>
                <dd>{ids(t.affectedClaimIds)}</dd>
              </div>
              <div>
                <dt>Warm preparation (outside total)</dt>
                <dd>{ms(t.timing.warmupMs)}</dd>
              </div>
            </dl>
            {t.errors.length > 0 && (
              <ul className="benchmark-error-text">
                {t.errors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            )}
            <details className="benchmark-raw">
              <summary>Raw trial record</summary>
              <pre>{JSON.stringify(t, null, 2)}</pre>
            </details>
          </details>
        ))}
        {rows.length === 0 && <p className="empty-state">No trials match these filters.</p>}
        {pages > 1 && (
          <div className="benchmark-pagination">
            <button
              className="button secondary"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              Previous trials
            </button>
            <button
              className="button secondary"
              disabled={page + 1 >= pages}
              onClick={() => setPage(page + 1)}
            >
              Next trials
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function Run({ detail }: { detail: BenchmarkDetail }) {
  const r = detail.result;
  const failedTrials = r?.trials.filter((t) => t.outcome === 'failed') ?? [];
  const failedChecks = r?.rejections.filter((t) => !t.passed) ?? [];
  return (
    <>
      <div className="benchmark-run-heading">
        <span className="mono">{detail.id}</span>
        <RunStatus status={detail.status} />
        <span>{date(detail.recordedAt)} UTC</span>
      </div>
      {detail.issue && (
        <div className="benchmark-warning" role="alert">
          <TriangleAlert size={18} />
          <p>{detail.issue}</p>
        </div>
      )}
      {r && (
        <>
          <div className="benchmark-stats">
            <div>
              <span>Structural cases</span>
              <strong>{r.caseCount}</strong>
              <small>{r.repetitions} repetitions per policy</small>
            </div>
            <div>
              <span>Completed trials</span>
              <strong>{r.trials.length}</strong>
              <small>{r.projection === 'cold' ? 'Cold' : 'Warm'} graph projections</small>
            </div>
            <div>
              <span>Failed trials / checks</span>
              <strong>
                {failedTrials.length} / {failedChecks.length}
              </strong>
              <small>{r.malformedCaseCount} malformed-graph checks</small>
            </div>
            <div>
              <span>Model calls</span>
              <strong>0</strong>
              <small>Tokens and savings: N/A</small>
            </div>
          </div>
          {(failedTrials.length > 0 || failedChecks.length > 0) && (
            <div className="benchmark-warning" role="alert">
              <TriangleAlert size={18} />
              <div>
                <strong>This run did not pass.</strong>
                <p>
                  {failedTrials.length} failed trials and {failedChecks.length} failed rejection
                  checks remain included in the results below.
                </p>
                <ul>
                  {failedTrials.slice(0, 5).map((t) => (
                    <li key={t.order}>
                      {t.caseId} · {methodNames[t.method]}: {t.errors.join('; ')}
                    </li>
                  ))}
                  {failedChecks.slice(0, 5).map((t) => (
                    <li key={t.caseId}>
                      {t.caseId}: expected “{t.expectedError}”; received{' '}
                      {t.actualError ?? 'no rejection'}.
                    </li>
                  ))}
                </ul>
                {failedTrials.length > 5 && (
                  <p>Use the Failed outcome filter to inspect every failed trial.</p>
                )}
              </div>
            </div>
          )}
          <Comparison result={r} />
          <div className="benchmark-scope">
            <BarChart3 size={20} />
            <div>
              <strong>Selection work, with measured local timings.</strong>
              <p>
                Requested revisions measure which statements need rewriting. They do not measure
                generated tokens, API cost, or end-to-end agent speed.{' '}
                {r.projection === 'cold'
                  ? 'Cold totals include corrected graph projection.'
                  : 'Warm totals exclude graph preparation; each trial records that time separately.'}{' '}
                Initial report preparation is excluded in both modes. Live Gemini activity is
                recorded in the Activity tab.
              </p>
            </div>
          </div>
          <Trials key={detail.id} result={r} />
          <details className="panel benchmark-details">
            <summary>
              Malformed-graph checks ({r.rejections.filter((t) => t.passed).length} /{' '}
              {r.malformedCaseCount} passed)
            </summary>
            <div className="benchmark-details-body">
              {r.rejections.map((check) => (
                <article className="benchmark-check" key={check.caseId}>
                  <div>
                    <strong>{check.caseId}</strong>
                    <RunStatus status={check.passed ? 'passed' : 'failed'} />
                  </div>
                  <p>Expected: {check.expectedError}</p>
                  <p>Recorded: {check.actualError ?? 'No rejection'}</p>
                </article>
              ))}
            </div>
          </details>
        </>
      )}
      {detail.metadata && (
        <details className="panel benchmark-details">
          <summary>Run provenance and measurement scope</summary>
          <div className="benchmark-details-body">
            <dl className="benchmark-provenance">
              {r && (
                <>
                  <div>
                    <dt>Dataset SHA-256</dt>
                    <dd className="mono">{r.datasetChecksum}</dd>
                  </div>
                  <div>
                    <dt>Protocol / seed</dt>
                    <dd>
                      {r.version} / {r.seed}
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt>Started</dt>
                <dd>{date(detail.metadata.startedAt)} UTC</dd>
              </div>
              <div>
                <dt>Runtime</dt>
                <dd>
                  {detail.metadata.node} · {detail.metadata.platform} /{' '}
                  {detail.metadata.architecture}
                </dd>
              </div>
              <div>
                <dt>Machine</dt>
                <dd>
                  {detail.metadata.cpu ?? 'Not recorded'} · {detail.metadata.availableParallelism}{' '}
                  available threads
                </dd>
              </div>
              <div>
                <dt>Commit</dt>
                <dd>
                  {detail.metadata.commit ?? 'Unversioned workspace; source hashes recorded below'}
                </dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>{detail.metadata.scope}</dd>
              </div>
              <div>
                <dt>Timing</dt>
                <dd>{detail.metadata.timing}</dd>
              </div>
              <div>
                <dt>Workload</dt>
                <dd>{detail.metadata.workload}</dd>
              </div>
            </dl>
            <p className="benchmark-footnote">
              These are retained measurements, not a rerun of the current code. Source hashes
              identify the implementation used for this run.
            </p>
            <dl className="benchmark-provenance benchmark-source-hashes">
              {Object.entries(detail.metadata.sources).map(([path, hash]) => (
                <div key={path}>
                  <dt>{path}</dt>
                  <dd className="mono">{hash}</dd>
                </div>
              ))}
            </dl>
          </div>
        </details>
      )}
      <section className="panel benchmark-downloads" aria-label="Raw benchmark artifacts">
        <div>
          <h3>Raw artifacts</h3>
          <p>Download the saved inputs, measurements, and provenance.</p>
        </div>
        <div>
          {detail.artifacts.map((name) => (
            <a
              className="button secondary"
              key={name}
              href={`/api/benchmarks/${encodeURIComponent(detail.id)}/artifacts/${name}`}
              download
            >
              <Download size={14} />
              {name}
            </a>
          ))}
          {detail.artifacts.length === 0 && <p>No readable artifacts available.</p>}
        </div>
      </section>
    </>
  );
}

export default function Benchmarks() {
  const [index, setIndex] = useState<BenchmarkIndex | null>(null);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<BenchmarkDetail | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setListError(null);
    void request<BenchmarkIndex>('/benchmarks')
      .then((next) => {
        if (cancelled) return;
        setIndex(next);
        setSelected((old) =>
          next.runs.some((r) => r.id === old) ? old : (next.runs[0]?.id ?? ''),
        );
      })
      .catch((e: Error) => {
        if (!cancelled) setListError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    if (selected)
      void request<BenchmarkDetail>(`/benchmarks/${encodeURIComponent(selected)}`)
        .then((next) => {
          if (!cancelled) setDetail(next);
        })
        .catch((e: Error) => {
          if (!cancelled) setDetailError(e.message);
        });
    return () => {
      cancelled = true;
    };
  }, [selected, reload]);
  return (
    <section className="benchmark-view" aria-label="Saved benchmarks">
      <div className="benchmark-heading">
        <div>
          <span className="small-badge">DETERMINISTIC EVALUATION</span>
          <h2>Measure what the repair changes.</h2>
          <p>
            Compare correctness, revision selection, and local latency from saved runs. Viewing
            these results makes no model requests.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={loading}
          onClick={() => setReload(reload + 1)}
        >
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          Refresh runs
        </button>
      </div>
      {(listError || detailError) && (
        <div className="benchmark-warning" role="alert">
          <TriangleAlert size={18} />
          <p>{listError ?? detailError}</p>
          <button className="text-button" onClick={() => setReload(reload + 1)}>
            Retry benchmarks
          </button>
        </div>
      )}
      {loading && !index && (
        <p className="empty-state" role="status">
          Reading saved benchmarks…
        </p>
      )}
      {!loading && !listError && index?.runs.length === 0 && (
        <div className="panel empty-state benchmark-empty">
          <BarChart3 size={28} />
          <h3>No saved benchmarks yet.</h3>
          <p>Run the deterministic suite from the project directory, then refresh this view.</p>
          <code>npm run benchmark</code>
          <p>
            For warm projections: <code>npm run benchmark -- --projection=warm</code>. Both commands
            use zero model calls.
          </p>
        </div>
      )}
      {index && index.runs.length > 0 && (
        <>
          <div className="panel benchmark-run-picker">
            <label>
              Saved run
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {index.runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id} · {r.projection ?? 'no results'} · {r.status} · {date(r.recordedAt)} UTC
                  </option>
                ))}
              </select>
            </label>
            <p>
              One run at a time. Cold and warm measurements and different datasets are kept
              separate.
            </p>
            {index.omitted > 0 && (
              <p>
                {index.omitted} older directories omitted; showing the 100 most recently modified.
              </p>
            )}
          </div>
          {detail?.id === selected ? (
            <Run key={`${selected}-${reload}`} detail={detail} />
          ) : (
            !detailError && (
              <p className="empty-state" role="status">
                Reading run artifacts…
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
