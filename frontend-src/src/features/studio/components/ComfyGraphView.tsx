import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Link2, Lock } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface GraphInput { name: string; type: string; is_link: boolean; value: string | number | boolean | null }
export interface GraphNode {
  id: string;
  title: string;
  class_type: string;
  position: { x: number; y: number };
  inputs: GraphInput[];
}
export interface GraphEdge { id: string; source: string; target: string; target_input: string }
export interface ComfyGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/** Which field currently claims this input, if any. */
type Bindings = Record<string, { node: string; input: string }>;

const FIELD_LABELS: Record<string, string> = {
  positive: "正向提示词", negative: "负向提示词", seed: "种子", width: "宽度",
  height: "高度", cfg: "CFG", sampler: "采样器", scheduler: "调度器", steps: "步数",
};

function NodeCard({ data }: NodeProps) {
  const node = data.node as GraphNode;
  const boundFields = (data.boundFields as string[]) || [];
  return (
    <div className="comfy-node" data-bound={boundFields.length > 0 ? true : undefined}>
      <Handle type="target" position={Position.Left} />
      <div className="comfy-node-head">
        <span className="comfy-node-title">{node.title}</span>
        <span className="comfy-node-class">{node.class_type}</span>
      </div>
      <div className="comfy-node-body">
        {node.inputs.slice(0, 6).map((input) => (
          <div key={input.name} className="comfy-node-input" data-link={input.is_link || undefined}>
            {input.is_link ? <Link2 size={9}/> : <span className="comfy-node-dot"/>}
            <span>{input.name}</span>
            {!input.is_link && <em>{String(input.value ?? "").slice(0, 18)}</em>}
          </div>
        ))}
        {node.inputs.length > 6 && <div className="comfy-node-more">+{node.inputs.length - 6}</div>}
      </div>
      {boundFields.length > 0 && <div className="comfy-node-bound">
        {boundFields.map((field) => <span key={field}>{FIELD_LABELS[field] || field}</span>)}
      </div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function ComfyGraphView({ graph, bindings, onBind, onLayout }: {
  graph: ComfyGraph;
  bindings: Bindings;
  onBind: (field: string, binding: { node: string; input: string } | null) => void;
  onLayout: (positions: Record<string, { x: number; y: number }>) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const flow = useRef<{ fitView: (opts?: { padding?: number }) => void } | null>(null);

  useEffect(() => {
    const next: Record<string, { x: number; y: number }> = {};
    for (const node of graph.nodes) next[node.id] = node.position;
    setPositions(next);
    // The canvas is measured after mount, so the initial fitView runs too early.
    const timer = window.setTimeout(() => flow.current?.fitView({ padding: 0.15 }), 120);
    return () => window.clearTimeout(timer);
  }, [graph]);

  const boundByNode = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const [field, binding] of Object.entries(bindings)) {
      if (!binding?.node) continue;
      (map[binding.node] ||= []).push(field);
    }
    return map;
  }, [bindings]);

  const flowNodes = useMemo<Node[]>(() => graph.nodes.map((node) => ({
    id: node.id,
    type: "comfy",
    position: positions[node.id] || node.position,
    data: { node, boundFields: boundByNode[node.id] || [] },
    selected: selected === node.id,
  })), [graph.nodes, positions, boundByNode, selected]);

  const flowEdges = useMemo<Edge[]>(() => graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    animated: false,
    style: { stroke: "var(--line-2)" },
  })), [graph.edges]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    setPositions((prev) => {
      const next = { ...prev, [node.id]: { x: Math.round(node.position.x), y: Math.round(node.position.y) } };
      onLayout(next);
      return next;
    });
  }, [onLayout]);

  const node = graph.nodes.find((n) => n.id === selected) || null;
  const fieldFor = (nodeId: string, inputName: string) =>
    Object.entries(bindings).find(([, b]) => b.node === nodeId && b.input === inputName)?.[0] || "";

  return (
    <div className="comfy-graph">
      <div className="comfy-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={{ comfy: NodeCard }}
          onNodeClick={(_, n) => setSelected(n.id)}
          onNodeDragStop={onNodeDragStop}
          onPaneClick={() => setSelected(null)}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          onInit={(instance) => { flow.current = instance }}
          minZoom={0.2}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={16} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <aside className="comfy-inspector" data-empty={!node || undefined}>
        {!node && <p className="hint">点击左侧节点查看它的输入，并把某个输入绑定为通配符。</p>}
        {node && <>
          <div className="comfy-inspector-head">
            <strong>{node.title}</strong>
            <span className="hint">{node.class_type} · #{node.id}</span>
          </div>
          <div className="comfy-inspector-body">
            {node.inputs.map((input) => {
              const claimed = fieldFor(node.id, input.name);
              return <div key={input.name} className="comfy-inspector-row" data-link={input.is_link || undefined}>
                <div className="comfy-inspector-name">
                  {input.is_link && <Lock size={10}/>}
                  <span>{input.name}</span>
                  <em>{input.type}</em>
                </div>
                {!input.is_link && <div className="comfy-inspector-value" title={String(input.value ?? "")}>{String(input.value ?? "—").slice(0, 60)}</div>}
                {input.is_link
                  ? <span className="hint">连线输入，不能填值</span>
                  : <select aria-label={`${input.name} 绑定`} value={claimed} onChange={(e) => {
                    const field = e.target.value;
                    // one input can serve one field, and one field one input
                    if (claimed) onBind(claimed, null);
                    if (field) onBind(field, { node: node.id, input: input.name });
                  }}>
                    <option value="">不绑定</option>
                    {Object.entries(FIELD_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>}
              </div>;
            })}
          </div>
        </>}
      </aside>
    </div>
  );
}
