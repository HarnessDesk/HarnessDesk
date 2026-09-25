import type { CardEvidence, CheckRun, Evidence, EvidenceView, Freshness, Sha } from '@harnessdesk/protocol'

/** A commit, as a person reads it. */
export const shortSha = (sha: Sha): string => sha.slice(0, 7)

const plural = (n: number, noun: string): string => `${n} ${n === 1 ? noun : `${noun}s`}`

export const isStale = (freshness: Freshness): boolean =>
  freshness.state === 'behind' ||
  freshness.state === 'moved' ||
  freshness.state === 'uncommitted'

export const isCurrent = (freshness: Freshness): boolean => freshness.state === 'fresh' || freshness.state === 'final'

export const sinceWords = (freshness: Freshness): string | null => {
  switch (freshness.state) {
    case 'behind':
      return `${plural(freshness.commits, 'commit')} since`
    case 'moved':
      return 'rewritten since'
    case 'uncommitted':
      return 'uncommitted'
    case 'fresh':
    case 'final':
    case 'unknown':
      return null
  }
}

export const standingWords = (freshness: Freshness): string => {
  switch (freshness.state) {
    case 'fresh':
      return 'Fresh: nothing has landed on its branch since.'
    case 'final':
      return 'Final: the pull request was merged and its branch is gone, so nothing can land on it now.'
    case 'behind':
      return `Stale: ${plural(freshness.commits, 'commit')} landed on its branch since.`
    case 'moved':
      return 'Stale: its branch was rewritten since, and this commit is no longer on it.'
    case 'uncommitted':
      return 'Stale: it ran on changes that were never committed.'
    case 'unknown':
      return `Unknown: ${freshness.why}.`
  }
}

type CheckFact = Extract<Evidence, { kind: 'check' }>

export const checkPassed = (fact: CheckFact): boolean => fact.exit === 0 && !fact.timedOut

export const checkWords = (fact: CheckFact): string =>
  fact.timedOut
    ? 'It ran past its time and was stopped.'
    : fact.exit === null
      ? 'It did not start.'
      : `It exited ${fact.exit}.`

export type CiVerdict = 'passed' | 'failed' | 'cancelled' | 'running' | 'skipped'

export const ciVerdict = (checks: readonly CheckRun[]): CiVerdict => {
  if (checks.some((one) => one.state === 'failed')) return 'failed'
  if (checks.some((one) => one.state === 'cancelled')) return 'cancelled'
  if (checks.some((one) => one.state === 'pending')) return 'running'
  return checks.some((one) => one.state === 'passed') ? 'passed' : 'skipped'
}

export const revisionOfFact = (fact: Evidence): Sha | null => {
  switch (fact.kind) {
    case 'check':
    case 'ci':
    case 'review':
    case 'finding':
      return fact.at
    case 'pr':
      return fact.head
    case 'diff':
      return fact.to
    case 'spend':
      return null
  }
}

export const byWords = (view: EvidenceView): string =>
  view.by === null ? 'The desk' : view.by.agent === null ? view.by.seat : `${view.by.agent} on ${view.by.seat}`

export type FactOutcome =
  | 'open'
  | 'merged'
  | 'closed'
  | 'passed'
  | 'failed'
  | 'running'
  | 'skipped'
  | 'timed out'

export interface FactChip {
  readonly key: string
  /** The fact itself — what a card shows, whole. */
  readonly label: string
  /**
   * How far the fact is behind, for a stale one: "2 commits since". Said
   * aloud and in the chip's title, not drawn on it — the stale glyph already
   * says it is behind, and on a 185px card the distance is what cut the fact
   * itself down to "verify ✓ @a1b…".
   */
  readonly since: string | null
  readonly outcome: FactOutcome | null
  readonly stale: boolean
  readonly unknown: boolean
}

/** The fact and how far behind it is, as one line: a chip's title. */
export const chipWords = (chip: FactChip): string => (chip.since ? `${chip.label} — ${chip.since}` : chip.label)

export const spokenChip = (chip: FactChip): string =>
  `${chipWords(chip)}${chip.stale ? ' (stale)' : ''}${chip.unknown ? ' (unknown)' : ''}`

const checkLabel = (fact: CheckFact): string => {
  const at = `@${shortSha(fact.at)}`
  if (fact.timedOut) return `${fact.name} timed out ${at}`
  if (fact.exit === null) return `${fact.name} did not start ${at}`
  return fact.exit === 0 ? `${fact.name} ✓ ${at}` : `${fact.name} ✗ ${at}`
}

const checkOutcome = (fact: CheckFact): FactOutcome | null =>
  fact.timedOut ? 'timed out' : fact.exit === null ? null : fact.exit === 0 ? 'passed' : 'failed'

const ciLabel = (verdict: CiVerdict): string =>
  verdict === 'passed' ? 'CI ✓' : verdict === 'failed' ? 'CI ✗' : `CI ${verdict}`

type DiffFact = Extract<Evidence, { kind: 'diff' }>

const isEmptyDiff = (fact: DiffFact): boolean => fact.files === 0 && fact.added === 0 && fact.removed === 0

const isEmptyDiffView = (view: EvidenceView): boolean => view.record.fact.kind === 'diff' && isEmptyDiff(view.record.fact)

export const chipOf = (view: EvidenceView): FactChip => {
  const fact = view.record.fact
  const since = sinceWords(view.freshness)
  const stale = isStale(view.freshness)
  const unknown = view.freshness.state === 'unknown'
  const chip = (key: string, label: string, outcome: FactOutcome | null): FactChip => ({
    key,
    label,
    since,
    outcome,
    stale,
    unknown,
  })
  switch (fact.kind) {
    case 'check':
      return chip(`check:${fact.name}`, checkLabel(fact), checkOutcome(fact))
    case 'ci': {
      const verdict = ciVerdict(fact.checks)
      return chip('ci', ciLabel(verdict), verdict === 'cancelled' ? null : verdict)
    }
    case 'pr':
      return chip('pr', `PR #${fact.number} ${fact.state}`, fact.state)
    case 'diff':
      return chip('diff', isEmptyDiff(fact) ? 'no changes' : `+${fact.added} −${fact.removed} in ${plural(fact.files, 'file')}`, null)
    case 'review':
      return chip(`review:${fact.by}`, `review: ${fact.verdict}`, null)
    case 'finding':
      return chip(`finding:${fact.id}`, `finding ${fact.state}`, null)
    case 'spend':
      return {
        key: 'spend',
        label: `$${fact.usd.toFixed(2)} in ${plural(fact.turns, 'turn')}`,
        since: null,
        outcome: null,
        stale: false,
        unknown: false,
      }
  }
}

/**
 * A card's chips. `finished` is whether the card says its work is done — on
 * the board, an intent in the `done` state, which is what lands a card in
 * Needs you, In review or Ready rather than To do or Working.
 */
export const cardChips = (card: CardEvidence | undefined, finished = false): readonly FactChip[] => {
  if (!card) return []
  const running = new Set(card.running.map((one) => one.name))
  const chips = [
    ...card.running.map((one): FactChip => ({
      key: `check:${one.name}`,
      label: `${one.name} running`,
      since: null,
      outcome: 'running',
      stale: false,
      unknown: false,
    })),
    ...card.facts
      .filter((view) => !(view.record.fact.kind === 'check' && running.has(view.record.fact.name)))
      .map((view) => ({ view, chip: chipOf(view) })),
  ]
  /* A diff that changed nothing is a count of zero: beside other facts it
     says nothing and draws no chip (the dialog still lists it). Alone on a
     card that says it is finished, it is the finding — work that claims to
     be done changed nothing — so it stays, one quiet neutral chip. On a card
     still being worked, or not yet claimed, nothing is known yet: the same
     "no changes" on every working card is noise, so it draws nothing. */
  const said = chips.filter((one) => !('view' in one) || !isEmptyDiffView(one.view))
  const kept = said.length > 0 || !finished ? said : chips.slice(0, 1)
  return kept.map((one) => ('chip' in one ? one.chip : one))
}
