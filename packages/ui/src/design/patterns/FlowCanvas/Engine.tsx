import { createContext, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer,
  Handle, Position, MarkerType, MiniMap, Panel, getSmoothStepPath,
  useNodesInitialized, useReactFlow, useStore,
  type Node, type NodeProps, type Edge, type EdgeProps, type NodeChange, type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { CanvasSelectIcon, CanvasHandIcon, CanvasFitIcon, ZoomInIcon, ZoomOutIcon } from '../../../components/Icons'
import { Button } from '../../ui/button'
import { Chip } from '../Settings'
import { StepCard } from './StepCard'
import type { FlowCanvasStep, FlowCanvasNodeProps, FlowCanvasProps, FlowCanvasNodeChange, FlowCanvasEdgeChange } from './types'
import styles from './FlowCanvas.module.css'

// Geometry required by the graph engine, not a second auto layout or palette.
const GRID = 16
const CORNER = 16
const DEFAULT_WIDTH = 232
const MIN_ZOOM = 0.05
const RenderContext = createContext<(props: FlowCanvasNodeProps) => React.ReactNode>(props => <StepCard {...props} />)
type EngineNode = Node<{ presentation: FlowCanvasNodeProps['node']; readOnly: boolean }, 'step'>
type EngineEdge = Edge<{ kind?: 'rule' | 'attachment' }, 'rule'>

const Step = ({ data, selected }: NodeProps<EngineNode>) => {
  const render = useContext(RenderContext)
  return <div className={styles.node} data-readonly={data.readOnly}>
    <Handle type="target" position={Position.Left} isConnectable={!data.readOnly} />
    {render({ node: data.presentation, selected: Boolean(selected), readOnly: data.readOnly })}
    <Handle type="source" position={Position.Right} isConnectable={!data.readOnly} />
  </div>
}
const Rule = (props: EdgeProps<EngineEdge>) => {
  // Opposite rules on one row need separate rails so both words remain readable.
  const returnRail = props.sourceX >= props.targetX && Math.abs(props.sourceY - props.targetY) < GRID
    ? { centerY: Math.max(props.sourceY, props.targetY) + GRID * 4 } : {}
  const [path, x, y] = getSmoothStepPath({ ...props, ...returnRail, borderRadius: CORNER, offset: GRID })
  return <>
    <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} className={styles.edge} style={props.style} />
    {props.label && <EdgeLabelRenderer><div className={`${styles.word} nodrag nopan`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}><Chip tone="neutral">{props.label}</Chip></div></EdgeLabelRenderer>}
  </>
}
const nodeTypes = { step: Step }
const edgeTypes = { rule: Rule }

const Canvas = <Data extends FlowCanvasStep>({ nodes, edges, readOnly = false, label = 'Flow plan', className, NodeComponent, onNodesChange, onEdgesChange, onConnect, onSelectionChange }: FlowCanvasProps<Data>) => {
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map())
  const [tool, setTool] = useState<'select' | 'hand'>('select')
  const flow = useReactFlow<EngineNode, EngineEdge>()
  const initialized = useNodesInitialized()
  const width = useStore(store => store.width), height = useStore(store => store.height)
  const centred = useRef(false)
  useEffect(() => {
    if (centred.current || !initialized || !width || !height) return
    const bounds = flow.getNodesBounds(flow.getNodes())
    void flow.setViewport({ x: (width - bounds.width) / 2 - bounds.x, y: (height - bounds.height) / 2 - bounds.y, zoom: 1 })
    centred.current = true
  }, [initialized, width, height, flow])

  const engineNodes = useMemo<EngineNode[]>(() => nodes.map(node => ({
    id: node.id, type: 'step', position: node.position, selected: node.selected,
    data: { presentation: node, readOnly },
    initialWidth: node.size?.width ?? DEFAULT_WIDTH, initialHeight: node.size?.height,
    measured: measurements.get(node.id),
    style: { width: node.size?.width ?? DEFAULT_WIDTH, ...(node.size?.height ? { height: node.size.height } : {}) },
    draggable: !readOnly && tool === 'select', connectable: !readOnly && tool === 'select',
    deletable: !readOnly, ariaLabel: node.data.name,
  })), [nodes, readOnly, tool, measurements])
  const engineEdges = useMemo<EngineEdge[]>(() => edges.map(edge => ({
    ...edge, type: 'rule', data: { kind: edge.kind }, deletable: !readOnly,
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--hd-border-strong)' },
    style: edge.kind === 'attachment' ? { strokeDasharray: '6 4' } : undefined,
    ariaLabel: edge.label ?? `${edge.source} to ${edge.target}`,
  })), [edges, readOnly])

  const changeNodes = (changes: NodeChange<EngineNode>[]) => {
    // Measurements belong to the interaction engine, not the saved document.
    const dimensions = changes.filter(change => change.type === 'dimensions' && change.dimensions)
    if (dimensions.length) setMeasurements(previous => {
      const next = new Map(previous)
      let changed = false
      for (const change of dimensions) {
        if (change.type !== 'dimensions' || !change.dimensions) continue
        const old = previous.get(change.id)
        if (old?.width === change.dimensions.width && old.height === change.dimensions.height) continue
        next.set(change.id, change.dimensions); changed = true
      }
      return changed ? next : previous
    })
    const exposed: FlowCanvasNodeChange[] = changes.flatMap<FlowCanvasNodeChange>(change => {
      if (change.type === 'select') return [change]
      if (!readOnly && change.type === 'position' && change.position) return [{ type: 'position', id: change.id, position: change.position }]
      if (!readOnly && change.type === 'remove') return [change]
      return []
    })
    if (exposed.length) onNodesChange?.(exposed)
  }
  const changeEdges = (changes: EdgeChange<EngineEdge>[]) => {
    const exposed = changes.filter((change): change is FlowCanvasEdgeChange => change.type === 'select' || !readOnly && change.type === 'remove')
    if (exposed.length) onEdgesChange?.(exposed)
  }
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, select, button, [contenteditable="true"], [role="textbox"]')) return
    const directions: Record<string, [number, number]> = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] }
    const direction = directions[event.key]
    if (!direction && event.key !== 'Delete' && event.key !== 'Backspace') return
    event.preventDefault(); event.stopPropagation()
    if (readOnly) return
    const selected = nodes.filter(node => node.selected)
    if (direction) {
      if (selected.length) onNodesChange?.(selected.map(node => ({ type: 'position', id: node.id, position: { x: node.position.x + direction[0], y: node.position.y + direction[1] } })))
    } else {
      if (selected.length) onNodesChange?.(selected.map(node => ({ type: 'remove', id: node.id })))
      const removed = new Set(selected.map(node => node.id))
      const incident = edges.filter(edge => edge.selected || removed.has(edge.source) || removed.has(edge.target))
      if (incident.length) onEdgesChange?.(incident.map(edge => ({ type: 'remove', id: edge.id })))
    }
  }
  const render = (props: FlowCanvasNodeProps) => NodeComponent
    ? <NodeComponent {...props as FlowCanvasNodeProps<Data>} /> : <StepCard {...props} />
  return <div className={`${styles.canvas} ${className ?? ''}`} data-slot="flow-canvas" data-readonly={readOnly} data-tool={readOnly ? 'hand' : tool} tabIndex={0} role="region" aria-label={label} onKeyDownCapture={keyboard}>
    <RenderContext.Provider value={render}>
      <ReactFlow<EngineNode, EngineEdge> nodes={engineNodes} edges={engineEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={changeNodes} onEdgesChange={changeEdges} onConnect={connection => { if (!readOnly) onConnect?.({ source: connection.source, target: connection.target }) }}
        onSelectionChange={selection => onSelectionChange?.({ nodes: selection.nodes.map(node => node.id), edges: selection.edges.map(edge => edge.id) })}
        nodesDraggable={!readOnly && tool === 'select'} nodesConnectable={!readOnly && tool === 'select'} nodesFocusable edgesFocusable
        edgesReconnectable={false} deleteKeyCode={null} panOnDrag={readOnly || tool === 'hand' ? true : [1, 2]} selectionOnDrag={!readOnly && tool === 'select'}
        minZoom={MIN_ZOOM} maxZoom={2} defaultViewport={{ x: 0, y: 0, zoom: 1 }} zoomOnDoubleClick={false}
        ariaLabelConfig={{ 'node.a11yDescription.default': readOnly ? 'Press Enter to select this step.' : 'Press Enter to select this step. Arrow keys move selected steps. Delete removes the selection.' }}>
        <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} color="var(--hd-border)" />
        <Panel position="bottom-left" className={styles.tools}>
          {!readOnly && <>
            <Button variant="ghost" size="icon" aria-label="Select tool" title="Select steps" aria-pressed={tool === 'select'} onClick={() => setTool('select')}><CanvasSelectIcon /></Button>
            <Button variant="ghost" size="icon" aria-label="Hand tool" title="Pan the canvas" aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}><CanvasHandIcon /></Button>
          </>}
          <Button variant="ghost" size="icon" aria-label="Zoom out" title="Zoom out" onClick={() => void flow.zoomOut()}><ZoomOutIcon /></Button>
          <Button variant="ghost" size="icon" aria-label="Zoom in" title="Zoom in" onClick={() => void flow.zoomIn()}><ZoomInIcon /></Button>
          <Button variant="ghost" size="icon" aria-label="Fit plan" title="Fit to the canvas" onClick={() => void flow.fitView({ minZoom: MIN_ZOOM, maxZoom: Math.min(1, flow.getZoom()), padding: 0.12 })}><CanvasFitIcon /></Button>
        </Panel>
        <MiniMap position="bottom-right" nodeColor="var(--hd-muted)" nodeStrokeColor="var(--hd-border)" maskColor="var(--hd-accent-dim)" maskStrokeColor="var(--hd-accent)" nodeBorderRadius={4} />
      </ReactFlow>
    </RenderContext.Provider>
  </div>
}
export default function Engine<Data extends FlowCanvasStep>(props: FlowCanvasProps<Data>) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}
