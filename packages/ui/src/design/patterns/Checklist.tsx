import type { ReactNode } from 'react'

import { TodoActiveIcon, TodoDoneIcon, TodoPendingIcon } from '../../components/Icons'
import { cn } from '@/lib/utils'
import styles from './Checklist.module.css'

/**
 * A plan's steps: the one list an agent's plan is drawn as, in the sidebar's
 * Tasks panel and in the transcript alike.
 *
 * The state is carried by the mark and the ink, never by a word in a column
 * of its own — "in progress" beside a step took a third of a narrow column
 * and wrapped every step into a tower. Done is a check and struck, faded
 * ink; the step under way is the accent's dot at the subject's ink; a step
 * still to come is an empty ring in the quieter ink. The mark is centred on
 * the step's first line, never on the whole step, so a long step reads down
 * from its mark rather than around it.
 */
export type ChecklistState = 'pending' | 'active' | 'done'

const MARK: Record<ChecklistState, (props: { size: number }) => ReactNode> = {
  pending: TodoPendingIcon,
  active: TodoActiveIcon,
  done: TodoDoneIcon,
}

const LABEL: Record<ChecklistState, string> = { pending: 'To do', active: 'In progress', done: 'Done' }

export const Checklist = ({ children, className, label }: { children: ReactNode; className?: string; label?: string }) => (
  <ul className={cn(styles.list, className)} data-slot="checklist" {...(label ? { 'aria-label': label } : {})}>
    {children}
  </ul>
)

export const ChecklistItem = ({
  state,
  children,
  after,
}: {
  state: ChecklistState
  /** The step's words, or a control drawn as them (the panel's reword button). */
  children: ReactNode
  /** Short marks on the step's own line: a priority chip, "edited". */
  after?: ReactNode
}) => (
  <li className={styles.item} data-slot="checklist-item" data-state={state}>
    <span className={styles.mark} role="img" aria-label={LABEL[state]}>
      {MARK[state]({ size: 14 })}
    </span>
    <span className={styles.body}>
      {children}
      {after ? <span className={styles.after}>{after}</span> : null}
    </span>
  </li>
)
