import { useState } from 'react'
import type { FlowPolicy } from '@harnessdesk/protocol'
import { ShapeGraph } from '../components/ShapeGraph'
import { Text } from '../design'
import { withGraphPositions } from '../lib/shapes'
import { useTheme } from '../state/theme'
import { flowGraphDocument } from './flow-graph-fixture'

/** The ordered editor's graph, with the same position writer and synthetic policy. */
export const ShapeGraphBoard = () => {
  const [policy, setPolicy] = useState(() => flowGraphDocument('blueprint').flow as FlowPolicy)
  const [selected, select] = useState<string | null>(null)
  const [rule, editRule] = useState<string | null>(null)
  return <section id="shape-graph" className="flex min-w-0 flex-col gap-4">
    <Text role="section">The shape editor’s graph</Text>
    <ShapeGraph policy={policy} selected={selected} onSelect={select}
      onPositions={positions => setPolicy(policy => withGraphPositions(policy, positions))} onEditRule={editRule} />
    <span className="sr-only" data-selected-rule={rule} data-saved-positions={JSON.stringify(policy.layout)} />
  </section>
}
export const ShapeGraphFrames = () => {
  useTheme()
  return <div className="p-6"><ShapeGraphBoard /></div>
}
