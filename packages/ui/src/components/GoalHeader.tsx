import type { GoalView } from '@harnessdesk/protocol'

import { Note, RowButton, Rows } from '../design'
import { goalActions } from '../lib/goals'
import { useStore } from '../state/context'

/**
 * A Goal's body: what it is waiting on, and why it cannot be wrapped.
 *
 * The title, its state chip and the Wrap action used to live here too, in a
 * `DetailHead` stacked over the room's own header — two rows naming the same
 * Goal, one of them running its full folder across two lines. Both moved into
 * that single row (`TeamRoomPane`'s own bar, the one every Goal or room page
 * now has), which is where the design already put a conversation's title,
 * status and actions; a Goal's is no different a fact.
 *
 * A trigger Goal's own origin, budget and its "Needs you" waits lived here
 * too, in `GoalIntake` — repeating the header's own origin chip, and a card
 * where a pending approval belongs on the composer instead. Both moved: the
 * origin's full detail is the header chip's own hover card now, the budget
 * is the composer's own meter, and a pending approval takes the composer's
 * slot directly, live, rather than a sentence read from a poll.
 */
export const GoalHeader = ({ view }: { readonly view: GoalView }) => {
  const store = useStore()
  const action = goalActions(view.goal)
  const reason = view.problem ?? action.reason

  return (
    <>
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
    </>
  )
}
