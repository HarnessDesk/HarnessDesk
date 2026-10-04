import { useMemo } from 'react'
import { splitSessionKey, type FlowExecution, type Intent } from '@harnessdesk/protocol'
import { approvalDoor, stepDoor, type NeedsYouAnswers } from '../lib/needs-you'
import { useSnapshot, useStore } from './context'
import type { AppStore } from './store'

/**
 * A person's answer to a card a Flow addressed to them, as the same request
 * the board makes. The arguments are shaped as the board shapes them — none
 * the card does not mean — so an answer given here and one given there are one
 * thing to the host, which refuses the second as already answered. `note` is
 * the context package the next round reads.
 */
export const answerStep = (
  store: Pick<AppStore, 'teamIntent'>,
  room: string,
  card: number,
  outcome: string | null,
  note: string,
): Promise<void> =>
  note
    ? store.teamIntent(room, card, 'done', undefined, outcome ?? undefined, note)
    : outcome !== null
      ? store.teamIntent(room, card, 'done', undefined, outcome)
      : store.teamIntent(room, card, 'done')

/**
 * What a Team's Overview can do about what needs the person: the doors, from
 * the cards and the requests the window already holds, and the calls that
 * answer through them. An approval is answered through the store call the
 * docked card makes, so whichever door answers first wins as it does today.
 */
export const useNeedsYouAnswers = ({ room, execution, cards, openBoard }: {
  room: string
  execution: FlowExecution | null
  cards: readonly Intent[]
  openBoard: () => void
}): NeedsYouAnswers => {
  const store = useStore()
  const snapshot = useSnapshot()
  return useMemo((): NeedsYouAnswers => ({
    stepDoor: (card) => {
      const found = cards.find((one) => one.id === card)
      return found ? stepDoor(found, execution) : null
    },
    approvalDoor: (id) => {
      const entry = snapshot.approvals.find((one) => one.approval.id === id)
      if (!entry) return null
      const runtime = snapshot.runtimes.find((one) => one.id === splitSessionKey(entry.key).runtime)
      // The docked card's own condition for wording a board tool's grants.
      const words = runtime?.capabilities.perToolMcpApproval && runtime.presentation.boardToolApproval ? runtime.presentation.boardToolApproval : null
      return { key: entry.key, ...approvalDoor(entry.approval, words) }
    },
    answerStep: (card, outcome, note) => answerStep(store, room, card, outcome, note),
    respond: (key, id, decision) => { void store.respondToApproval(key, id, decision) },
    openBoard,
  }), [store, snapshot.approvals, snapshot.runtimes, room, execution, cards, openBoard])
}
