import type { FindingPublicationItem, FindingRoundPublication, FindingRunView } from '@harnessdesk/protocol'

/** Plain desk words in, presentation out; this module has no window or store dependency. */
export interface ReviewPublication {
  readonly label: string
  readonly tone: 'neutral' | 'warning'
  readonly needsYou: boolean
}
export function reviewPublication(input: {
  state: FindingRoundPublication['state'] | FindingPublicationItem['state']
  pr: number | null
  postingOn: boolean
  hasFindings: boolean
}): ReviewPublication | null {
  if (!input.hasFindings || input.state === 'none') return null
  switch (input.state) {
    case 'posted': return { label: input.pr === null ? 'Posted' : `Posted to #${input.pr}`, tone: 'neutral', needsYou: false }
    case 'prepared': case 'started': case 'pending': return { label: 'Waiting to post', tone: 'neutral', needsYou: false }
    case 'partial': return { label: 'Partly posted', tone: 'warning', needsYou: true }
    case 'uncertain': return { label: 'Not confirmed', tone: 'warning', needsYou: true }
    case 'local': return input.pr !== null && input.postingOn
      ? { label: 'Not posted', tone: 'warning', needsYou: true }
      : { label: 'Kept on the desk', tone: 'neutral', needsYou: false }
  }
}
export const runPublication = (view: FindingRunView | null | undefined, postingOn = true): ReviewPublication | null => view
  ? reviewPublication({ state: view.publication, pr: view.boundPr?.pr ?? null, postingOn, hasFindings: view.publication !== 'local' || view.rounds.some(round => round.state !== 'none') }) : null
