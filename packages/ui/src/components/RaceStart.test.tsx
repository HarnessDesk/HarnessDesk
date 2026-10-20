import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FlowPolicy } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { RaceStart } from './RaceStart'
import { TEAM_START_POLICIES } from '../preview/team-start-fixture'
import { canvasDOM } from '../test/flow-canvas-dom'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('takes /race through New Team with its task and ordinary preview token, then opens the Team', async () => {
  canvasDOM()
  await import('../design/patterns/FlowCanvas/Engine')
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
  try {
    await act(async () => root.render(<StoreProvider store={store}><RaceStart root="/repo" task="Fix the cart total" onClose={close} /></StoreProvider>))
    expect(document.querySelector<HTMLTextAreaElement>('[aria-label="What should both try?"]')?.value).toBe('Fix the cart total')
    expect(document.body.textContent).not.toContain('Race an Agent against itself')
    const chooseJudge = async (value: string) => {
      if (!document.querySelector('[aria-label="Judge configuration"]')) {
        const configure = document.querySelector<HTMLButtonElement>('[aria-label="Configure Judge"]')!
        await act(async () => configure.click())
      }
      const judge = document.querySelector<HTMLButtonElement>('[aria-label="Runtime for Judge"]')!
      expect(judge).not.toBeNull()
      await act(async () => judge.click())
      const name = value ? 'Runtime 1' : 'You'
      const choice = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === name)!
      await act(async () => choice.click())
    }
    await chooseJudge('alpha')
    const chosen = () => JSON.parse((request.mock.calls.filter(call => call[0] === 'authoring/start/preview').at(-1)![1] as { source: string }).source) as FlowPolicy
    expect(chosen().roles.find(role => role.id === 'judge')).toMatchObject({ seats: [{ runtime: 'alpha' }], independentOf: [] })
    expect(chosen().rules.find(rule => rule.id === 'to-referee')?.then.detail).toContain('{{evidence.review.at}}')
    await chooseJudge('')
    expect(chosen().roles.some(role => role.id === 'judge')).toBe(false)
    expect(chosen().roles.find(role => role.id === 'referee')).toMatchObject({ review: true })
    await chooseJudge('alpha')
    if (!document.querySelector('[aria-label="Judge configuration"]')) {
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Configure Judge"]')!.click())
    }
    await act(async () => document.querySelector('[aria-label="Judge configuration"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[aria-label="Judge configuration"]')).toBeNull()
    const start = [...document.querySelectorAll('button')].find(one => one.textContent === 'Start Team')!
    expect(start.disabled).toBe(false)
    await act(async () => start.click())
    expect(request.mock.calls.find(call => call[0] === 'flow/start-goal')?.[1]).toMatchObject({ root: '/repo', token: 'fresh-preview', vars: { task: 'Fix the cart total' } })
    expect((request.mock.calls.find(call => call[0] === 'flow/start-goal')![1] as { source: string }).source).toBe((request.mock.calls.filter(call => call[0] === 'authoring/start/preview').at(-1)![1] as { source: string }).source)
    expect(open).toHaveBeenCalledWith('race-team')
    expect(close).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
})
