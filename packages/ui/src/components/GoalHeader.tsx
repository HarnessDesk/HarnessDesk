import type { GoalView } from '@harnessdesk/protocol'

import { Button, Chip, DetailHead, Note, RowButton, Rows } from '../design'
import { goalActions, goalWords } from '../lib/goals'
import { useStore } from '../state/context'
import { GoalIntake } from './GoalIntake'

export const GoalHeader = ({ view, onWrap }: { readonly view: GoalView; readonly onWrap: () => void }) => {
  const store = useStore()
  const words = goalWords({ goal: view.goal, activity: view.activity })
  const action = goalActions(view.goal)
  const reason = view.problem ?? action.reason

  return (
    <>
      <DetailHead
        name={view.goal.sentence}
        owner={<Chip tone={words.tone}>{words.label}</Chip>}
        blurb={view.goal.cwd}
        actions={<Button disabled={action.disabled || view.problem !== null} onClick={onWrap}>Wrap</Button>}
      />
      {view.waitingOn.length > 0 ? (
        <Rows aria-label="Dependencies">
          {view.waitingOn.map((dependency) => (
            <RowButton
              key={dependency.id}
              title={dependency.sentence}
              desc="This Goal is waiting for it."
              chevron
              onClick={() => store.openGoal(dependency.id)}
            />
          ))}
        </Rows>
      ) : null}
      {reason ? <Note {...(view.problem ? { tone: 'bad' as const } : {})}>{reason}</Note> : null}
      {view.goal.origin.kind === 'trigger' && <GoalIntake goal={view.goal.id} />}
    </>
  )
}
