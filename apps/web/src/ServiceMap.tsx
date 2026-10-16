import { useEffect, useMemo, useState } from 'react';
import { Background, Controls, MarkerType, ReactFlow } from '@xyflow/react';
import type { Incident, ServiceImpact } from '@aftermath/contracts';
import { request } from './api';

export default function ServiceMap({ incident }: { incident: Incident }) {
  const [selected, setSelected] = useState(
    () =>
      incident.topology?.services.find((s) => s.id === 'database')?.id ??
      incident.topology?.services[0]?.id ??
      '',
  );
  const [impact, setImpact] = useState<ServiceImpact | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setImpact(null);
    setError(null);
    void request<{ result: ServiceImpact }>(
      `/incidents/${incident.id}/service-impact/${encodeURIComponent(selected)}`,
      undefined,
      controller.signal,
    )
      .then(({ result }) => {
        if (result.projectedSeq !== incident.eventSeq)
          throw new Error(
            'Incident changed during service analysis. Refreshing the investigation will retry.',
          );
        if (!cancelled) setImpact(result);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [incident.id, incident.eventSeq, selected, retry]);
  const { nodes, edges } = useMemo(() => {
    const slots = new Map<number, number>();
    const affected = new Set(impact?.paths.map((p) => p.serviceId) ?? []);
    return {
      nodes: (impact?.topology.services ?? []).map((s) => {
        const slot = slots.get(s.tier) ?? 0;
        slots.set(s.tier, slot + 1);
        return {
          id: s.id,
          data: { label: s.name },
          position: { x: s.tier * 190, y: slot * 75 },
          style: {
            borderColor: s.id === selected ? '#a45f37' : affected.has(s.id) ? '#c98764' : '#b7c5b8',
            background: s.id === selected ? '#f8e4d5' : '#fff',
            fontSize: 12,
          },
        };
      }),
      edges: (impact?.topology.dependencies ?? []).map((d) => ({
        id: `${d.caller}:${d.dependency}`,
        source: d.caller,
        target: d.dependency,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#a2b19f' },
      })),
    };
  }, [selected, impact]);
  return (
    <section className="panel service-map">
      <div className="panel-heading">
        <h2>Service dependency analysis</h2>
        <span className="small-badge">
          {nodes.length} services · {edges.length} dependencies
        </span>
      </div>
      <p>
        Choose a dependency to inspect the services that can reach it. Shared dependencies show
        potential exposure; healthy branches remain visible.
      </p>
      <label>
        Dependency{' '}
        <select
          aria-label="Dependency to inspect"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {incident.topology?.services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="service-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, node) => setSelected(node.id)}
          aria-label="Service dependency graph"
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {error ? (
        <p role="alert">
          Service analysis unavailable: {error}{' '}
          <button className="text-button" onClick={() => setRetry((n) => n + 1)}>
            Retry service analysis
          </button>
        </p>
      ) : !impact ? (
        <p>Querying dependency paths…</p>
      ) : (
        <div className="service-analysis">
          <div>
            <h3>{impact.paths.length} upstream services</h3>
            <p>Shortest paths to {selected}, computed in FalkorDB.</p>
            <details>
              <summary>Inspect paths</summary>
              <ul>
                {impact.paths.map((p) => (
                  <li key={p.serviceId}>
                    {p.path.join(' → ')} ({p.hops} hops)
                  </li>
                ))}
              </ul>
            </details>
          </div>
          <div>
            <h3>Dependency PageRank</h3>
            <p>Incoming dependency importance; not failure probability.</p>
            <ol>
              {impact.centrality.slice(0, 5).map((r) => (
                <li key={r.serviceId}>
                  {r.serviceId} <span>{r.score.toFixed(4)}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  );
}
