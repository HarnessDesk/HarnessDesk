import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer,
  Handle, Position, MarkerType, MiniMap, Panel, getSmoothStepPath, getViewportForBounds,
  useNodesInitialized, useReactFlow, useStore,
  type Node, type NodeProps, type Edge, type EdgeProps, type NodeChange, type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { CanvasSelectIcon, CanvasHandIcon, CanvasFitIcon, ZoomInIcon, ZoomOutIcon, RetryIcon } from '../../../components/Icons'
import { Button } from '../../ui/button'
import { Text } from '../Settings'
import { FlowBaton, FlowRouteLabel } from '../../ui/flow-step'
import { StepCard } from './StepCard'
import { FLOW_CANVAS_CARD_WIDTH } from './geometry'
import { FLOW_GAP } from '../../../lib/flow-layout'
import type { FlowCanvasStep, FlowCanvasNodeProps, FlowCanvasProps, FlowCanvasNodeChange, FlowCanvasEdgeChange, FlowCanvasEdge } from './types'
import styles from './FlowCanvas.module.css'

// Geometry required by the graph engine, not a second auto layout or palette.
const GRID = 16
const CORNER = 16
const MIN_ZOOM = 0.05
const LANE_PITCH = GRID * 2
const BatonContext = createContext<(path: string) => void>(() => {})
const RenderContext = createContext<(props: FlowCanvasNodeProps) => React.ReactNode>(props => <StepCard {...props} />)
type EngineNode = Node<{ presentation: FlowCanvasNodeProps['node']; readOnly: boolean }, 'step'>
type EngineEdge = Edge<{ presentation: FlowCanvasEdge; railY?: number }, 'rule'>

const Step = ({ data, selected }: NodeProps<EngineNode>) => {
  const render = useContext(RenderContext)
  return <div className={styles.node} data-readonly={data.readOnly} onKeyDown={event => { if (event.target !== event.currentTarget) event.stopPropagation() }}>
    <Handle type="target" position={Position.Left} isConnectable={!data.readOnly} />
    {render({ node: data.presentation, selected: Boolean(selected), readOnly: data.readOnly })}
    <Handle type="source" position={Position.Right} isConnectable={!data.readOnly} />
  </div>
}
// The clearance model and the drawn route share these orthogonal segments.
const railPath = (sourceX: number, sourceY: number, targetX: number, targetY: number, railY: number): [string, number, number] => {
  const exitX = sourceX + GRID, entryX = targetX - GRID
  const points = [[sourceX, sourceY], [exitX, sourceY], [exitX, railY], [entryX, railY], [entryX, targetY], [targetX, targetY]] as const
  let path = `M ${sourceX},${sourceY}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const [ax, ay] = points[index - 1]!, [bx, by] = points[index]!, [cx, cy] = points[index + 1]!
    const before = Math.hypot(bx - ax, by - ay), after = Math.hypot(cx - bx, cy - by)
    if (!before || !after || (ax === bx && bx === cx) || (ay === by && by === cy)) {
      path += ` L ${bx},${by}`
      continue
    }
    const radius = Math.min(CORNER, before / 2, after / 2)
    path += ` L ${bx + (ax - bx) * radius / before},${by + (ay - by) * radius / before}`
    path += ` Q ${bx},${by} ${bx + (cx - bx) * radius / after},${by + (cy - by) * radius / after}`
  }
  return [path + ` L ${targetX},${targetY}`, (exitX + entryX) / 2, railY]
}
const Rule = (props: EdgeProps<EngineEdge>) => {
  const rail = props.data?.railY
  const [path, x, y] = rail === undefined
    ? getSmoothStepPath({ ...props, borderRadius: CORNER, offset: GRID })
    : railPath(props.sourceX, props.sourceY, props.targetX, props.targetY, rail)
  const edge = props.data?.presentation
  const reportBaton = useContext(BatonContext)
  useLayoutEffect(() => { if (edge?.current) reportBaton(path) }, [edge?.current, path, reportBaton])
  return <>
    <g data-slot="flow-edge" data-edge={props.id} data-kind={edge?.loop ? 'loop' : 'forward'} data-state={edge?.state} data-flow-source={props.source} data-flow-target={props.target} data-flow-rail-y={rail ?? ''}>
      <BaseEdge path={path} markerEnd={props.markerEnd} className={`${styles.edge} ${edge?.state === 'travelled' ? styles.travelled : edge?.state === 'future' ? styles.future : ''}`} style={props.style} />
    </g>
    {props.label && <EdgeLabelRenderer><div data-slot="flow-word" data-retry={edge?.loop || undefined} data-flow-edge-id={props.id} className={`${styles.word} nodrag nopan`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}><FlowRouteLabel travelled={edge?.state === 'travelled'}>{edge?.loop && <RetryIcon size={11} />}{props.label}</FlowRouteLabel></div></EdgeLabelRenderer>}
  </>
}
const nodeTypes = { step: Step }
const edgeTypes = { rule: Rule }

const Canvas = <Data extends FlowCanvasStep>({ nodes, edges, readOnly = false, positionOnly = false, title, actions, label = 'Flow plan', className, NodeComponent, onNodesChange, onEdgesChange, onConnect, onSelectionChange }: FlowCanvasProps<Data>) => {
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map())
  const [tool, setTool] = useState<'select' | 'hand'>('select')
  const [announcement, setAnnouncement] = useState('')
  const [batonPath, setBatonPath] = useState('')
  const flow = useReactFlow<EngineNode, EngineEdge>()
  const initialized = useNodesInitialized()
  const width = useStore(store => store.width), height = useStore(store => store.height)
  const transform = useStore(store => store.transform)
  const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, '')
  const canvasRef = useRef<HTMLDivElement>(null)
  const selectionCallback = useRef(onSelectionChange)
  selectionCallback.current = onSelectionChange
  const controlledSelection = useRef({ nodes: [] as string[], edges: [] as string[] })
  controlledSelection.current = { nodes: nodes.filter(node => node.selected).map(node => node.id), edges: edges.filter(edge => edge.selected).map(edge => edge.id) }
  const selectionReady = useRef(false)
  const pendingFocus = useRef<{ targetId: string | null; removedNodes: ReadonlySet<string>; removedEdges: ReadonlySet<string> } | null>(null)
  const [, requestFocusCommit] = useState(0)
  const nodeIdSignature = nodes.map(node => node.id).sort().join('\u0000')
  const centredIds = useRef<ReadonlySet<string> | null>(null)
  const centredWidth = useRef(0)
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    pendingFocus.current = null
    if (!pending || nodes.some(node => pending.removedNodes.has(node.id)) || edges.some(edge => pending.removedEdges.has(edge.id))) return
    const target = pending.targetId === null ? undefined : [...(canvasRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
      .find(element => element.dataset.id === pending.targetId)
    ;(target ?? canvasRef.current)?.focus()
  })

  const engineNodes = useMemo<EngineNode[]>(() => nodes.map(node => ({
    id: node.id, type: 'step', position: node.position, selected: node.selected,
    data: { presentation: node, readOnly: readOnly || positionOnly },
    initialWidth: node.size?.width ?? FLOW_CANVAS_CARD_WIDTH, initialHeight: node.size?.height,
    measured: measurements.get(node.id),
    style: { width: node.size?.width ?? FLOW_CANVAS_CARD_WIDTH, ...(node.size?.height ? { height: node.size.height } : {}) },
    draggable: !readOnly && tool === 'select', connectable: !readOnly && !positionOnly && tool === 'select',
    deletable: !readOnly && !positionOnly, ariaLabel: node.data.name,
  })), [nodes, readOnly, positionOnly, tool, measurements])
  const engineEdges = useMemo<EngineEdge[]>(() => {
    const byId = new Map(nodes.map(node => [node.id, node]))
    const outgoingCounts = new Map<string, number>()
    for (const edge of edges) {
      if (byId.has(edge.source)) outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) ?? 0) + 1)
    }
    const boxes = nodes.map(node => {
      const width = node.size?.width ?? FLOW_CANVAS_CARD_WIDTH
      const height = node.size?.height ?? measurements.get(node.id)?.height ?? 0
      return { node, left: node.position.x, right: node.position.x + width, top: node.position.y, bottom: node.position.y + height, centerY: node.position.y + height / 2 }
    })
    const boxById = new Map(boxes.map(box => [box.node.id, box]))
    const bottom = Math.max(0, ...boxes.map(box => box.bottom))
    const railCandidates = new Set<number>([
      ...boxes.flatMap(box => [box.top - GRID, box.bottom + GRID]),
      bottom + GRID,
    ])
    for (const upper of boxes) for (const lower of boxes) {
      if (upper.bottom > lower.top) continue
      for (let y = upper.bottom + GRID; y <= lower.top - GRID; y += GRID) railCandidates.add(y)
    }
    const routeEdges = edges.map((edge, index) => {
      const source = byId.get(edge.source), target = byId.get(edge.target)
      const sourceBox = boxById.get(edge.source), targetBox = boxById.get(edge.target)
      const groupSize = outgoingCounts.get(edge.source) ?? 0
      const groupIndex = edges.slice(0, index).filter(previous => previous.source === edge.source).length
      let needsRail = false
      if (source && target && sourceBox && targetBox) {
        const gap = target.position.x - sourceBox.right
        const blocked = boxes.some(box => {
          if (box.node.id === source.id || box.node.id === target.id) return false
          const left = Math.min(sourceBox.right, targetBox.left), right = Math.max(sourceBox.right, targetBox.left)
          return right > left && box.left < right && box.right > left
            && box.top < sourceBox.centerY && box.bottom > sourceBox.centerY
        })
        needsRail = Math.abs(sourceBox.centerY - targetBox.centerY) >= GRID || gap <= FLOW_GAP || gap <= 0
          || blocked || (edge.label?.length ?? 0) > 8 || groupSize > 1
      }
      return { edge, index, source, target, sourceBox, targetBox, groupSize, groupIndex, needsRail, railY: undefined as number | undefined }
    })
    const routeIsClear = (route: typeof routeEdges[number], y: number) => {
      const { sourceBox, targetBox, source, target } = route
      if (!sourceBox || !targetBox || !source || !target) return false
      if ((y >= sourceBox.top && y <= sourceBox.bottom) || (y >= targetBox.top && y <= targetBox.bottom)) return false
      const sourceTurn = sourceBox.right + GRID, targetTurn = targetBox.left - GRID
      const left = Math.min(sourceTurn, targetTurn), right = Math.max(sourceTurn, targetTurn)
      return boxes.every(box => {
        if (box.node.id === source.id || box.node.id === target.id) return true
        const onRail = y >= box.top && y <= box.bottom && right > left && box.left < right && box.right > left
        const onSourceExit = sourceTurn >= box.left && sourceTurn <= box.right
          && Math.max(y, sourceBox.centerY) > box.top && Math.min(y, sourceBox.centerY) < box.bottom
        const onTargetEntry = targetTurn >= box.left && targetTurn <= box.right
          && Math.max(y, targetBox.centerY) > box.top && Math.min(y, targetBox.centerY) < box.bottom
        return !onRail && !onSourceExit && !onTargetEntry
      })
    }
    const preferredY = (route: typeof routeEdges[number]) => {
      const { sourceBox, targetBox } = route
      if (!sourceBox || !targetBox) return bottom + GRID
      if (Math.abs(sourceBox.centerY - targetBox.centerY) < GRID) return Math.max(sourceBox.bottom, targetBox.bottom) + GRID
      return (sourceBox.centerY + targetBox.centerY) / 2
    }
    const reservations: Array<{ y: number; left: number; right: number }> = []
    const fitsBesideExisting = (route: typeof routeEdges[number], y: number) => {
      if (!route.sourceBox || !route.targetBox) return false
      const left = Math.min(route.sourceBox.right + GRID, route.targetBox.left - GRID)
      const right = Math.max(route.sourceBox.right + GRID, route.targetBox.left - GRID)
      return !reservations.some(used => Math.abs(used.y - y) < LANE_PITCH && used.right > left && used.left < right)
    }
    const groups = new Map<string, typeof routeEdges>()
    for (const route of routeEdges) if (route.needsRail) {
      const list = groups.get(route.edge.source) ?? []
      list.push(route); groups.set(route.edge.source, list)
    }
    const groupBase = new Map<string, number>()
    for (const route of routeEdges) {
      if (!route.needsRail || !route.sourceBox || !route.targetBox) continue
      const group = groups.get(route.edge.source) ?? [route]
      let base = groupBase.get(route.edge.source)
      if (base === undefined) {
        const candidates = [...railCandidates].sort((a, b) => Math.abs(a - preferredY(route)) - Math.abs(b - preferredY(route)) || b - a)
        base = candidates.find(candidate => group.every(member => {
          const lane = candidate + member.groupIndex * LANE_PITCH
          return routeIsClear(member, lane) && fitsBesideExisting(member, lane)
        })) ?? bottom + GRID
        groupBase.set(route.edge.source, base)
      }
      route.railY = base + route.groupIndex * LANE_PITCH
      const left = Math.min(route.sourceBox.right + GRID, route.targetBox.left - GRID)
      const right = Math.max(route.sourceBox.right + GRID, route.targetBox.left - GRID)
      reservations.push({ y: route.railY, left, right })
    }
    return routeEdges.map(route => {
      const { edge, source, target } = route
      return {
        ...edge, type: 'rule', data: { presentation: edge, ...(route.railY === undefined ? {} : { railY: route.railY }) }, deletable: !readOnly && !positionOnly,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: edge.state === 'travelled' ? 'var(--hd-accent)' : 'var(--hd-muted-foreground)' },
        style: edge.kind === 'attachment' ? { strokeDasharray: '6 4' } : undefined,
        ariaLabel: `${source?.data.name ?? edge.source} to ${target?.data.name ?? edge.target}${edge.label ? `: ${edge.label}` : ''}`,
      }
    })
  }, [edges, nodes, readOnly, positionOnly, measurements])

  // Routed rules can sit outside the nodes' box, especially in the ordered editor's vertical plan.
  // Fit must keep their words visible, while a roomy first drawing still centres its nodes at 100%.
  const planBounds = useCallback(() => {
    const drawn = flow.getNodes(), bounds = flow.getNodesBounds(drawn)
    const byId = new Map(drawn.map(node => [node.id, node]))
    let left = bounds.x, top = bounds.y, right = bounds.x + bounds.width, bottom = bounds.y + bounds.height
    for (const edge of engineEdges) {
      const rail = edge.data?.railY, source = byId.get(edge.source), target = byId.get(edge.target)
      if (rail === undefined || !source || !target) continue
      const exit = source.position.x + (source.measured?.width ?? FLOW_CANVAS_CARD_WIDTH) + GRID
      const entry = target.position.x - GRID
      const wordWidth = edge.label ? String(edge.label).length * GRID / 2 + GRID * 2 : 0
      const wordX = (exit + entry) / 2
      left = Math.min(left, exit, entry, wordX - wordWidth / 2)
      right = Math.max(right, exit, entry, wordX + wordWidth / 2)
      top = Math.min(top, rail - (edge.label ? GRID : 0))
      bottom = Math.max(bottom, rail + (edge.label ? GRID : 0))
    }
    return { x: left, y: top, width: right - left, height: bottom - top }
  }, [flow, engineEdges])
  useEffect(() => {
    if (!initialized || !width || !height) return
    const previous = centredIds.current
    const replaced = !previous || !nodes.some(node => previous.has(node.id))
    const resized = centredWidth.current !== width
    centredIds.current = new Set(nodes.map(node => node.id))
    centredWidth.current = width
    if (!replaced && !resized) return
    const bounds = planBounds()
    const currentZoom = replaced ? 1 : Math.min(1, flow.getZoom())
    if (bounds.width * currentZoom > width || bounds.height * currentZoom > height) {
      void flow.setViewport(getViewportForBounds(bounds, width, height, MIN_ZOOM, currentZoom, 0.12))
    } else if (replaced) {
      const bounds = flow.getNodesBounds(flow.getNodes())
      void flow.setViewport({ x: (width - bounds.width) / 2 - bounds.x, y: (height - bounds.height) / 2 - bounds.y, zoom: 1 })
    }
  }, [initialized, width, height, flow, nodeIdSignature, planBounds])
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
      if (!readOnly && change.type === 'position' && change.position) return [{ type: 'position', id: change.id, position: change.position, dragging: Boolean(change.dragging) }]
      if (!readOnly && !positionOnly && change.type === 'remove') return [change]
      return []
    })
    if (exposed.length) onNodesChange?.(exposed)
  }
  const changeEdges = (changes: EdgeChange<EngineEdge>[]) => {
    const exposed = changes.filter((change): change is FlowCanvasEdgeChange => change.type === 'select' || !readOnly && !positionOnly && change.type === 'remove')
    if (exposed.length) onEdgesChange?.(exposed)
  }
  const selectionChanged = useCallback((selection: { nodes: EngineNode[]; edges: EngineEdge[] }) => {
    const next = { nodes: selection.nodes.map(node => node.id), edges: selection.edges.map(edge => edge.id) }
    if (!selectionReady.current) {
      const controlled = controlledSelection.current
      if (next.nodes.length !== controlled.nodes.length || next.edges.length !== controlled.edges.length
        || !controlled.nodes.every(id => next.nodes.includes(id)) || !controlled.edges.every(id => next.edges.includes(id))) return
      selectionReady.current = true
    }
    selectionCallback.current?.(next)
  }, [])
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target !== event.currentTarget && !target.matches('.react-flow__node, .react-flow__edge')) return
    if (event.metaKey || event.altKey || event.ctrlKey) {
      // Leave the browser shortcut intact without handing it to the engine's move handler.
      event.stopPropagation()
      return
    }
    const directions: Record<string, [number, number]> = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] }
    const direction = directions[event.key]
    if (!direction && event.key !== 'Delete' && event.key !== 'Backspace') return
    event.preventDefault(); event.stopPropagation()
    if (readOnly || tool === 'hand') return
    const selected = nodes.filter(node => node.selected)
    if (direction) {
      if (selected.length) {
        onNodesChange?.(selected.map(node => ({ type: 'position', id: node.id, position: { x: node.position.x + direction[0], y: node.position.y + direction[1] }, dragging: false })))
        const moved = selected[0]!
        setAnnouncement(`Moved ${moved.data.name} to x ${moved.position.x + direction[0]}, y ${moved.position.y + direction[1]}.`)
      }
    } else if (!positionOnly) {
      const removedIds = new Set(selected.map(node => node.id))
      const incident = edges.filter(edge => edge.selected || removedIds.has(edge.source) || removedIds.has(edge.target))
      const activeId = target.closest('.react-flow__node')?.getAttribute('data-id')
      const activeEdgeId = target.closest('.react-flow__edge')?.getAttribute('data-id')
      if (activeId && removedIds.has(activeId) && onNodesChange) {
        const activeIndex = nodes.findIndex(node => node.id === activeId)
        const next = nodes.slice(activeIndex + 1).find(node => !removedIds.has(node.id))
          ?? nodes.slice(0, activeIndex).reverse().find(node => !removedIds.has(node.id))
        pendingFocus.current = { removedNodes: removedIds, removedEdges: new Set(), targetId: next?.id ?? null }
        requestFocusCommit(value => value + 1)
      } else if (activeEdgeId && incident.some(edge => edge.id === activeEdgeId) && onEdgesChange) {
        pendingFocus.current = { removedNodes: new Set(), removedEdges: new Set(incident.map(edge => edge.id)), targetId: null }
        requestFocusCommit(value => value + 1)
      }
      if (selected.length) onNodesChange?.(selected.map(node => ({ type: 'remove', id: node.id })))
      if (incident.length) onEdgesChange?.(incident.map(edge => ({ type: 'remove', id: edge.id })))
    }
  }
  const ariaLabelConfig = useMemo(() => {
    const modeDescription = readOnly ? 'This plan is read-only.' : 'The Hand tool pans this plan.'
    const nodeDescription = readOnly || tool === 'hand'
      ? `Press Enter to select this step. ${modeDescription}`
      : positionOnly ? 'Press Enter to select this step. Arrow keys move selected steps.' : 'Press Enter to select this step. Arrow keys move selected steps. Press Delete or Backspace to remove the selection.'
    const edgeDescription = readOnly || tool === 'hand'
      ? `Press Enter or Space to select this rule. ${modeDescription}`
      : positionOnly ? 'Press Enter or Space to select this rule.' : 'Press Enter or Space to select this rule. Press Delete or Backspace to remove it.'
    return {
      'node.a11yDescription.default': nodeDescription,
      'node.a11yDescription.keyboardDisabled': nodeDescription,
      'edge.a11yDescription.default': edgeDescription,
    }
  }, [readOnly, positionOnly, tool])
  // The map yields its corner whenever it would cover a rendered card.
  const minimapClear = nodes.every(node => {
    const left = node.position.x * transform[2] + transform[0], top = node.position.y * transform[2] + transform[1]
    const right = left + (node.size?.width ?? FLOW_CANVAS_CARD_WIDTH) * transform[2]
    const bottom = top + (node.size?.height ?? measurements.get(node.id)?.height ?? 0) * transform[2]
    return right <= width - 215 || left >= width - 15 || bottom <= height - 165 || top >= height - 15
  })
  const render = (props: FlowCanvasNodeProps) => NodeComponent
    ? <NodeComponent {...props as FlowCanvasNodeProps<Data>} /> : <StepCard {...props} />
  return <div ref={canvasRef} className={`${styles.canvas} ${className ?? ''}`} data-slot="flow-canvas" data-readonly={readOnly} data-tool={readOnly ? 'hand' : tool} tabIndex={0} role="region" aria-label={label} onKeyDownCapture={keyboard}>
    <BatonContext.Provider value={setBatonPath}><RenderContext.Provider value={render}>
      <ReactFlow<EngineNode, EngineEdge> id={instanceId} nodes={engineNodes} edges={engineEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={changeNodes} onEdgesChange={changeEdges} onConnect={connection => { if (!readOnly && !positionOnly) onConnect?.({ source: connection.source, target: connection.target }) }}
        onSelectionChange={selectionChanged}
        nodesDraggable={!readOnly && tool === 'select'} nodesConnectable={!readOnly && !positionOnly && tool === 'select'} nodesFocusable edgesFocusable
        edgesReconnectable={false} deleteKeyCode={null} panOnDrag={readOnly || tool === 'hand' ? true : [1, 2]} selectionOnDrag={!readOnly && tool === 'select'}
        minZoom={MIN_ZOOM} maxZoom={2} defaultViewport={{ x: 0, y: 0, zoom: 1 }} zoomOnDoubleClick={false}
        zoomOnScroll={!readOnly} preventScrolling={!readOnly} ariaLabelConfig={ariaLabelConfig}>
        {edges.some(edge => edge.current) && batonPath && <EdgeLabelRenderer><FlowBaton path={batonPath} /></EdgeLabelRenderer>}
        <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.5} color="var(--hd-border-strong)" />
        {title && <Panel position="top-left"><Text role="meta">{title}</Text></Panel>}
        <Panel position={readOnly ? "top-right" : "bottom-left"} className={styles.tools}>
          {!readOnly && <>
            <Button variant="ghost" size="icon" aria-label="Select tool" title="Select steps" aria-pressed={tool === 'select'} onClick={() => setTool('select')}><CanvasSelectIcon /></Button>
            <Button variant="ghost" size="icon" aria-label="Hand tool" title="Pan the canvas" aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}><CanvasHandIcon /></Button>
          </>}
          <Button variant="ghost" size="icon" aria-label="Zoom out" title="Zoom out" onClick={() => void flow.zoomOut()}><ZoomOutIcon /></Button>
          <Button variant="ghost" size="icon" aria-label="Zoom in" title="Zoom in" onClick={() => void flow.zoomIn()}><ZoomInIcon /></Button>
          <Button variant="ghost" size="icon" aria-label="Fit plan" title="Fit to the canvas" onClick={() => void flow.setViewport(getViewportForBounds(planBounds(), width, height, MIN_ZOOM, Math.min(1, flow.getZoom()), 0.12))}><CanvasFitIcon /></Button>
          {actions}
        </Panel>
        {minimapClear && <MiniMap position="bottom-right" nodeColor="var(--hd-muted)" nodeStrokeColor="var(--hd-border)" maskColor="var(--hd-muted)" maskStrokeColor="var(--hd-border)" nodeBorderRadius={4} />}
      </ReactFlow>
    </RenderContext.Provider></BatonContext.Provider>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>
}
export default function Engine<Data extends FlowCanvasStep>(props: FlowCanvasProps<Data>) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}
