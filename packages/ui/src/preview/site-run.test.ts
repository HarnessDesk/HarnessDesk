import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { StagedRun, RUN_STAGES, runTimeSegments } from '../../site-demo/fake-run'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { StoreProvider } from '../state/context'
import { flowOverlay } from '../lib/flow-overlay'
import { flowModel } from '../lib/flow-model'

afterEach(() => vi.useRealTimers())

describe('the site Run', () => {
  it('plays the recorded review loop once and leaves the person step waiting', () => {
    vi.useFakeTimers()
    const run = new StagedRun('write')
    run.play()
    run.play()
    for (const stage of RUN_STAGES.slice(0, -1)) {
      expect(run.stage).toBe(stage)
      const { execution, cards, attempts } = run.read()
      const model = flowModel(execution.document.flow)
      const overlay = flowOverlay({ execution, cards, attempts, model })
      const role = execution.rounds.at(-1)!.role
      expect(overlay.steps.get(role)?.state).toBe(stage === 'you' ? 'waiting' : 'working')
      if (stage === 'fix') {
        expect(cards.filter(card => execution.rounds[2]!.cards.includes(card.id)).map(card => card.outcome)).toEqual(['request-changes', 'request-changes'])
        expect(run.read().findingRun.rounds.find(round => round.round === 3)?.state).toBe('posted')
      }
      vi.advanceTimersByTime(3500)
    }
    expect(run.stage).toBe('you')
    run.dispose()
  })

  it('answers the Needs-you card through the production store verb and refuses stale answers', async () => {
    const run = new StagedRun('you')
    const card = run.read().execution.rounds.at(-1)!.cards[0]!
    await expect(run.store.teamIntent('overlay-team', card, 'done', undefined, 'invented')).rejects.toThrow('Choose one of')
    await expect(run.store.teamIntent('other-team', card, 'done', undefined, 'merged')).rejects.toThrow('staged Run')
    await run.store.teamIntent('overlay-team', card, 'done', undefined, 'merged', 'Ready to ship')
    expect(run.read().execution.state).toBe('settled')
    expect(run.read().cards.find(one => one.id === card)).toMatchObject({ state: 'done', outcome: 'merged', note: 'Ready to ship' })
    const finished = run.read()
    expect(runTimeSegments(finished.execution, finished.cards, finished.now).at(-1)?.ms).toBe(60_000)
    await expect(run.store.teamIntent('overlay-team', card, 'done', undefined, 'merged')).rejects.toThrow('already answered')
    run.dispose()
  })

  it('does not play automatically under reduced motion and cancels pending moves on disposal', () => {
    vi.useFakeTimers()
    const run = new StagedRun('write')
    run.play(true)
    vi.advanceTimersByTime(60_000)
    expect(run.stage).toBe('write')
    run.next()
    expect(run.stage).toBe('check')
    run.play()
    run.dispose()
    vi.advanceTimersByTime(60_000)
    expect(run.stage).toBe('check')
  })

  it('uses one wall-time segment per round, without doubling two reviewers', () => {
    const run = new StagedRun('fix')
    const data = run.read()
    const segments = runTimeSegments(data.execution, data.cards, data.now)
    expect(segments.map(one => one.role)).toEqual(['write', 'check', 'review', 'fix'])
    expect(segments.map(one => one.ms / 60_000)).toEqual([11, 3, 6, 2])
    expect(segments.reduce((total, one) => total + one.ms, 0)).toBe(22 * 60_000)
    run.dispose()
  })

  it('retains an earlier check attempt while the repeated check is working', () => {
    const run = new StagedRun('check-again')
    expect(run.read().attempts.get(50)?.attempts.map(one => one.id)).toEqual(['earlier-result-50'])
    run.dispose()
  })

  it('pauses and resumes without a second playback timer', () => {
    vi.useFakeTimers()
    const run = new StagedRun('write')
    run.play()
    run.pause()
    vi.advanceTimersByTime(3500)
    expect(run.stage).toBe('write')
    run.play()
    run.play()
    vi.advanceTimersByTime(3500)
    expect(run.stage).toBe('check')
    run.dispose()
  })

  it('lets the mounted production Overview answer the staged person step and read both posted review rounds', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const run = new StagedRun('you')
    const box = document.createElement('div')
    const root = createRoot(box)
    const button = (name: string) => [...box.querySelectorAll('button')].find(one => one.textContent === name)
    try {
      await act(async () => root.render(createElement(StoreProvider, { store: run.store,
        children: createElement(TeamRoomPane, { room: 'overlay-team' }) })))
      expect(box.querySelector('[data-slot="team-overview"]')).not.toBeNull()
      expect(button('Merged')).toBeDefined()
      await act(async () => button('Merged')!.click())
      expect(run.stage).toBe('done')
      expect(button('Merged')).toBeUndefined()
      await act(async () => button('Write, review, land')!.click())
      for (const round of [3, 6]) {
        expect([...box.querySelectorAll(`[data-kind="card"][data-row^="card-${round}-"]`)].filter(one => one.textContent?.includes('Posted to #42'))).toHaveLength(2)
      }
    } finally { act(() => root.unmount()); run.dispose() }
  })
})
