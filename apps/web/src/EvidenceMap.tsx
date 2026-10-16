import { memo, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { FileText, GitBranch, ShieldCheck } from 'lucide-react';
import type { GraphView, Incident } from '@aftermath/contracts';

type ArtifactNode = Node<{
  title: string;
  shortId: string;
  kind: string;
  status: string;
  preserved: boolean;
  selected: boolean;
}>;
const Artifact = memo(function Artifact({ data }: NodeProps<ArtifactNode>) {
  const Icon = data.kind === 'evidence' ? FileText : data.preserved ? ShieldCheck : GitBranch;
  return (
    <div className={`artifact-node ${data.status} ${data.selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Right} />
      <div className="node-top">
        <Icon size={12} />
        <span>{data.shortId}</span>
        <span className="node-kind">{data.kind === 'evidence' ? 'SOURCE' : 'FINDING'}</span>
      </div>
      <strong>{data.title}</strong>
      <span className={`node-status ${data.status}`}>
        <i />
        {data.preserved ? 'Preserved' : data.status.replaceAll('_', ' ')}
      </span>
      <Handle type="source" position={Position.Left} />
    </div>
  );
});
const nodeTypes = { artifact: Artifact };
export default function EvidenceMap({
  graph,
  incident,
  selectedId,
  onSelect,
}: {
  graph: GraphView;
  incident: Incident;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { nodes, edges } = useMemo(() => {
    const sources = graph.nodes.filter((n) => n.kind === 'evidence');
    const claims = graph.nodes.filter((n) => n.kind === 'claim');
    // Dependency arrows point from claims to their premises (right toward left).
    const positions: Record<string, { x: number; y: number }> = {};
    const depths = new Map<string, number>();
    const depth = (id: string): number => {
      if (depths.has(id)) return depths.get(id)!;
      const premises = graph.edges.filter((e) => e.source === id);
      const value = premises.length ? 1 + Math.max(...premises.map((e) => depth(e.target))) : 0;
      depths.set(id, value);
      return value;
    };
    const slots = new Map<number, number>();
    [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .forEach((n) => {
        const column = depth(n.id);
        const slot = slots.get(column) ?? 0;
        slots.set(column, slot + 1);
        positions[n.id] = { x: column * 245, y: slot * 108 };
      });
    const affected = new Set(incident.lastImpact?.affectedClaimIds ?? []);
    const nodeList: ArtifactNode[] = [...sources, ...claims].map((n) => ({
      id: n.id,
      type: 'artifact',
      position: positions[n.id],
      data: {
        title: n.title,
        shortId: n.id.split('-')[0],
        kind: n.kind,
        status: n.status,
        preserved: incident.lastImpact?.preservedClaimIds.includes(n.id) ?? false,
        selected: n.id === selectedId,
      },
    }));
    return {
      nodes: nodeList,
      edges: graph.edges.map((e) => ({
        ...e,
        type: 'smoothstep',
        sourceHandle: null,
        targetHandle: null,
        style: {
          stroke: affected.has(e.source)
            ? incident.lastImpact?.preservedClaimIds.includes(e.source)
              ? '#558065'
              : '#c98764'
            : '#b7c5b8',
          strokeWidth: affected.has(e.source) ? 2.3 : 1.5,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#a2b19f', width: 16, height: 16 },
      })),
    };
  }, [graph, incident.lastImpact, selectedId]);
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.12}
      maxZoom={1.5}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      onNodeClick={(_event, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: false }}
      aria-label="Evidence dependency graph"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d5dcd2" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}
