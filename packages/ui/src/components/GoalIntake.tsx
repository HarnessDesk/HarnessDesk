import { useEffect, useState } from 'react'

import type { TriggerAttention, TriggerGoalStatus } from '@harnessdesk/protocol'

import { Button, Chip, Note, Row, RowButton, Rows, SectionHead } from '../design'
import { intakeOriginWords, intakeStopWords, triggerBudgetWords } from '../lib/intake'
import { openExternal } from '../lib/desktop'
import { useSnapshot, useStore } from '../state/context'

export interface GoalIntakeProps {
  readonly goal: string
}

/**
 * A trigger Goal's own header addition: where it came from, its budget, and
 * every named wait on it — read once per Goal, drawn nowhere near a plain
 * conversation.
 *
 * `null` here is not a loading state worth showing: an ordinary Goal answers
 * `null` from `trigger/goal` immediately, and flashing "Reading…" over every
 * Goal's header for the common case would be the earned-line rule's exact
 * mistake. A trigger Goal's own facts appear once they arrive; nothing does
 * until then.
 */
export const GoalIntake = ({ goal }: GoalIntakeProps) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [status, setStatus] = useState<{ readonly goal: string; readonly value: TriggerGoalStatus | null } | null>(null)

  useEffect(() => {
    let live = true
    store.triggerGoal(goal).then(
      (value) => { if (live) setStatus({ goal, value }) },
      () => { if (live) setStatus({ goal, value: null }) },
    )
    return () => { live = false }
  }, [store, goal])

  if (!status || status.goal !== goal || !status.value) return null
  const view = status.value

  const openFor = (wait: TriggerAttention): (() => void) | null => {
    if (wait.action === 'open-permissions') return () => store.askSettings('permissions', 'ceilings')
    if (wait.action === 'open-usage') return () => store.askSettings('workspaces', 'triggers')
    if (wait.action === 'open-trigger') {
      const root = snapshot.goals.get(goal)?.goal.root
      return root ? () => store.askSettings('workspaces', root) : null
    }
    // 'open-goal': this component is already that Goal's own header.
    return null
  }

  return (
    <section aria-label="Trigger origin">
      <Note>
        {intakeOriginWords(view)}
        {view.url && (
          <>
            {' — '}
            <Button variant="link" size="inline" onClick={() => openExternal(view.url!)}>Open</Button>
          </>
        )}
      </Note>
      {view.budget && (
        <Note>
          {triggerBudgetWords(view.budget.budget)}
          {view.budget.stop && ` ${intakeStopWords(view.budget.stop.reason)} ${view.budget.stop.detail}`}
        </Note>
      )}
      {view.waits.length > 0 && (
        <>
          <SectionHead name="Needs you" />
          <Rows>
            {view.waits.map((wait) => {
              const onClick = openFor(wait)
              const control = <Chip tone="warning">{wait.waitingOn.label}</Chip>
              return onClick
                ? <RowButton key={wait.id} title={wait.sentence} wrapDesc control={control} onClick={onClick} />
                : <Row key={wait.id} title={wait.sentence} wrapDesc control={control} />
            })}
          </Rows>
        </>
      )}
    </section>
  )
}
