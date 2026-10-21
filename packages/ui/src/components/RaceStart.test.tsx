import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { FlowPolicy } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { RaceStart } from './RaceStart'
import { TEAM_START_POLICIES } from '../preview/team-start-fixture'
import { canvasDOM } from '../test/flow-canvas-dom'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Load the real canvas engine as suite setup, just like FrontDoor's suite.
// A cold transform must not consume the interaction test's five-second budget.
beforeAll(async () => {
  canvasDOM()
  await import('../design/patterns/FlowCanvas/Engine')
})

// Each test restores globals, so every independent journey needs its canvas DOM.
beforeEach(() => canvasDOM())
let unmount = () => {}
afterEach(() => {
  unmount()
  unmount = () => {}
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const mountRace = async () => {
  const store = new AppStore('ws://localhost:0/')
  const open = vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  const close = vi.fn()
  Object.assign(store.getSnapshot(), { runtimes: [{ id: 'alpha', presentation: { name: 'Runtime 1' }, capabilities: {} }], accountsByRuntime: { alpha: { accounts: [{ kind: 'opaque', label: 'Signed in' }], signInMethods: [] } } })
  const source = JSON.stringify(TEAM_START_POLICIES.comparison)
  const execution = { id: 'race-run', goal: 'race-team' }
  const request = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'flow/catalog') return [{ id: 'comparison', origin: 'project', name: 'Side by side', problem: null }]
    if (method === 'flow/source') return source
    if (method === 'agent/list' || method === 'runtime/models') return []
    if (method === 'authoring/shape/render') return { source: JSON.stringify((params as { policy: FlowPolicy }).policy), issues: [] }
    if (method === 'authoring/start/preview') {
      const input = params as { source: string; vars: Record<string, string> }
      return { source: input.source, vars: input.vars, sentence: 'Compare attempts', goal: null,
        target: { label: 'this project', head: null, base: null, dirty: false, independence: 'unknown' },
        flow: { token: 'fresh-preview', compiled: { document: { format: 'agents', flow: JSON.parse(input.source) }, bindings: [], problems: [] }, seats: [], commands: [], guards: [], problems: [], messaging: 'board-only' } }
    }
    if (method === 'flow/start-goal') return execution
    return null
  }) as never)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  unmount = () => { act(() => root.unmount()); container.remove() }
  await act(async () => root.render(<StoreProvider store={store}><RaceStart root="/repo" task="Fix the cart total" onClose={close} /></StoreProvider>))
  const previewSource = () => (request.mock.calls.filter(call => call[0] === 'authoring/start/preview').at(-1)![1] as { source: string }).source
  const chosen = () => JSON.parse(previewSource()) as FlowPolicy
  const configureJudge = async () => {
    if (!document.querySelector('[aria-label="Judge configuration"]')) {
      const configure = document.querySelector<HTMLButtonElement>('[aria-label="Configure Judge"]')!
      await act(async () => configure.click())
    }
  }
  const chooseJudge = async (value: 'alpha' | 'you') => {
    await configureJudge()
    const judge = document.querySelector<HTMLButtonElement>('[aria-label="Runtime for Judge"]')!
    expect(judge).not.toBeNull()
    await act(async () => judge.click())
    const name = value === 'alpha' ? 'Runtime 1' : 'You'
    const choice = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === name)!
    await act(async () => choice.click())
  }
  const startTeam = async () => {
    const source = previewSource()
    const start = [...document.querySelectorAll('button')].find(one => one.textContent === 'Start Team')!
    expect(start.disabled).toBe(false)
    await act(async () => start.click())
    const starts = request.mock.calls.filter(call => call[0] === 'flow/start-goal')
    expect(starts).toHaveLength(1)
    expect(starts[0]![1]).toMatchObject({ root: '/repo', token: 'fresh-preview', vars: { task: 'Fix the cart total' }, source })
    expect(open).toHaveBeenCalledExactlyOnceWith('race-team')
    expect(close).toHaveBeenCalledOnce()
  }
  return { chosen, chooseJudge, configureJudge, startTeam }
}

it('takes /race through New Team with its task and ordinary preview token, then opens the Team', async () => {
  const race = await mountRace()
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="What should both try?"]')?.value).toBe('Fix the cart total')
  expect(document.body.textContent).not.toContain('Race an Agent against itself')
  await race.startTeam()
})

it('routes an enabled Judge to the referee, closes configuration with Escape, and starts that Flow', async () => {
  const race = await mountRace()
  await race.chooseJudge('alpha')
  expect(race.chosen().roles.find(role => role.id === 'judge')).toMatchObject({ seats: [{ runtime: 'alpha' }], independentOf: [] })
  expect(race.chosen().rules.find(rule => rule.id === 'to-referee')?.then.detail).toContain('{{evidence.review.at}}')
  await race.configureJudge()
  await act(async () => document.querySelector('[aria-label="Judge configuration"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[aria-label="Judge configuration"]')).toBeNull()
  await race.startTeam()
})

it('removes an enabled Judge when You is selected and starts with human review', async () => {
  const race = await mountRace()
  await race.chooseJudge('alpha')
  expect(race.chosen().roles.some(role => role.id === 'judge')).toBe(true)
  await race.chooseJudge('you')
  expect(race.chosen().roles.some(role => role.id === 'judge')).toBe(false)
  expect(race.chosen().roles.find(role => role.id === 'referee')).toMatchObject({ review: true })
  await race.startTeam()
})
