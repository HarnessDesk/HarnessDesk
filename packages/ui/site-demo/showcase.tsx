import { useEffect, useMemo, useState } from 'react'
import { runtimeId, type Intent, type TeamState } from '@harnessdesk/protocol'
import { TeamBoardPane } from '../src/components/TeamBoardPane'
import { AgentIcon, CheckIcon, DevToolsIcon } from '../src/components/Icons'
import { FlowGraph } from '../src/design'
import { cardEvidence, checkView, ciView, diffView, EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM, prView } from '../src/preview/evidence-fixture'
import { flowOverlayFixture, type FlowOverlayScene } from '../src/preview/flow-overlay-fixture'
import { previewStore } from '../src/preview/harness'
import { TeamViewFrame } from '../src/preview/TeamViewFrame'
import { StoreProvider } from '../src/state/context'
import type { AppSnapshot, AppStore } from '../src/state/store'

/**
 * The two large pictures of the site's showcase band: a Run drawn as it takes
 * its path, and the Team's board as its jobs change hands. Both are the App's
 * own components over its preview fixtures, and both play one loop.
 */

/* Seconds into the loop: the Run's scene, and the board's stage. */
const RUN: ReadonlyArray<readonly [number, FlowOverlayScene]> = [[0, 'fix'], [2.6, 'check-again'], [4.6, 'review'], [6.6, 'you']]
const RUN_LOOP = 16
const BOARD: ReadonlyArray<readonly [number, number]> = [[0, 0], [3, 1], [6, 2]]
const BOARD_LOOP = 14

const FACES = new Map([['alpha', <DevToolsIcon />], ['beta', <AgentIcon />], ['gamma', <CheckIcon />]])
const DOING = new Map([['alpha', 'Edited src/checkout/retry.ts'], ['beta', 'Read src/checkout/retry.ts'], ['gamma', 'Read src/checkout/retry.ts']])

/** The scene a looping timeline is in at this moment: the last entry whose start has passed. */
const useLoop = <T,>(timeline: ReadonlyArray<readonly [number, T]>, loop: number, motion?: 'reduce') => {
  const settled = timeline[timeline.length - 1]![1]
  const [value, setValue] = useState<T>(motion === 'reduce' ? settled : timeline[0]![1])
  useEffect(() => {
    if (motion === 'reduce') { setValue(settled); return }
    const started = performance.now()
    const tick = () => {
      const at = ((performance.now() - started) / 1000) % loop
      setValue([...timeline].reverse().find(([from]) => from <= at)?.[1] ?? timeline[0]![1])
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [timeline, loop, motion, settled])
  return value
}

export const RunShowcase = ({ motion }: { motion?: 'reduce' }) => {
  const scene = useLoop(RUN, RUN_LOOP, motion)
  const source = useMemo(() => flowOverlayFixture(scene), [scene])
  return (
    <div data-showcase="run" className="flex h-full min-h-0 flex-col bg-background p-5 text-foreground">
      <FlowGraph title="The path this Run took" model={source.model} overlay={source.overlay} faces={FACES} doing={DOING} />
    </div>
  )
}

type Patchable = AppStore & { patch: (partial: Partial<AppSnapshot>) => void }

const NOW = Date.now()
const MINUTE = 60_000
const holder = (runtime: string, sessionId: string, minutes: number) => ({ runtime: runtimeId(runtime), sessionId, at: NOW - minutes * MINUTE })
const job = (id: number, title: string, minutes: number, over: Partial<Intent> = {}): Intent => ({ id, title, detail: null, state: 'done', files: [], dependsOn: [], claim: null,
  blockedReason: null, handoff: null, note: null, createdAt: NOW - (minutes + 20) * MINUTE, updatedAt: NOW - minutes * MINUTE, ...over })

/** Twelve jobs across the five columns; every fact on a card is one the board really draws. */
const JOBS: readonly Intent[] = [
  ...EVIDENCE_TEAM.intents.filter(card => card.id !== 7).map((card, index) => ({ ...card, createdAt: NOW - (90 - index * 8) * MINUTE, updatedAt: NOW - (4 + index * 7) * MINUTE })),
  job(8, 'Add jitter to the backoff', 12, { state: 'open' }),
  job(9, 'Document the retry policy', 9, { state: 'open' }),
  job(10, 'Review the idempotent receiver', 3, { state: 'claimed', claim: holder('claude', 'k1', 3) }),
  job(11, 'Cap retries at five attempts', 52),
  job(12, 'Log each retry with its reason', 41),
  job(13, 'Test the 502 path end to end', 6),
]
const MORE = [
  cardEvidence(11, [checkView({ card: 11 }), ciView(['passed', 'passed', 'passed'], { card: 11 }), prView('merged', { number: 11, card: 11 }), diffView({ card: 11 })]),
  cardEvidence(12, [checkView({ card: 12 }), ciView(['passed', 'passed', 'passed'], { card: 12 }), prView('merged', { number: 12, card: 12 }), diffView({ card: 12 })]),
  cardEvidence(13, [prView('open', { number: 15, card: 13 })], [{ name: 'verify', since: NOW - 2 * MINUTE }]),
]

/** Its evidence arrives with the finish: the check passed and a pull request is open, so the job moves to Ready. */
const evidenceAt = (stage: number) => ({ ...EVIDENCE_BOARD, cards: [...EVIDENCE_BOARD.cards.filter(one => stage < 2 || one.card !== 4), ...MORE,
  ...(stage >= 2 ? [cardEvidence(4, [checkView({ card: 4 }), ciView(['passed', 'passed', 'passed'], { card: 4 }), prView('open', { number: 16, card: 4 }), diffView({ card: 4 })])] : [])] })

/** The board as the fixture records it, then the next job taken up and the working one finished. */
const boardAt = (stage: number): TeamState => ({
  ...EVIDENCE_TEAM,
  name: 'Checkout hardening',
  intents: JOBS.map(card => {
    if (card.id === 5 && stage >= 1) return { ...card, state: 'claimed' as const, claim: holder('codex', 'c1', 0) }
    if (card.id === 4 && stage >= 2) return { ...card, state: 'done' as const, claim: null, outcome: 'published', note: 'Done: the receiver now ignores a delivery it has seen.' }
    return card
  }),
})

export const boardShowcaseStore = (theme: 'light' | 'dark'): Patchable => {
  const store = previewStore({ teams: new Map([[EVIDENCE_ROOM, boardAt(0)]]), boardEvidence: new Map([[EVIDENCE_ROOM, evidenceAt(0)]]) }) as Patchable
  store.setTheme(theme)
  return store
}

export const BoardShowcase = ({ store, motion }: { store: Patchable; motion?: 'reduce' }) => {
  const stage = useLoop(BOARD, BOARD_LOOP, motion)
  useEffect(() => { store.patch({ teams: new Map([[EVIDENCE_ROOM, boardAt(stage)]]), boardEvidence: new Map([[EVIDENCE_ROOM, evidenceAt(stage)]]) }) }, [store, stage])
  return (
    <div data-showcase="board" className="h-full bg-background text-foreground">
      <StoreProvider store={store}><TeamViewFrame room={EVIDENCE_ROOM} page="board"><TeamBoardPane room={EVIDENCE_ROOM} /></TeamViewFrame></StoreProvider>
    </div>
  )
}
