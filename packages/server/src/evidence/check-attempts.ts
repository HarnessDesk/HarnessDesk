import type { EvidenceRecord, FlowCheckAttempts, FlowExecution } from '@harnessdesk/protocol'

/**
 * Every result the desk recorded for one check card of a run, oldest first.
 *
 * Each time a flow's check command runs the host appends a `check` fact to the
 * evidence store (`plane.ts` `#runFlowCheck`), and a retry (#1263) appends
 * another rather than rewriting the first — so the earlier attempts, with what
 * each printed, are all still there. Nothing else folds them: `evidence/board`
 * keeps the latest fact of a question, and the card's operation is one record a
 * retry replaces. This reads the same facts the engine wrote and judges none of
 * them against git, so it is cheap to ask again.
 *
 * Which facts are this card's attempts is the rule the Run view already reads
 * its latest result by: the card's own board and number, the round it belongs
 * to, the check role's name and its exact command. A named check a person ran
 * from the card (`round: null`), a Seat's advisory `run_check` and every other
 * kind of fact are not the check step's attempts.
 *
 * The word for each is the Flow's own mapping — the `exits` entry for its
 * status, else `otherwise` — written as the engine writes it
 * (`FlowExecutions#runOneCheck`), and a test holds the two to each other.
 *
 * `results` reads the evidence, and is asked only once the card is known to be
 * a check card of this run: a card that is not one has no attempts to look for,
 * so nothing is read for it.
 */
export const checkAttemptsOf = async (
  execution: FlowExecution,
  card: number,
  results: (goal: string) => Promise<{ readonly records: readonly EvidenceRecord[]; readonly complete: boolean }>,
): Promise<FlowCheckAttempts> => {
  if (execution.document.format !== 'agents') throw new Error('This run uses the old format and is run by the old engine.')
  const round = execution.rounds.find((one) => one.cards.includes(card))
  if (!round) throw new Error(`Card #${card} belongs to no round of this run.`)
  const role = execution.document.flow.roles.find((one) => one.id === round.role)
  if (role?.kind !== 'check') throw new Error(`Card #${card} is not a check.`)
  const { check } = role
  const read = await results(execution.goal)
  const mine = read.records.flatMap((record) => {
    const fact = record.fact
    return fact.kind === 'check' && fact.advisory !== true && fact.name === role.id && fact.run === check.run &&
      record.card?.board === execution.goal && record.card.id === card && record.round === round.n
      ? [{ record, fact }]
      : []
  })
  // The order they were written in, except where a restored line lands after the later ones it predates; a tie keeps its place.
  mine.sort((a, b) => a.record.observedAt - b.record.observedAt)
  return {
    attempts: mine.map(({ record, fact }, index) => ({
      // A readable subset has no trustworthy ordinal: a skipped record may
      // precede any of these, so do not renumber it as the first attempt.
      id: record.id,
      n: read.complete ? index + 1 : null,
      at: record.observedAt,
      commit: fact.at,
      exit: fact.exit,
      timedOut: fact.timedOut,
      outcome: check.exits[String(fact.exit)] ?? check.otherwise,
      tail: fact.tail,
    })),
    complete: read.complete,
  }
}
