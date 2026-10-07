import { useRef, useState } from 'react'
import { Chip, FlowCanvas, FLOW_CANVAS_CARD_WIDTH, FLOW_CANVAS_RUN_CARD_HEIGHT, Text, type FlowCanvasNode, type FlowCanvasEdge, type FlowCanvasNodeChange, type FlowCanvasEdgeChange } from '../design'
import { useTheme } from '../state/theme'
import { flowLayout, FLOW_CARD_H, FLOW_CARD_W, FLOW_GAP, FLOW_ROW_GAP } from '../lib/flow-layout'
import { flowGraphModel } from './flow-graph-fixture'

const plan: FlowCanvasNode[] = [
  { id: 'write', position: { x: 0, y: 0 }, data: { name: 'Write', kind: 'agent', roleLine: 'Implementer · own checkout', seatLine: 'One seat' } },
  { id: 'review', position: { x: 328, y: 0 }, data: { name: 'Review', kind: 'agent', roleLine: 'Reviewer · read', seatLine: 'Two seats' } },
  { id: 'check', position: { x: 656, y: 0 }, data: { name: 'Check', kind: 'check', roleLine: 'Run the tests', seatLine: 'One check' } },
  { id: 'ship', position: { x: 656, y: 240 }, data: { name: 'Ship it', kind: 'person', roleLine: 'You · after the checks', seatLine: 'One answer' } },
  { id: 'note', position: { x: 0, y: 240 }, data: { name: 'The brief', kind: 'note', roleLine: 'Read before writing', seatLine: 'Attached to Write' } },
]
const rules: FlowCanvasEdge[] = [
  { id: 'r1', source: 'write', target: 'review', label: 'ready' },
  { id: 'r2', source: 'review', target: 'write', label: 'request-changes' },
  { id: 'r3', source: 'review', target: 'check', label: 'approve' },
  { id: 'r4', source: 'check', target: 'ship', label: 'passed' },
  { id: 'r5', source: 'check', target: 'write', label: 'failed' },
  { id: 'r6', source: 'ship', target: 'write', label: 'revise' },
  { id: 'brief', source: 'note', target: 'write', kind: 'attachment' },
]
const applyNodes = (nodes: readonly FlowCanvasNode[], changes: readonly FlowCanvasNodeChange[]) => changes.reduce((next, change) => change.type === 'remove'
  ? next.filter(node => node.id !== change.id)
  : next.map(node => node.id !== change.id ? node : { ...node, ...(change.type === 'position' ? { position: change.position } : { selected: change.selected }) }), [...nodes])
const applyEdges = (edges: readonly FlowCanvasEdge[], changes: readonly FlowCanvasEdgeChange[]) => changes.reduce((next, change) => change.type === 'remove'
  ? next.filter(edge => edge.id !== change.id) : next.map(edge => edge.id === change.id ? { ...edge, selected: change.selected } : edge), [...edges])

export const FlowCanvasExample = ({ readOnly }: { readOnly: boolean }) => {
  const [nodes, setNodes] = useState(plan), [edges, setEdges] = useState(rules)
  const [dragStarted, setDragStarted] = useState(false), [dragging, setDragging] = useState(false)
  const nextConnectionId = useRef(0)
  return <section id={readOnly ? 'flow-canvas-readonly' : 'flow-canvas-editable'} className="flex flex-col gap-2" data-catalog-state={readOnly ? 'disabled' : 'editing'}>
    <Text role="section">{readOnly ? 'A started plan' : 'Build a plan'}</Text>
    <div className="h-128"><FlowCanvas nodes={nodes} edges={edges} readOnly={readOnly}
      onNodesChange={changes => {
        for (const change of changes) if (change.type === 'position') {
          setDragging(change.dragging)
          if (change.dragging) setDragStarted(true)
        }
        setNodes(nodes => applyNodes(nodes, changes))
      }}
      onEdgesChange={changes => setEdges(edges => applyEdges(edges, changes))}
      onConnect={connection => setEdges(edges => [...edges, { id: `connection-${nextConnectionId.current++}`, ...connection, label: 'next' }])} /></div>
    <span className="sr-only" data-position-drag-started={dragStarted} data-position-dragging={dragging} />
  </section>
}
export const FlowCanvasRunPlan = () => {
  const model = flowGraphModel('blueprint'), layout = flowLayout(model)
  const xScale = (FLOW_CANVAS_CARD_WIDTH + FLOW_GAP) / (FLOW_CARD_W + FLOW_GAP)
  const yScale = (FLOW_CANVAS_RUN_CARD_HEIGHT + FLOW_ROW_GAP) / (FLOW_CARD_H + FLOW_ROW_GAP)
  const states = ['done', 'working', 'waiting', 'failed', 'skipped', 'future'] as const
  const words = ['Done', 'Running', 'Needs you', 'Failed', 'Skipped', 'Next']
  const tones = ['success', 'brand', 'warning', 'danger', 'neutral', 'neutral'] as const
  const nodes: FlowCanvasNode[] = layout.nodes.map((node, index) => {
    const step = model.steps.find(step => step.id === node.id)!
    return { id: node.id, position: { x: node.box.x * xScale, y: node.box.y * yScale }, size: { width: FLOW_CANVAS_CARD_WIDTH, height: FLOW_CANVAS_RUN_CARD_HEIGHT },
      data: { name: step.name, kind: step.kind, roleLine: step.line }, state: states[index % states.length],
      stateSlot: <Chip tone={tones[index % tones.length]!}>{words[index % words.length]}</Chip> }
  })
  const edges: FlowCanvasEdge[] = layout.edges.map(edge => ({ id: edge.id, source: edge.from, target: edge.to, label: edge.label?.text }))
  return <section id="flow-canvas-run" className="flex flex-col gap-2" data-catalog-state="running">
    <Text role="section">A Run on its plan</Text>
    <div className="h-128"><FlowCanvas nodes={nodes} edges={edges} readOnly /></div>
  </section>
}
/** The explorer and preview use the same controlled examples, with synthetic content. */
export const FlowCanvasBoard = () => <div className="flex flex-col gap-8"><FlowCanvasExample readOnly={false} /><FlowCanvasExample readOnly /><FlowCanvasRunPlan /></div>
export const FlowCanvasFrames = () => {
  useTheme()
  return <div className="p-6">{new URLSearchParams(window.location.search).has('routes') ? <FlowCanvasRoutingScenes /> : <FlowCanvasBoard />}</div>
}

const routingScenes = [
  { id: 'compact', name: 'A short plan panel', positions: [[0, 0]], rules: [] },
  { id: 'least-crossing', name: 'A crowded exit', positions: [[0, 0], [656, 0], [656, 176], [240, 40], [240, 260], [400, 100]], rules: [[0, 1, 'ready'], [0, 2, 'next']] },
  { id: 'narrow-band', name: 'A narrow route band', positions: [[656, 0], [984, -15], [984, 176], [1020, 323]], rules: [[1, 3, 'ready'], [1, 0, 'rework']] },
  { id: 'skip', name: 'Skip a step', positions: [[0, 0], [328, 0], [656, 0]], rules: [[0, 1, 'ready'], [0, 2, 'skip']] },
  { id: 'long-word', name: 'A longer answer', positions: [[0, 0], [328, 0]], rules: [[0, 1, 'request-changes']] },
  { id: 'short-gap', name: 'The layout gap', positions: [[0, 0], [296, 0]], rules: [[0, 1, 'ok']] },
  { id: 'cross-row', name: 'Across rows', positions: [[0, 0], [328, 0], [656, 176]], rules: [[0, 2, 'next']] },
  { id: 'return-lanes', name: 'Two return answers', positions: [[0, 0], [0, 176], [656, 0]], rules: [[2, 0, 'revise'], [2, 1, 'rework']] },
  { id: 'nudged-steps', name: 'Dragged steps', positions: [[0, 7], [328, 7], [656, 7], [253, 90]], rules: [[0, 1, 'revise'], [0, 2, 'rework']] },
] as const
const FlowCanvasRoutingScenes = () => <div className="flex flex-col gap-8">{routingScenes.map(scene => {
  const nodes: FlowCanvasNode[] = scene.positions.map(([x, y], index) => ({ id: `step-${index}`, position: { x, y },
    ...(scene.id === 'least-crossing' ? { size: index === 3 ? { width: 100, height: 28 } : index === 4 ? { width: 100, height: 108 } : index === 5 ? { width: 100, height: 40 } : { width: FLOW_CANVAS_CARD_WIDTH, height: 108 } }
      : scene.id === 'narrow-band' ? { size: { width: FLOW_CANVAS_CARD_WIDTH, height: 108 } } : {}),
    data: { name: ['Write', 'Review', 'Check', 'Wait', 'Note', 'Blocker'][index]!, kind: 'agent', roleLine: 'One seat' } }))
  const edges: FlowCanvasEdge[] = scene.rules.map(([source, target, label], index) => ({ id: `rule-${index}`, source: `step-${source}`, target: `step-${target}`, label }))
  return <section id={`flow-canvas-${scene.id}`} key={scene.id} className={`flex flex-col gap-2 ${scene.id === 'compact' ? 'w-125' : ''}`}>
    <Text role="section">{scene.name}</Text><div className={scene.id === 'compact' ? 'h-44 w-125' : 'h-128'}><FlowCanvas nodes={nodes} edges={edges} readOnly /></div>
  </section>
})}</div>
