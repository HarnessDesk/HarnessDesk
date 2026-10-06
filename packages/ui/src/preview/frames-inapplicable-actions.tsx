import { useMemo } from 'react'
import type { GoalReceipt as Receipt } from '@harnessdesk/protocol'
import { AbandonCard } from '../components/AbandonCard'
import { GoalReceipt } from '../components/GoalReceipt'
import { RunInspector } from '../components/RunInspector'
import { PaneColumn, SectionHead } from '../design'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { previewStore } from './harness'
import { runFixture } from './run-view-fixture'

/** Four historical states, rendered by the production surfaces with placeholder-only data. */
export const InapplicableActionsFrames = () => {
  useTheme()
  const scene = new URLSearchParams(window.location.search).get('inapplicable-actions')
  const source = useMemo(() => runFixture(scene === 'check' ? 'settled' : 'running'), [scene])
  const store = useMemo(() => {
    const base = previewStore()
    return new Proxy(base, { get(target, key) {
      if (key === 'readFindingPublications') return async () => ({ goal: source.execution.goal, run: source.execution.id,
        items: [], backfill: null, backfillRefusal: 'This round has no completed review to post.' })
      return Reflect.get(target, key)
    } })
  }, [source])
  const receipt: Receipt = {
    version: 1, id: 'receipt-1', goal: 'team-1', sentence: 'Keep the retry bounded', wrappedAt: 1_800_000_000_000,
    summary: 'The checkout retry was built and reviewed.',
    cards: [{ id: 1, title: 'Keep the last failure visible', resolution: 'finished', reason: null }, { id: 2, resolution: 'finished', reason: null }],
    seats: [], answers: [], evidence: [], citations: [], revisions: [], lanes: [], gaps: [],
  }
  const card = source.cards[3]!
  const content = scene === 'receipt' ? <PaneColumn inset="reading"><GoalReceipt receipt={receipt} root="/repo" /></PaneColumn>
    : scene === 'missing' ? <PaneColumn inset="reading"><SectionHead name="Answer the review" />
      <AbandonCard execution={source.execution} cards={source.cards} card={card} holder="Alpha"
        onAbandon={async () => { throw Object.assign(new Error('There is no card #4 on this board.'), { code: 'cardMissing' }) }} />
    </PaneColumn>
    : <RunInspector input={{ ...source,
      ...(scene === 'review' ? { findings: [], cards: source.cards.map(one => ({ ...one, handoff: null, note: null })),
        findingRun: undefined } : {}),
    }} selectedRow={scene === 'check' ? 'check-2-2' : 'card-3-3'} seats={[]}
      publication={scene === 'review' ? { round: 3, state: 'none', reason: 'This round has no completed review to post.', pr: null, cards: [3] } : null}
      reviewActions={scene === 'review' ? { goal: source.execution.goal, run: source.execution.id, stamp: 'no-review' } : undefined} />
  return <StoreProvider store={store}><section id="inapplicable-action-frame" className="flex min-h-screen flex-col bg-background text-foreground">{content}</section></StoreProvider>
}
