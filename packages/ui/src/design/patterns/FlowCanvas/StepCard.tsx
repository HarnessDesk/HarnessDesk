import { AgentIcon, TerminalIcon, UserIcon, ArrowRightIcon, NoteIcon } from '../../../components/Icons'
import { Chip, Row, Text } from '../Settings'
import { IconTile } from '../../ui/icon-tile'
import type { FlowCanvasNodeProps } from './types'
import styles from './FlowCanvas.module.css'

const marks = { start: ArrowRightIcon, agent: AgentIcon, check: TerminalIcon, person: UserIcon, note: NoteIcon }
const tints = { start: undefined, agent: 'violet', check: 'sky', person: 'amber', note: 'teal' } as const
const states = {
  future: ['Next', 'neutral'], done: ['Done', 'success'], working: ['Running', 'brand'],
  waiting: ['Needs you', 'warning'], blocked: ['Waiting', 'warning'],
  stopping: ['Stopping', 'neutral'], stopped: ['Stopped', 'neutral'],
  failed: ['Failed', 'danger'], skipped: ['Skipped', 'neutral'],
} as const

/** The builder's default card; callers may replace it without replacing the canvas. */
export const StepCard = ({ node, selected }: FlowCanvasNodeProps) => {
  const Mark = marks[node.data.kind]
  const tint = tints[node.data.kind]
  const state = node.state ? states[node.state] : undefined
  return (
    <div className={styles.card} data-slot="flow-canvas-step" data-kind={node.data.kind} data-state={node.state} data-selected={selected || undefined}>
      <Row title={node.data.name} desc={node.data.roleLine} truncateDesc mark={<IconTile {...(tint ? { tint } : { tone: 'neutral' })}><Mark /></IconTile>} />
      {node.data.seatLine && <div className={styles.seats}><Text role="meta">{node.data.seatLine}</Text></div>}
      {(node.stateSlot !== undefined || state) && <div className={styles.state} data-slot="flow-canvas-state">{node.stateSlot ?? (state && <Chip tone={state[1]}>{state[0]}</Chip>)}</div>}
    </div>
  )
}
