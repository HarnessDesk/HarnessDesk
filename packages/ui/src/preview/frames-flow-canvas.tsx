import { useState } from 'react'
import { Chip, FlowCanvas, Text, type FlowCanvasNode, type FlowCanvasEdge, type FlowCanvasNodeChange, type FlowCanvasEdgeChange } from '../design'
import { useTheme } from '../state/theme'
import { flowLayout } from '../lib/flow-layout'
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
  return <section id={readOnly ? 'flow-canvas-readonly' : 'flow-canvas-editable'} className="flex flex-col gap-2" data-catalog-state={readOnly ? 'disabled' : 'editing'}>
    <Text role="section">{readOnly ? 'A started plan' : 'Build a plan'}</Text>
    <div className="h-128"><FlowCanvas nodes={nodes} edges={edges} readOnly={readOnly}
      onNodesChange={changes => setNodes(nodes => applyNodes(nodes, changes))}
      onEdgesChange={changes => setEdges(edges => applyEdges(edges, changes))}
      onConnect={connection => setEdges(edges => [...edges, { id: `connection-${edges.length}`, ...connection, label: 'next' }])} /></div>
  </section>
}
export const FlowCanvasRunPlan = () => {
  const model = flowGraphModel('blueprint'), layout = flowLayout(model)
  const states = ['done', 'working', 'waiting', 'failed', 'skipped', 'future'] as const
  const words = ['Done', 'Running', 'Needs you', 'Failed', 'Skipped', 'Next']
  const tones = ['success', 'brand', 'warning', 'danger', 'neutral', 'neutral'] as const
  const nodes: FlowCanvasNode[] = layout.nodes.map((node, index) => {
    const step = model.steps.find(step => step.id === node.id)!
    return { id: node.id, position: { x: node.box.x, y: node.box.y }, size: { width: node.box.w },
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
  return <div className="p-6"><FlowCanvasBoard /></div>
}
