import { useMemo, useState } from 'react'
import type { FindingPublicationsView, FindingRunView } from '@harnessdesk/protocol'
import { RunWorkspace } from '../components/RunWorkspace'
import { FindingRoundStatus } from '../components/FindingRoundStatus'
import { TeamOverview } from '../components/TeamOverview'
import { TeamsWindow } from '../components/TeamsWindow'
import { AppWindowMode } from '../components/AppWindow'
import { runTimeline } from '../lib/run-timeline'
import { teamOverview } from '../lib/team-overview'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'
import { runFixture, runTeamStore } from './run-view-fixture'
import { overviewInput } from './team-overview-fixture'

export const REVIEW_PUBLICATION_STATES = ['posted', 'pending', 'partial', 'uncertain', 'local', 'kept', 'unbound', 'none', 'missing-round', 'refused', 'narrow'] as const
type Scene = typeof REVIEW_PUBLICATION_STATES[number]

/** Host-shaped synthetic reads: the aggregate and round deliberately vary independently. */
const fixture = (scene: Scene) => {
  const source = runFixture('running')
  const postingOn = scene !== 'kept'
  const bound = scene !== 'unbound'
  const state = scene === 'posted' || scene === 'missing-round' ? 'posted' : scene === 'pending' ? 'pending'
    : scene === 'partial' ? 'partial' : scene === 'uncertain' ? 'uncertain' : 'local'
  const reason = scene === 'none' ? 'This round has no completed review to post.' : scene === 'missing-round' ? 'This round’s publication details were not recorded.'
    : scene === 'refused' ? 'The pull request moved past this review.' : scene === 'kept' ? 'Posting is off for this Team.'
    : scene === 'unbound' ? 'No pull request is bound to this Run.' : state === 'local' ? 'This review was kept before the pull request was bound.'
    : state === 'uncertain' ? 'The desk did not receive confirmation.' : state === 'partial' ? 'One review still waits for you.'
    : state === 'pending' ? 'The review is waiting for the posting decision.' : 'The review is posted to pull request #128.'
  const findingRun: FindingRunView = {
    run: source.execution.id, goal: source.execution.goal, round: 3, finished: 1, total: 1, embargoed: false,
    open: scene === 'none' ? 0 : 1, blocking: scene === 'none' ? 0 : 1, reason, ceilingStop: false, stamp: `preview-${scene}`,
    publication: state, rounds: scene === 'missing-round' ? [] : [{ round: 3, state: scene === 'none' ? 'none' : state, reason, pr: bound ? 128 : null, cards: [3] }],
    reviewersFinished: 1, reviewersTotal: 1, pendingExceptions: [], repair: null,
    boundPr: bound ? { repo: 'acme/storefront', pr: 128 } : null, unbound: bound ? null : reason, undecidable: null,
  }
  const canBackfill = ['local', 'narrow'].includes(scene)
  const view: FindingPublicationsView = { goal: findingRun.goal, run: findingRun.run,
    items: scene === 'partial' || scene === 'uncertain' ? [{ key: `preview-${scene}`, round: 3, finding: null, pr: 128,
      state: scene === 'partial' ? 'prepared' : 'uncertain', reason }] : [],
    backfill: canBackfill ? { pr: 128, stamp: findingRun.stamp, rounds: [{ round: 3, findings: 1, reviews: 1 }] } : null,
    backfillRefusal: canBackfill ? null : reason,
  }
  const input = { ...source, publicationOn: postingOn, findingRun,
    findings: scene === 'none' ? [] : source.findings,
    cards: source.cards.map(card => ({ ...card, state: 'done' as const, claim: null, outcome: card.outcome ?? 'published', detail: 'Review the bounded retry.', handoff: card.id === 3 ? 'Cap the retry attempts and keep the last failure visible.' : null })),
    execution: { ...source.execution, state: 'settled' as const, rounds: source.execution.rounds.map(round => ({ ...round, state: 'closed' as const })), endedAt: Date.now(), end: { kind: 'complete' as const }, reason: 'Every step finished. Reviews stay readable.' },
  }
  const base = previewStore()
  const store = new Proxy(base, { get(target, key) {
    if (key === 'readFindingPublications') return async () => view
    if (key === 'publishFinding') return async () => ({ ...view, items: [], backfill: null, backfillRefusal: 'This review is posted.' })
    return Reflect.get(target, key)
  } })
  return { input, store }
}

export const ReviewPublicationExample = ({ scene }: { scene: Scene }) => {
  const { input, store } = useMemo(() => fixture(scene), [scene])
  const [selected, setSelected] = useState<string | null>(scene === 'narrow' ? null : 'card-3-3')
  return <StoreProvider store={store}><RunWorkspace model={runTimeline(input)} number={1} selectedRow={selected} onSelect={setSelected}
    inspector={{ input, seats: [{ id: 'seat-1', name: 'Beta', cost: { unit: 'turns', value: 4, estimated: false }, onOpen: () => {} }],
      reviewActions: { goal: input.execution.goal, run: input.execution.id, stamp: input.findingRun.stamp } }} /></StoreProvider>
}

const PublicationSurfaces = ({ prefix }: { prefix?: string }) => {
  const { input } = useMemo(() => fixture('local'), [])
  const overview = teamOverview({ ...overviewInput('done'), run: { execution: input.execution, startedAt: input.execution.startedAt ?? null },
    findingRun: input.findingRun, publicationOn: true })
  const store = useMemo(() => {
    const base = runTeamStore()
    const snapshot = { ...base.getSnapshot(), findingRuns: new Map([[input.execution.id, input.findingRun]]) }
    return new Proxy(base, { get(target, key) {
      if (key === 'getSnapshot') return () => snapshot
      if (key === 'loadFindingRun') return async () => {}
      return Reflect.get(target, key)
    } })
  }, [input])
  return <>
    <section id={prefix ? `${prefix}-overview` : undefined} data-catalog-state="overview"><TeamOverview model={overview} runReason={input.findingRun.reason} /></section>
    <section id={prefix ? `${prefix}-summary` : undefined} data-catalog-state="summary"><FindingRoundStatus view={input.findingRun} /></section>
    <section id={prefix ? `${prefix}-teams` : undefined} data-catalog-state="teams" className="relative h-144" style={{ transform: 'translateZ(0)' }}>
      <StoreProvider store={store}><AppWindowMode.Provider value="embedded"><TeamsWindow initialFilter="needs-you" onClose={() => {}} /></AppWindowMode.Provider></StoreProvider>
    </section>
  </>
}

export const ReviewPublicationBoard = () => <div className="flex flex-col gap-4">{REVIEW_PUBLICATION_STATES.map(scene =>
  <section key={scene} data-catalog-state={scene} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><ReviewPublicationExample scene={scene} /></section>)}<PublicationSurfaces /></div>
export const ReviewPublicationFrames = () => <div className="flex flex-col gap-4 p-4">{REVIEW_PUBLICATION_STATES.map(scene =>
  <section key={scene} id={`review-publication-${scene}`} className={scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : 'flex h-144 flex-col'}><ReviewPublicationExample scene={scene} /></section>)}<PublicationSurfaces prefix="review-publication" /></div>
