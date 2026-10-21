import { AgentIcon, TerminalIcon, UserIcon, ArrowRightIcon, NoteIcon } from '../../../components/Icons'
import { Chip, Text } from '../Settings'
import type { FlowCanvasNodeProps } from './types'
import styles from './FlowCanvas.module.css'

const marks = { start: ArrowRightIcon, agent: AgentIcon, check: TerminalIcon, person: UserIcon, note: NoteIcon }
const states = {
  future: ['Next', 'neutral'], done: ['Done', 'success'], working: ['Running', 'brand'],
  waiting: ['Needs you', 'warning'], blocked: ['Waiting', 'warning'],
  stopping: ['Stopping', 'neutral'], stopped: ['Stopped', 'neutral'],
  failed: ['Failed', 'danger'], skipped: ['Skipped', 'neutral'],
} as const

/** The builder's default card; callers may replace it without replacing the canvas. */
export const StepCard = ({ node, selected }: FlowCanvasNodeProps) => {
  const Mark = marks[node.data.kind]
  const state = node.state ? states[node.state] : undefined
  return (
    <div className={styles.card} data-slot="flow-canvas-step" data-kind={node.data.kind} data-state={node.state} data-selected={selected || undefined}>
      <div className={styles.cardHeader}>
        <span className={styles.mark} aria-hidden="true"><Mark size={20} /></span>
        <Text role="row" truncate title={node.data.name}>{node.data.name}</Text>
        {node.data.roleLine && <Text role="meta" className={styles.role} truncate title={node.data.roleLine}>{node.data.roleLine}</Text>}
      </div>
      {node.data.seatLine && <div className={styles.seats}><Text role="meta">{node.data.seatLine}</Text></div>}
      {(node.stateSlot !== undefined || state) && <div className={styles.state} data-slot="flow-canvas-state">{node.stateSlot ?? (state && <Chip size="sm" tone={state[1]}>{state[0]}</Chip>)}</div>}
    </div>
  )
}
