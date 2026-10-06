import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer,
  Handle, Position, MarkerType, MiniMap, Panel, getSmoothStepPath, getViewportForBounds,
  useNodesInitialized, useReactFlow, useStore,
  type Node, type NodeProps, type Edge, type EdgeProps, type NodeChange, type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/base.css'
import { CanvasSelectIcon, CanvasHandIcon, CanvasFitIcon, ZoomInIcon, ZoomOutIcon } from '../../../components/Icons'
import { Button } from '../../ui/button'
import { Chip } from '../Settings'
import { StepCard } from './StepCard'
import { FLOW_CANVAS_CARD_WIDTH } from './geometry'
import { FLOW_GAP } from '../../../lib/flow-layout'
import type { FlowCanvasStep, FlowCanvasNodeProps, FlowCanvasProps, FlowCanvasEdgeChange } from './types'
import { forwardNodeChanges } from './changes'
import { selectionMatches } from './selection'
import styles from './FlowCanvas.module.css'

// Geometry required by the graph engine, not a second auto layout or palette.
const GRID = 16
const CORNER = 16
const MIN_ZOOM = 0.05
const LANE_PITCH = GRID * 2
const MINIMAP_INSET = 15
const MINIMAP_TOOL_RESERVED_HEIGHT = 56
const MINIMAP_TOOL_RESERVED_WIDTH = 210
const MINIMAP_SEARCH_STEP = 24
const MINIMAP_SIZES = [{ width: 200, height: 150 }, { width: 160, height: 120 }, { width: 120, height: 90 }, { width: 100, height: 75 }, { width: 80, height: 60 }, { width: 64, height: 48 }, { width: 48, height: 36 }] as const
const RenderContext = createContext<(props: FlowCanvasNodeProps) => React.ReactNode>(props => <StepCard {...props} />)
type EngineNode = Node<{ presentation: FlowCanvasNodeProps['node']; readOnly: boolean }, 'step'>
type EngineEdge = Edge<{ kind?: 'rule' | 'attachment'; railY?: number; labelX?: number }, 'rule'>

const Step = ({ data, selected }: NodeProps<EngineNode>) => {
  const render = useContext(RenderContext)
  return <div className={`${styles.node} nokey`} data-readonly={data.readOnly}>
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
  const [path, centeredX, y] = rail === undefined
    ? getSmoothStepPath({ ...props, borderRadius: CORNER, offset: GRID })
    : railPath(props.sourceX, props.sourceY, props.targetX, props.targetY, rail)
  const x = props.data?.labelX ?? centeredX
  return <>
    <g data-flow-source={props.source} data-flow-target={props.target} data-flow-rail-y={rail ?? ''}>
      <BaseEdge path={path} markerEnd={props.markerEnd} className={styles.edge} style={props.style} />
    </g>
    {props.label && <EdgeLabelRenderer><div data-flow-edge-id={props.id} className={`${styles.word} nodrag nopan`} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}><Chip tone="neutral">{props.label}</Chip></div></EdgeLabelRenderer>}
  </>
}
const nodeTypes = { step: Step }
const edgeTypes = { rule: Rule }

const Canvas = <Data extends FlowCanvasStep>({ nodes, edges, readOnly = false, label = 'Flow plan', className, NodeComponent, onNodesChange, onEdgesChange, onConnect, onSelectionChange }: FlowCanvasProps<Data>) => {
  const [measurements, setMeasurements] = useState<ReadonlyMap<string, { width: number; height: number }>>(new Map())
  const [tool, setTool] = useState<'select' | 'hand'>('select')
  const [announcement, setAnnouncement] = useState('')
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
  useEffect(() => {
    if (!initialized || !width || !height) return
    const previous = centredIds.current
    const replaced = !previous || !nodes.some(node => previous.has(node.id))
    const resized = centredWidth.current !== width
    centredIds.current = new Set(nodes.map(node => node.id))
    centredWidth.current = width
    if (!replaced && !resized) return
    const bounds = flow.getNodesBounds(flow.getNodes())
    const currentZoom = replaced ? 1 : Math.min(1, flow.getZoom())
    if (bounds.width * currentZoom > width || bounds.height * currentZoom > height) {
      void flow.setViewport(getViewportForBounds(bounds, width, height, MIN_ZOOM, currentZoom, 0.12))
    } else if (replaced) {
      void flow.setViewport({ x: (width - bounds.width) / 2 - bounds.x, y: (height - bounds.height) / 2 - bounds.y, zoom: 1 })
    }
  }, [initialized, width, height, flow, nodeIdSignature])
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
    data: { presentation: node, readOnly },
    initialWidth: node.size?.width ?? FLOW_CANVAS_CARD_WIDTH, initialHeight: node.size?.height,
    measured: measurements.get(node.id),
    style: { width: node.size?.width ?? FLOW_CANVAS_CARD_WIDTH, ...(node.size?.height ? { height: node.size.height } : {}) },
    draggable: !readOnly && tool === 'select', connectable: !readOnly && tool === 'select',
    deletable: !readOnly, ariaLabel: node.data.name,
  })), [nodes, readOnly, tool, measurements])
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
    const maxLaneIndex = Math.max(0, ...Array.from(outgoingCounts.values(), count => count - 1))
    const railCandidates = new Set<number>()
    const addGroupBases = (y: number) => {
      for (let lane = 0; lane <= maxLaneIndex; lane += 1) railCandidates.add(y - lane * LANE_PITCH)
    }
    for (const box of boxes) {
      addGroupBases(box.top - GRID)
      addGroupBases(box.bottom + GRID)
    }
    // Clearance changes at card boundaries. Sampling every grid row in every
    // pair's gap adds duplicate work without adding another clear interval.
    addGroupBases(bottom + GRID)
    const orderedHeights = [...railCandidates].sort((a, b) => a - b)
    // Walk outward from the preferred height, without sorting the whole set
    // again for every source. A clear nearby rail ends the search immediately.
    function* nearestHeights(preferred: number) {
      let low = 0, high = orderedHeights.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (orderedHeights[middle]! < preferred) low = middle + 1
        else high = middle
      }
      let left = low - 1, right = low
      while (left >= 0 || right < orderedHeights.length) {
        if (left < 0 || (right < orderedHeights.length && orderedHeights[right]! - preferred <= preferred - orderedHeights[left]!)) yield orderedHeights[right++]!
        else yield orderedHeights[left--]!
      }
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
      return { edge, index, source, target, sourceBox, targetBox, groupSize, groupIndex, needsRail, railY: undefined as number | undefined, labelX: undefined as number | undefined }
    })
    // Every crossing predicate changes only at a card's top or bottom. Nearby
    // rail heights in the same interval share a count, including fallback scans.
    const crossingBoundaries = [...new Set(boxes.flatMap(box => [box.top, box.bottom]))].sort((a, b) => a - b)
    const crossingInterval = (y: number) => {
      let low = 0, high = crossingBoundaries.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (crossingBoundaries[middle]! < y) low = middle + 1
        else high = middle
      }
      // Keep exact boundaries separate: horizontal contact is inclusive while
      // the vertical exit/entry checks use strict intersection.
      return low * 2 + Number(crossingBoundaries[low] === y)
    }
    const crossingCounts = new Map<typeof routeEdges[number], Map<number, number>>()
    const routeCrossingCount = (route: typeof routeEdges[number], y: number) => {
      const interval = crossingInterval(y)
      const cached = crossingCounts.get(route)?.get(interval)
      if (cached !== undefined) return cached
      const { sourceBox, targetBox, source, target } = route
      if (!sourceBox || !targetBox || !source || !target) return Number.MAX_SAFE_INTEGER
      let crossings = 0
      if (y >= sourceBox.top && y <= sourceBox.bottom) crossings += 1
      if (y >= targetBox.top && y <= targetBox.bottom) crossings += 1
      const sourceTurn = sourceBox.right + GRID, targetTurn = targetBox.left - GRID
      const left = Math.min(sourceTurn, targetTurn), right = Math.max(sourceTurn, targetTurn)
      const sourceTop = Math.min(y, sourceBox.centerY), sourceBottom = Math.max(y, sourceBox.centerY)
      const targetTop = Math.min(y, targetBox.centerY), targetBottom = Math.max(y, targetBox.centerY)
      for (const box of boxes) {
        if (box.node.id === source.id || box.node.id === target.id) continue
        const onRail = y >= box.top && y <= box.bottom && right > left && box.left < right && box.right > left
        const onSourceExit = sourceTurn >= box.left && sourceTurn <= box.right
          && sourceBottom > box.top && sourceTop < box.bottom
        const onTargetEntry = targetTurn >= box.left && targetTurn <= box.right
          && targetBottom > box.top && targetTop < box.bottom
        if (onRail || onSourceExit || onTargetEntry) crossings += 1
      }
      const counts = crossingCounts.get(route) ?? new Map<number, number>()
      counts.set(interval, crossings); crossingCounts.set(route, counts)
      return crossings
    }
    const routeIsClear = (route: typeof routeEdges[number], y: number) => routeCrossingCount(route, y) === 0
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
        const candidates: number[] = []
        const isGroupClear = (candidate: number) => group.every(member => {
          const lane = candidate + member.groupIndex * LANE_PITCH
          return routeIsClear(member, lane) && fitsBesideExisting(member, lane)
        })
        const crossingScore = (candidate: number) => group.reduce((score, member) => {
          const lane = candidate + member.groupIndex * LANE_PITCH
          return score + routeCrossingCount(member, lane) * 1000 + Number(!fitsBesideExisting(member, lane))
        }, 0)
        for (const candidate of nearestHeights(preferredY(route))) {
          candidates.push(candidate)
          if (isGroupClear(candidate)) { base = candidate; break }
        }
        if (base === undefined) {
          let bestScore = Infinity
          for (const candidate of candidates) {
            const score = crossingScore(candidate)
            if (score < bestScore) { base = candidate; bestScore = score }
          }
          base ??= bottom + GRID
        }
        groupBase.set(route.edge.source, base)
      }
      route.railY = base + route.groupIndex * LANE_PITCH
      const left = Math.min(route.sourceBox.right + GRID, route.targetBox.left - GRID)
      const right = Math.max(route.sourceBox.right + GRID, route.targetBox.left - GRID)
      reservations.push({ y: route.railY, left, right })
    }
    const routeSegments = (route: typeof routeEdges[number]): Array<[number, number, number, number]> => {
      if (!route.sourceBox || !route.targetBox) return []
      const sourceX = route.sourceBox.right, sourceY = route.sourceBox.centerY
      const targetX = route.targetBox.left, targetY = route.targetBox.centerY
      if (route.railY === undefined) return [[sourceX, sourceY, targetX, targetY]]
      const exitX = sourceX + GRID, entryX = targetX - GRID, railY = route.railY
      return [
        [sourceX, sourceY, exitX, sourceY],
        [exitX, sourceY, exitX, railY],
        [exitX, railY, entryX, railY],
        [entryX, railY, entryX, targetY],
        [entryX, targetY, targetX, targetY],
      ]
    }
    const segmentsByRoute = new Map(routeEdges.map(route => [route, routeSegments(route)]))
    const labelHitsSegment = (x: number, y: number, halfWidth: number, segment: [number, number, number, number]) => {
      const [x1, y1, x2, y2] = segment
      const left = x - halfWidth, right = x + halfWidth, top = y - 14, bottom = y + 14
      if (y1 === y2) return y1 >= top && y1 <= bottom && Math.max(x1, x2) >= left && Math.min(x1, x2) <= right
      if (x1 === x2) return x1 >= left && x1 <= right && Math.max(y1, y2) >= top && Math.min(y1, y2) <= bottom
      const distance = Math.hypot(x2 - x1, y2 - y1)
      for (let offset = 0; offset <= distance; offset += 4) {
        const ratio = distance ? offset / distance : 0
        const pointX = x1 + (x2 - x1) * ratio, pointY = y1 + (y2 - y1) * ratio
        if (pointX >= left && pointX <= right && pointY >= top && pointY <= bottom) return true
      }
      return false
    }
    for (const route of routeEdges) {
      if (!route.edge.label || !route.sourceBox || !route.targetBox) continue
      const sourceX = route.sourceBox.right, sourceY = route.sourceBox.centerY
      const targetX = route.targetBox.left
      const left = route.railY === undefined ? Math.min(sourceX, targetX) : Math.min(sourceX + GRID, targetX - GRID)
      const right = route.railY === undefined ? Math.max(sourceX, targetX) : Math.max(sourceX + GRID, targetX - GRID)
      const y = route.railY ?? sourceY
      const preferred = (left + right) / 2
      const candidates = [preferred]
      for (let offset = GRID / 4; offset <= right - left; offset += GRID / 4) candidates.push(preferred - offset, preferred + offset)
      const halfWidth = route.edge.label.length * 4 + 12
      route.labelX = candidates.find(candidate => candidate >= left && candidate <= right && routeEdges.every(other =>
        other === route || (segmentsByRoute.get(other) ?? []).every(segment => !labelHitsSegment(candidate, y, halfWidth, segment)))) ?? preferred
    }
    return routeEdges.map(route => {
      const { edge, source, target } = route
      return {
        ...edge, type: 'rule', data: { kind: edge.kind, ...(route.railY === undefined ? {} : { railY: route.railY }), ...(route.labelX === undefined ? {} : { labelX: route.labelX }) }, deletable: !readOnly,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--hd-border-strong)' },
        style: edge.kind === 'attachment' ? { strokeDasharray: '6 4' } : undefined,
        ariaLabel: `${source?.data.name ?? edge.source} to ${target?.data.name ?? edge.target}${edge.label ? `: ${edge.label}` : ''}`,
      }
    })
  }, [edges, nodes, readOnly, measurements])

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
    const exposed = forwardNodeChanges(changes, readOnly)
    if (exposed.length) onNodesChange?.(exposed)
  }
  const changeEdges = (changes: EdgeChange<EngineEdge>[]) => {
    const exposed = changes.filter((change): change is FlowCanvasEdgeChange => change.type === 'select' || !readOnly && change.type === 'remove')
    if (exposed.length) onEdgesChange?.(exposed)
  }
  const selectionChanged = useCallback((selection: { nodes: EngineNode[]; edges: EngineEdge[] }) => {
    const next = { nodes: selection.nodes.map(node => node.id), edges: selection.edges.map(edge => edge.id) }
    if (!selectionReady.current) {
      const controlled = controlledSelection.current
      if (!selectionMatches(next, controlled)) return
      selectionReady.current = true
    }
    selectionCallback.current?.(next)
  }, [])
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target !== event.currentTarget && !target.matches('.react-flow__node, .react-flow__edge')) return
    const directions: Record<string, [number, number]> = { ArrowLeft: [-GRID, 0], ArrowRight: [GRID, 0], ArrowUp: [0, -GRID], ArrowDown: [0, GRID] }
    const direction = directions[event.key]
    if (event.metaKey || event.altKey || event.ctrlKey) {
      // Modified arrows belong to neither the window shortcut table nor the move handler.
      if (direction) event.stopPropagation()
      return
    }
    if (!direction && event.key !== 'Delete' && event.key !== 'Backspace') return
    event.preventDefault(); event.stopPropagation()
    if (readOnly || tool === 'hand') return
    const selected = nodes.filter(node => node.selected)
    if (direction) {
      if (selected.length) {
        onNodesChange?.(selected.map(node => ({ type: 'position', id: node.id, position: { x: node.position.x + direction[0], y: node.position.y + direction[1] }, dragging: false })))
        const moved = selected[0]!
        setAnnouncement(selected.length > 1 ? `Moved ${selected.length} steps.` : `Moved ${moved.data.name} to x ${moved.position.x + direction[0]}, y ${moved.position.y + direction[1]}.`)
      }
    } else {
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
      : 'Press Enter to select this step. Arrow keys move selected steps. Press Delete or Backspace to remove the selection.'
    const edgeDescription = readOnly || tool === 'hand'
      ? `Press Enter or Space to select this rule. ${modeDescription}`
      : 'Press Enter or Space to select this rule. Press Delete or Backspace to remove it.'
    return {
      'node.a11yDescription.default': nodeDescription,
      'node.a11yDescription.keyboardDisabled': nodeDescription,
      'edge.a11yDescription.default': edgeDescription,
    }
  }, [readOnly, tool])
  const minimapLayout = useMemo(() => {
    const zoom = transform[2], panX = transform[0], panY = transform[1]
    const rendered = nodes.map(node => {
      const left = node.position.x * zoom + panX, top = node.position.y * zoom + panY
      return {
        left, top,
        right: left + (node.size?.width ?? FLOW_CANVAS_CARD_WIDTH) * zoom,
        bottom: top + (node.size?.height ?? measurements.get(node.id)?.height ?? 0) * zoom,
      }
    })
    const tools = {
      left: MINIMAP_INSET, top: height - MINIMAP_INSET - (MINIMAP_TOOL_RESERVED_HEIGHT - MINIMAP_INSET),
      right: MINIMAP_INSET + MINIMAP_TOOL_RESERVED_WIDTH, bottom: height - MINIMAP_INSET,
    }
    for (const cornersOnly of [true, false]) for (const size of MINIMAP_SIZES) {
      if (width < size.width + MINIMAP_INSET * 2 || height < size.height + MINIMAP_INSET * 2) continue
      const maxLeft = width - size.width - MINIMAP_INSET, maxTop = height - size.height - MINIMAP_INSET
      const corners = [
        { left: maxLeft, top: maxTop },
        { left: MINIMAP_INSET, top: maxTop - MINIMAP_TOOL_RESERVED_HEIGHT },
        { left: maxLeft, top: MINIMAP_INSET },
        { left: MINIMAP_INSET, top: MINIMAP_INSET },
      ]
      const sites: Array<{ left: number; top: number }> = cornersOnly ? corners : []
      if (!cornersOnly) {
        for (let left = MINIMAP_INSET; left <= maxLeft; left += MINIMAP_SEARCH_STEP) sites.push({ left, top: MINIMAP_INSET }, { left, top: maxTop })
        for (let top = MINIMAP_INSET; top <= maxTop; top += MINIMAP_SEARCH_STEP) sites.push({ left: MINIMAP_INSET, top }, { left: maxLeft, top })
      }
      const checked = new Set<string>()
      for (const site of sites) {
        const { left, top } = site, key = `${left},${top}`
        if (checked.has(key) || left < MINIMAP_INSET || top < MINIMAP_INSET || left > maxLeft || top > maxTop) continue
        checked.add(key)
        const right = left + size.width, bottom = top + size.height
        const overlaps = (box: typeof tools) => box.left < right && box.right > left && box.top < bottom && box.bottom > top
        if (overlaps(tools) || rendered.some(overlaps)) continue
        return { ...size, position: 'top-left' as const, left, top }
      }
    }
    return { ...MINIMAP_SIZES.at(-1)!, position: 'top-left' as const, left: MINIMAP_INSET, top: MINIMAP_INSET }
  }, [nodes, measurements, transform, width, height])
  const render = (props: FlowCanvasNodeProps) => NodeComponent
    ? <NodeComponent {...props as FlowCanvasNodeProps<Data>} /> : <StepCard {...props} />
  return <div ref={canvasRef} className={`${styles.canvas} ${className ?? ''}`} data-slot="flow-canvas" data-readonly={readOnly} data-tool={readOnly ? 'hand' : tool} tabIndex={0} role="region" aria-label={label} onKeyDownCapture={keyboard}>
    <RenderContext.Provider value={render}>
      <ReactFlow<EngineNode, EngineEdge> id={instanceId} nodes={engineNodes} edges={engineEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={changeNodes} onEdgesChange={changeEdges} onConnect={connection => { if (!readOnly) onConnect?.({ source: connection.source, target: connection.target }) }}
        onSelectionChange={selectionChanged}
        nodesDraggable={!readOnly && tool === 'select'} nodesConnectable={!readOnly && tool === 'select'} nodesFocusable edgesFocusable
        edgesReconnectable={false} deleteKeyCode={null} panOnDrag={readOnly || tool === 'hand' ? true : [1, 2]} selectionOnDrag={!readOnly && tool === 'select'}
        minZoom={MIN_ZOOM} maxZoom={2} defaultViewport={{ x: 0, y: 0, zoom: 1 }} zoomOnDoubleClick={false}
        zoomOnScroll={!readOnly} preventScrolling={!readOnly} ariaLabelConfig={ariaLabelConfig}>
        <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.5} color="var(--hd-border-strong)" />
        <Panel position="bottom-left" className={styles.tools}>
          {!readOnly && <>
            <Button variant="ghost" size="icon" aria-label="Select tool" title="Select steps" aria-pressed={tool === 'select'} onClick={() => setTool('select')}><CanvasSelectIcon /></Button>
            <Button variant="ghost" size="icon" aria-label="Hand tool" title="Pan the canvas" aria-pressed={tool === 'hand'} onClick={() => setTool('hand')}><CanvasHandIcon /></Button>
          </>}
          <Button variant="ghost" size="icon" aria-label="Zoom out" title="Zoom out" onClick={() => void flow.zoomOut()}><ZoomOutIcon /></Button>
          <Button variant="ghost" size="icon" aria-label="Zoom in" title="Zoom in" onClick={() => void flow.zoomIn()}><ZoomInIcon /></Button>
          <Button variant="ghost" size="icon" aria-label="Fit plan" title="Fit to the canvas" onClick={() => void flow.fitView({ minZoom: MIN_ZOOM, maxZoom: Math.min(1, flow.getZoom()), padding: 0.12 })}><CanvasFitIcon /></Button>
        </Panel>
        <MiniMap position={minimapLayout.position} style={{ width: minimapLayout.width, height: minimapLayout.height, left: minimapLayout.left - MINIMAP_INSET, top: minimapLayout.top - MINIMAP_INSET, right: 'auto', bottom: 'auto' }} nodeColor="var(--hd-muted)" nodeStrokeColor="var(--hd-border)" maskColor="var(--hd-muted)" maskStrokeColor="var(--hd-border)" nodeBorderRadius={4} />
      </ReactFlow>
    </RenderContext.Provider>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>
}
export default function Engine<Data extends FlowCanvasStep>(props: FlowCanvasProps<Data>) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>
}
