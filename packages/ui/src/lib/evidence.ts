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
  readonly label: string
  readonly outcome: FactOutcome | null
  readonly stale: boolean
  readonly unknown: boolean
}

export const spokenChip = (chip: FactChip): string =>
  `${chip.label}${chip.stale ? ' (stale)' : ''}${chip.unknown ? ' (unknown)' : ''}`

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

export const chipOf = (view: EvidenceView): FactChip => {
  const fact = view.record.fact
  const since = sinceWords(view.freshness)
  const said = (base: string): string => (since ? `${base} — ${since}` : base)
  const stale = isStale(view.freshness)
  const unknown = view.freshness.state === 'unknown'
  const chip = (key: string, label: string, outcome: FactOutcome | null): FactChip => ({
    key,
    label: said(label),
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
      return chip('diff', `+${fact.added} −${fact.removed} in ${plural(fact.files, 'file')}`, null)
    case 'review':
      return chip(`review:${fact.by}`, `review: ${fact.verdict}`, null)
    case 'finding':
      return chip(`finding:${fact.id}`, `finding ${fact.state}`, null)
    case 'spend':
      return {
        key: 'spend',
        label: `$${fact.usd.toFixed(2)} in ${plural(fact.turns, 'turn')}`,
        outcome: null,
        stale: false,
        unknown: false,
      }
  }
}

export const cardChips = (card: CardEvidence | undefined): readonly FactChip[] => {
  if (!card) return []
  const running = new Set(card.running.map((one) => one.name))
  return [
    ...card.running.map((one): FactChip => ({
      key: `check:${one.name}`,
      label: `${one.name} running`,
      outcome: 'running',
      stale: false,
      unknown: false,
    })),
    ...card.facts
      .filter((view) => !(view.record.fact.kind === 'check' && running.has(view.record.fact.name)))
      /* A diff that changed nothing is a count of zero, and a chip that counts
         none says nothing; the dialog still lists the fact. */
      .filter((view) => !(view.record.fact.kind === 'diff' && view.record.fact.files === 0 && view.record.fact.added === 0 && view.record.fact.removed === 0))
      .map(chipOf),
  ]
}
