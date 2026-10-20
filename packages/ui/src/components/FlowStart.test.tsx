import { EDIT_TEAM_START_POLICY } from '../preview/front-door-edit-fixture'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, CompiledFlow, FlowEntry, FlowPolicy, FlowPreview, FlowPreviewSeat, SeatCandidate, SeatPlan } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot } from '../state/snapshot'
import type { AppStore } from '../state/store'
import { FlowStart, type FlowChoice } from './FlowStart'
import { TEAM_START_POLICIES } from '../preview/team-start-fixture'
import { withAttemptCheck } from '../lib/team-start'
import { CONTEST_START_POLICY } from '../lib/contest-start-fixture'
import { canvasDOM } from '../test/flow-canvas-dom'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  canvasDOM()
  await import('../design/patterns/FlowCanvas/Engine')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const AGENT = (id: string, name: string): AgentEntry => ({
  id, origin: 'project', path: `/repo/.harnessdesk/agents/${id}/AGENT.md`, problems: [], shadows: [],
  definition: { name, description: null, ceiling: 'edit', ceilingFrom: 'ceiling', answers: [], prefer: [], order: '' } as unknown as AgentEntry['definition'],
  digest: 'd1',
})

const candidate = (over: Partial<SeatCandidate> = {}): SeatCandidate => ({
  seat: { runtime: 'codex' }, label: 'Codex', runtimeName: 'Codex', state: 'passed',
  reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'codex' }, ...over,
})

const compiled = (extra: Partial<CompiledFlow['document']> = {}): CompiledFlow => ({
  document: {
    format: 'agents',
    flow: { version: 2, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240 },
    ...extra,
  } as CompiledFlow['document'],
  bindings: [], problems: [],
})

const emptyPreview = (): FlowPreview => ({ token: 't', compiled: compiled(), seats: [], commands: [], guards: [], messaging: 'board-only', problems: [] })

const store = (options: {
  readonly entries: readonly FlowEntry[]
  readonly agents?: readonly AgentEntry[]
  readonly runtimes?: ReturnType<typeof emptySnapshot>['runtimes']
  readonly source: (id: string) => Promise<string> | string
  readonly preview: (source: string) => Promise<FlowPreview> | FlowPreview
}): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: (() => { const snapshot = { ...emptySnapshot(), runtimes: options.runtimes ?? [] }; return () => snapshot })(),
    flowGeneration: () => 0,
    flowCatalog: vi.fn().mockResolvedValue(options.entries),
    agentsIn: vi.fn().mockResolvedValue(options.agents ?? []),
    flowSource: vi.fn((_root: string, id: string) => Promise.resolve(options.source(id))),
    previewFlow: vi.fn((_root: string, source: string) => Promise.resolve(options.preview(source))),
    modelsFor: vi.fn().mockResolvedValue([]),
  }) as unknown as AppStore

const ENTRY = (id: string): FlowEntry => ({ id, origin: 'project', path: `.harnessdesk/flows/${id}.yml`, name: id, description: null, format: 'agents', problem: null, shadows: [] })

const seat = (role: string, reviews: boolean): FlowPreviewSeat => ({
  role, index: 0, agent: role, isolate: false, reviews,
  plan: { id: role, from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'held' },
    candidates: [candidate({ seat: { runtime: 'gamma' }, label: 'Gamma', runtimeName: 'Gamma', state: 'taken', reason: null, fix: null })] } as SeatPlan,
})

const ATTACHMENT = (name: string, problem: string | null, kind: 'skill' | 'mcp' | 'notes' = 'skill') => ({ kind, name, identity: null, problem })

const attachments = (over: Partial<NonNullable<FlowPreviewSeat['attachments']>> = {}): NonNullable<FlowPreviewSeat['attachments']> => ({
  skillsMode: 'allowlist', mcpMode: 'allowlist',
  declarations: [ATTACHMENT('checkout-retries', null), ATTACHMENT('review-checklist', null), ATTACHMENT('browser', null, 'mcp')],
  refusal: null,
  ...over,
})

/** The line under a seat that says what its Agent would carry in. */
const seatLines = (): readonly HTMLElement[] => [...container.querySelectorAll('[data-slot="row"]')]
  .filter((one): one is HTMLElement => one.querySelector('[data-role="meta"]')?.textContent?.startsWith('Skills:') ?? false)

const renderTeam = async (flow: FlowPolicy, seats: readonly FlowPreviewSeat[], runtimes: ReturnType<typeof emptySnapshot>['runtimes'] = []) => {
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes })
  const preview = { ...emptyPreview(), seats }
  await act(async () => {
    root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{
      flow, template: flow, preview, roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy: () => {},
    }} /></StoreProvider>)
  })
}

it('shows one compact role configuration with its resolved model and instructions', async () => {
  const policy = TEAM_START_POLICIES['fix-and-review']
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview,
    runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  vi.mocked(theStore.modelsFor).mockResolvedValue([{ id: 'large', displayName: 'Large model', isDefault: true, hidden: false, reasoningLevels: [], supportsImages: false }])
  const writer = { ...seat('fixer', false), agent: 'builder' }
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: policy, template: policy,
    preview: { ...emptyPreview(), seats: [writer] }, roster: new Map([['builder', AGENT('builder', 'Builder instructions')]]), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy: () => {},
  }} /></StoreProvider>))
  expect(container.querySelectorAll('[aria-label="Configure Writes"]')).toHaveLength(1)
  expect(container.querySelector('[data-step="fixer"] [aria-label="Configure Writes"]')).not.toBeNull()
  expect(container.querySelectorAll('[data-slot="flow-graph"]')).toHaveLength(1)
  expect(container.querySelector('[aria-label="Configure Writes"]')?.textContent).toContain('Gamma · Large model')
  expect(container.textContent).toContain('Builder instructions')
  expect(document.querySelector('[aria-label="Runtime for Writes"]')).toBeNull()
  expect(document.querySelector('[aria-label="Model for Writes"]')).toBeNull()
  expect(document.querySelector('[aria-label="Effort for Writes"]')).toBeNull()
})

it('edits the exact role policy from its local configuration and preserves automatic picks until changed', async () => {
  const template = TEAM_START_POLICIES['fix-and-review']
  let current: FlowPolicy = template
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview,
    runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } }, { id: 'delta', presentation: { name: 'Delta' } }] as never })
  vi.mocked(theStore.modelsFor).mockResolvedValue([{ id: 'large', displayName: 'Large model', isDefault: true, hidden: false, reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: false }])
  const onPolicy = vi.fn((policy: FlowPolicy) => { current = policy; paint() })
  const paint = () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: current, template,
    preview: { ...emptyPreview(), seats: [{ ...seat('fixer', false), agent: 'builder' }] }, roster: new Map([['builder', AGENT('builder', 'Builder')], ['tester', AGENT('tester', 'Test writer')]]), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy,
  }} /></StoreProvider>)
  await act(async () => paint())
  const configure = container.querySelector<HTMLButtonElement>('[aria-label="Configure Writes"]')!
  await act(async () => configure.click())
  expect(onPolicy).not.toHaveBeenCalled()
  const pick = async (label: string, words: string) => {
    await act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label} for Writes"]`)!.click())
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === words)!.click())
  }
  await pick('Model', 'Large model')
  expect(current.roles.find(role => role.id === 'fixer')).toMatchObject({ seats: [{ runtime: 'gamma', model: 'large' }] })
  await pick('Effort', 'High')
  expect(current.roles.find(role => role.id === 'fixer')).toMatchObject({ seats: [{ runtime: 'gamma', model: 'large', effort: 'high' }] })
  const instructions = document.querySelector<HTMLSelectElement>('[aria-label="Instructions for fixer 1"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(instructions, 'tester')
    instructions.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(current.roles.find(role => role.id === 'fixer')).toMatchObject({ uses: ['tester'], seats: [{ runtime: 'gamma', model: 'large', effort: 'high' }] })
  await pick('Runtime', 'Delta')
  expect(current.roles.find(role => role.id === 'fixer')).toMatchObject({ uses: ['tester'], seats: [{ runtime: 'delta' }] })
})

it('shows pinned model and effort from the automatic winner without making the role explicit', async () => {
  const policy = TEAM_START_POLICIES['fix-and-review']
  const writer = seat('fixer', false)
  const pinned = { runtime: 'gamma', model: 'pinned', effort: 'high' }
  const onPolicy = vi.fn()
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview,
    runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  vi.mocked(theStore.modelsFor).mockResolvedValue([
    { id: 'default', displayName: 'Default catalog model', isDefault: true, hidden: false, reasoningLevels: [], supportsImages: false },
    { id: 'pinned', displayName: 'Pinned model', hidden: false, reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: false },
  ])
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: policy, template: policy,
    preview: { ...emptyPreview(), seats: [{ ...writer, plan: { ...writer.plan, candidates: [candidate({ seat: pinned, state: 'taken', reason: null })] } }] },
    roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy,
  }} /></StoreProvider>))
  expect(container.querySelector('[aria-label="Configure Writes"]')?.textContent).toContain('Gamma · Pinned model')
  await openConfiguration('Writes')
  expect(document.querySelector('[aria-label="Model for Writes"]')?.textContent).toBe('Pinned model')
  expect(document.querySelector('[aria-label="Effort for Writes"]')?.textContent).toBe('High')
  expect(onPolicy).not.toHaveBeenCalled()
  expect(policy.roles.find(role => role.id === 'fixer')).toMatchObject({ seats: [] })
})

it('keeps a saved effort available to clear after a model stops offering effort levels', async () => {
  const base = TEAM_START_POLICIES['fix-and-review']
  const policy: FlowPolicy = { ...base, roles: base.roles.map(role => role.id === 'fixer' && role.kind === 'agent'
    ? { ...role, seats: [{ runtime: 'gamma', model: 'plain', effort: 'retired' }] } : role) }
  const onPolicy = vi.fn()
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview,
    runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  vi.mocked(theStore.modelsFor).mockResolvedValue([{ id: 'plain', displayName: 'Plain model', isDefault: true, hidden: false, reasoningLevels: [], supportsImages: false }])
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: policy, template: policy,
    preview: { ...emptyPreview(), seats: [seat('fixer', false)] }, roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy,
  }} /></StoreProvider>))
  await openConfiguration('Writes')
  const effort = document.querySelector<HTMLButtonElement>('[aria-label="Effort for Writes"]')
  expect(effort).not.toBeNull()
  expect(effort?.textContent).toBe('retired')
  await act(async () => effort!.click())
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === 'Default effort')!.click())
  expect(onPolicy.mock.lastCall?.[0].roles.find((role: FlowPolicy['roles'][number]) => role.id === 'fixer')).toMatchObject({ seats: [{ runtime: 'gamma', model: 'plain', effort: undefined }] })
})


const openConfiguration = async (label: string): Promise<void> => {
  if (document.querySelector(`[aria-label="${label} configuration"]`)) return
  await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="Configure ${label}"]`)!.click())
}

it('gives the selected agent name a tooltip in the seat controls', async () => {
  await renderTeam(TEAM_START_POLICIES.comparison, [seat('judge', true)], [{ id: 'gamma', presentation: { name: 'Gamma' } } as never])
  await openConfiguration('Judge')
  expect(document.querySelector<HTMLButtonElement>('button[aria-label="Runtime for Judge"]')?.title).toBe('Gamma')
})

it('shows what Automatic resolves to, or that no agent can run', async () => {
  const resolved: FlowPreviewSeat = {
    role: 'fixer', index: 0, agent: 'builder', isolate: false, reviews: false,
    plan: { id: 'builder', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'held' }, candidates: [
      candidate({ seat: { runtime: 'codex' }, label: 'Codex', runtimeName: 'Codex', state: 'taken', reason: null, fix: null }),
    ] } as SeatPlan,
  }
  const unavailable: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'prefer', winner: null, blocked: null, ceiling: null, candidates: [
      candidate({ seat: { runtime: 'windsurf' }, label: 'Windsurf', runtimeName: 'Windsurf', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'windsurf' } }),
    ] } as SeatPlan,
  }
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [resolved, unavailable], [{ id: 'codex', presentation: { name: 'Codex' } } as never])

  const writes = container.querySelector<HTMLButtonElement>('button[aria-label="Configure Writes"]')!
  const reviews = container.querySelector<HTMLButtonElement>('button[aria-label="Configure Reviews"]')!
  expect(writes.textContent).toBe('Codex')
  expect(reviews.textContent).toBe('Nothing can run')
})

it('marks a reviewer that returns to the seed role as fresh each round', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [seat('reviewer', true)])
  expect(container.textContent).toContain('Fresh each round')
})

it('does not describe a one-off judge as fresh each round', async () => {
  await renderTeam(TEAM_START_POLICIES.comparison, [seat('judge', true)])
  expect(container.textContent).not.toContain('Fresh each round')
})

// Four real graph/configuration transitions take about five seconds on CI.
// Keep the whole interaction sequence and allow a bounded runner margin.
it.each([false, true])('keeps the attempt check editable when empty, including a saved checked template (%s)', async checked => {
  const original: FlowPolicy = TEAM_START_POLICIES.comparison
  const baseline = { ...original, roles: original.roles.filter(role => role.kind !== 'check'), rules: [
    { id: 'to-judge', on: 'competitor', then: { role: 'judge', title: 'Pick the best attempt' } },
    ...original.rules.filter(rule => rule.on === 'judge'),
  ] }
  const template = checked ? withAttemptCheck(baseline, baseline, 'npm test') : baseline
  let current: FlowPolicy = template
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  const onPolicy = (policy: FlowPolicy) => { current = policy; paint() }
  const paint = () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: current, template, preview: emptyPreview(), roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy }} /></StoreProvider>)
  act(paint)
  const label = [...container.querySelectorAll('label')].find(one => one.textContent?.includes('Check each attempt with'))
  expect(label).toBeDefined()
  const field = document.getElementById(label!.htmlFor) as HTMLInputElement
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  type('npm test')
  expect(current.roles.find(role => role.id === 'verify')).toMatchObject({ kind: 'check', check: { run: 'npm test' } })
  expect(current.rules.find(rule => rule.id === 'to-judge')).toMatchObject({ on: 'verify', when: { any: ['pass'] } })
  type('')
  expect(current.roles.some(role => role.kind === 'check')).toBe(false)
  expect(current.rules.find(rule => rule.id === 'to-judge')).toMatchObject({ on: 'competitor', then: { role: 'judge' } })
  expect(current.rules.find(rule => rule.id === 'to-judge')?.when).toBeUndefined()
  expect(container.textContent).toContain('Leave empty to let the judge read the attempts directly.')
  const judge = async () => {
    await openConfiguration('Judge')
    const select = document.querySelector<HTMLButtonElement>('button[aria-label="Runtime for Judge"]')!
    const name = current.roles.some(role => role.id === 'judge') ? 'You' : 'Gamma'
    await act(async () => select.click())
    const choice = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === name)!
    await act(async () => choice.click())
  }
  await judge()
  expect(current.rules.find(rule => rule.id === 'to-person')).toMatchObject({ on: 'competitor', then: { role: 'referee' } })
  await judge()
  expect(current.rules.find(rule => rule.id === 'to-judge')?.when).toBeUndefined()
  await judge()
  type('node check.mjs')
  expect(current.rules.find(rule => rule.id === 'to-person')).toMatchObject({ on: 'verify', when: { any: ['pass'] } })
  await judge()
  expect(current.rules.filter(rule => rule.on === 'competitor').map(rule => rule.then.role)).toEqual(['verify'])
  expect(current.rules.find(rule => rule.id === 'to-judge')).toMatchObject({ on: 'verify', when: { any: ['pass'] } })
  await act(async () => {})
}, 10_000)

it('offers the same optional attempt check for a contest without a judge', async () => {
  const template = CONTEST_START_POLICY
  await renderTeam(template, [])
  expect(container.querySelector('[aria-label="A judge picks the better one"]')).toBeNull()
  const label = [...container.querySelectorAll('label')].find(one => one.textContent?.includes('Check each attempt with'))
  expect(label).toBeDefined()
  expect(container.textContent).toContain('Leave empty to choose from the attempts directly.')
})

it('keeps a saved custom check’s success and incoming guards through clearing, restoring and judge toggles', async () => {
  const base: FlowPolicy = TEAM_START_POLICIES.comparison
  const success = { any: ['clean'], evidence: [{ check: 'verify' }] }
  const template: FlowPolicy = { ...base, roles: [base.roles[0]!, {
    id: 'verify', kind: 'check', check: { run: 'node original.mjs', timeout: 37, exits: { '0': 'clean' }, otherwise: 'bad' },
  }, ...base.roles.slice(1)], rules: [
    { id: 'project-check', on: 'competitor', when: { every: ['published'] }, then: { role: 'verify', title: 'Check the attempts' } },
    { id: 'retry', on: 'verify', when: { any: ['bad'] }, then: { role: 'competitor', title: 'Repair the attempts' } },
    { id: 'to-judge', on: 'verify', when: success, then: { role: 'judge', title: 'Pick the best attempt' } },
    ...base.rules.filter(rule => rule.on === 'judge'),
  ] }
  let current: FlowPolicy = template
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  const onPolicy = (flow: FlowPolicy) => { current = flow; paint() }
  const paint = () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: current, template, preview: emptyPreview(), roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy }} /></StoreProvider>)
  act(paint)
  const label = [...container.querySelectorAll('label')].find(one => one.textContent?.includes('Check each attempt with'))!
  const field = document.getElementById(label.htmlFor) as HTMLInputElement
  const type = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const toggle = async () => {
    await openConfiguration('Judge')
    const select = document.querySelector<HTMLButtonElement>('button[aria-label="Runtime for Judge"]')!
    const name = current.roles.some(role => role.id === 'judge') ? 'You' : 'Gamma'
    await act(async () => select.click())
    const choice = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(one => one.textContent === name)!
    await act(async () => choice.click())
  }
  type('')
  await toggle()
  expect(current.rules.find(rule => rule.id === 'to-person')?.when).toEqual({ every: ['published'] })
  await toggle()
  expect(current.rules.find(rule => rule.id === 'to-judge')?.when).toEqual({ every: ['published'] })
  type('node replacement.mjs')
  await toggle()
  expect(current.rules.find(rule => rule.id === 'to-person')?.when).toEqual(success)
  await toggle()
  expect(current.rules.find(rule => rule.id === 'to-judge')?.when).toEqual(success)
  expect(current.rules.find(rule => rule.id === 'retry')).toEqual(template.rules.find(rule => rule.id === 'retry'))
  await act(async () => {})
}, 10_000)

it('the review options preserve the review cap and require recorded approval before automatic merging', async () => {
  const flow: import('@harnessdesk/protocol').FlowPolicy = TEAM_START_POLICIES['fix-and-review']
  let current = flow
  const onPolicy = vi.fn((next: import('@harnessdesk/protocol').FlowPolicy) => { current = next; paint() })
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  const paint = () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow: current, template: flow, preview: emptyPreview(), roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy }} /></StoreProvider>)
  act(paint)
  const press = (label: string) => act(() => [...container.querySelectorAll('button')].find(one => one.textContent === label)!.click())
  for (const rounds of [1, 2, 3]) {
    press(String(rounds))
    expect(onPolicy.mock.lastCall?.[0].budget?.rounds).toBe(rounds * 2 + 1)
  }
  press('Merge it')
  const automatic = onPolicy.mock.lastCall?.[0] as import('@harnessdesk/protocol').FlowPolicy
  expect(automatic.roles.find(role => role.id === 'referee')).toMatchObject({ kind: 'agent', uses: ['merger'], grant: 'merge' })
  expect(automatic.rules.find(rule => rule.then.role === 'referee')?.when).toEqual({ evidence: [{ review: 'approve' }, { pr: 'open' }] })
  press('Wait for me')
  expect(onPolicy.mock.lastCall?.[0].roles.find(role => role.id === 'referee')).toMatchObject({ kind: 'person' })
})

it('keeps a mechanically checked review on its declared path to a person', () => {
  const flow = TEAM_START_POLICIES['review-pr']
  const onPolicy = vi.fn()
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  act(() => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow, template: flow, preview: emptyPreview(), roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy }} /></StoreProvider>))
  expect(container.querySelector('[aria-label="When the review approves"]')).toBeNull()
  expect(container.querySelector('[aria-label="Review rounds, at most"]')).toBeNull()
  expect(flow.rules.find(rule => rule.then.role === 'referee')?.when).toEqual({ every: ['passed'], evidence: [{ pr: 'open' }] })
  expect(onPolicy).not.toHaveBeenCalled()
})

it('keeps required extra variables visible and disabled while a compact form is locked', () => {
  const flow = { ...TEAM_START_POLICIES['fix-and-review'], inputs: [{ id: 'ticket', label: 'Ticket', default: '42' }] }
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  act(() => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{ flow, template: flow, preview: emptyPreview(), roster: new Map(), vars: { ticket: '42' }, disabled: true, onVar: () => {}, onReadingChange: () => {}, onPolicy: () => {} }} /></StoreProvider>))
  const input = container.querySelector<HTMLInputElement>('input')!
  expect(input.disabled).toBe(true)
  expect(input.closest('[hidden]')).toBeNull()
})

const render = (theStore: AppStore, onChange: (choice: FlowChoice | null) => void) => {
  act(() => {
    root.render(
      <StoreProvider store={theStore}>
        <FlowStart root="/repo" onChange={onChange} />
      </StoreProvider>,
    )
  })
}

const select = async (value: string): Promise<void> => {
  const control = container.querySelector('select') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('previews the recorded source and inputs without reading the current catalogue file', async () => {
  const theStore = store({ entries: [], source: () => { throw new Error('must not read'); }, preview: () => ({ ...emptyPreview(), compiled: compiled({ flow: {
    version: 2, name: 'Fix', inputs: [{ id: 'brief', label: 'Brief' }, { id: 'task', label: 'Task' }], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240,
  } }) }) })
  const initial = { source: 'frozen source', vars: { task: 'Retry', brief: 'Two\nparagraphs' }, seats: {}, attended: true }
  const change = vi.fn()
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={initial} onChange={change} /></StoreProvider>))
  expect(theStore.flowSource).not.toHaveBeenCalled()
  expect(theStore.previewFlow).toHaveBeenCalledWith('/repo', initial.source, initial.vars, { seats: {}, attended: true })
  expect(container.querySelector('textarea')!.value).toBe(initial.vars.brief)
  expect(change).toHaveBeenLastCalledWith({ source: initial.source, vars: initial.vars, token: 't', seats: {}, attended: true })
})

it('shows a continuation refusal rather than calling its empty preview an old-format Flow', async () => {
  const refusal = 'A newer Run continues this one. Start work on that Run instead.'
  const preview: FlowPreview = { ...emptyPreview(), token: null,
    compiled: { document: { format: 'legacy', flow: { name: '', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
    problems: [{ level: 'error', at: 'run', text: refusal }],
  }
  const theStore = store({ entries: [], source: () => '', preview: () => preview })
  const change = vi.fn()
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" continues="earlier" initial={{ source: 'saved', vars: {} }} onChange={change} /></StoreProvider>))
  expect(container.textContent).toContain(refusal)
  expect(container.textContent).not.toContain('This flow uses the old format')
  expect(container.textContent).not.toContain('Reading the earlier Run’s Flow')
  expect(container.textContent).not.toContain('This flow names no Agent role')
  expect(change).toHaveBeenLastCalledWith(null)
})

it('keeps the migration banner for a parsed old-format Flow without a separate format problem', async () => {
  const preview: FlowPreview = { ...emptyPreview(), token: null,
    compiled: { document: { format: 'legacy', flow: { name: 'Old Flow', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
    problems: [],
  }
  const theStore = store({ entries: [], source: () => '', preview: () => preview })
  const change = vi.fn()
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={{ source: 'saved', vars: {} }} onChange={change} /></StoreProvider>))
  expect(container.textContent).toContain('This flow uses the old format')
  expect(container.textContent).not.toContain('This flow will not run yet')
  expect(change).toHaveBeenLastCalledWith(null)
})

it('edits and resets one Seat slot while preserving every other Seat and role', async () => {
  const first = { runtime: 'alpha' }, second = { runtime: 'beta', model: 'second' }, changed = { runtime: 'alpha', effort: 'high' }
  const dry = emptyPreview()
  const slot = (index: number): FlowPreviewSeat => ({ role: 'reviewer', index, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'prefer', winner: index, blocked: null, ceiling: { level: 'read', hold: 'held' },
      candidates: [first, second, changed].map((seat, n) => candidate({ seat, label: `Choice ${n}`, runtimeName: 'Agent', state: n === index ? 'taken' : 'untried', reason: null, fix: null })) } })
  const preview = { ...dry, compiled: compiled({ flow: { version: 2, name: 'Review', inputs: [],
    roles: [{ id: 'reviewer', kind: 'agent', uses: ['reviewer'], seats: [first, second], isolate: false, grant: 'read', independentOf: [] }],
    rules: [], seed: { role: 'reviewer', title: 'Review' }, messaging: 'board-only', wait: 240 } }), seats: [slot(0), slot(1)] }
  const theStore = store({ entries: [], source: () => '', preview: () => preview })
  theStore.previewFlow = vi.fn(async (_root, _source, _vars, options) => ({ ...preview, seats: preview.seats.map(seat => {
    const chosen = options?.seats?.reviewer?.[seat.index]
    return chosen ? { ...seat, plan: { ...seat.plan, winner: 0, candidates: seat.plan.candidates.filter(candidate => JSON.stringify(candidate.seat) === JSON.stringify(chosen)) } } : seat
  }) }))
  const change = vi.fn()
  const initial = { source: 'saved', vars: {}, seats: { writer: [{ runtime: 'writer' }] }, attended: true }
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={initial} onChange={change} /></StoreProvider>))
  expect(container.querySelectorAll('select')).toHaveLength(2)
  const controls = () => [...container.querySelectorAll('select')]
  const chooseSlot = async (index: number, value: string) => act(async () => {
    const control = controls()[index]!
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await chooseSlot(0, JSON.stringify(changed))
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: { ...initial.seats, reviewer: [changed, second] }, attended: true })
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ seats: { ...initial.seats, reviewer: [changed, second] } }))
  expect([...controls()[0]!.options].map(option => option.value)).toContain(JSON.stringify(first))
  await chooseSlot(1, JSON.stringify(first))
  await chooseSlot(0, '')
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: { ...initial.seats, reviewer: [first, first] }, attended: true })
  await chooseSlot(1, '')
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: initial.seats, attended: true })
})

it('every candidate and effective ceiling remains visible', async () => {
  const seatHeld: FlowPreviewSeat = {
    role: 'fixer', index: 0, agent: 'builder', isolate: true, reviews: false,
    plan: {
      id: 'builder', from: 'prefer', winner: 2, blocked: null, ceiling: { level: 'edit', hold: 'held' },
      candidates: [
        candidate({ label: 'Cursor', runtimeName: 'Cursor', seat: { runtime: 'cursor' }, reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } }),
        candidate({ label: 'Codex', reason: { kind: 'notInstalled', added: false }, fix: { kind: 'add', runtime: 'codex' } }),
        candidate({ label: 'Claude Code', runtimeName: 'Claude Code', seat: { runtime: 'claude-code' }, state: 'taken', reason: null, fix: null }),
      ],
    } as SeatPlan,
  }
  const seatAsked: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'asked' }, candidates: [candidate({ state: 'taken', reason: null, fix: null, label: 'Codex' })] } as SeatPlan,
  }
  const preview: FlowPreview = { ...emptyPreview(), seats: [seatHeld, seatAsked] }
  const theStore = store({
    entries: [ENTRY('fix')],
    agents: [AGENT('builder', 'Builder'), AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n',
    preview: () => preview,
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  expect(container.textContent).toContain('Builder — fixer, isolated')
  expect(container.textContent).toContain('Reviewer — reviewer')
  expect(container.textContent).toContain('Cursor')
  expect(container.textContent).toContain('Codex')
  expect(container.textContent).toContain('Claude Code')
  expect(container.textContent).toContain('is signed out')
  expect(container.textContent).toContain('Sign in to Cursor')
  expect(container.textContent).toContain('is not added to HarnessDesk')

  const chips = [...container.querySelectorAll('[data-ceiling], [data-tone]')].map((one) => one.textContent)
  expect(chips).toEqual(expect.arrayContaining(['Edit', 'Read only · asked, not enforced']))
})

it('renders provider warnings, held-ceiling refusals, and additional provider reasons', async () => {
  const reviewer: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: {
      id: 'reviewer', from: 'machine', winner: null, blocked: null, ceiling: null,
      candidates: [
        candidate({
          label: 'Codex · GPT-6 Luna · Extra high',
          reason: { kind: 'sameProvider' },
          fix: { kind: 'seats' },
        }),
        candidate({
          label: 'Claude Code · Sonnet 5.5', runtimeName: 'Claude Code',
          seat: { runtime: 'claude-code', model: 'sonnet' },
          reason: { kind: 'unheld', level: 'read', detail: null }, fix: { kind: 'ceilings' },
        }),
        candidate({
          label: 'Cursor · Gamma', runtimeName: 'Cursor', seat: { runtime: 'cursor' },
          state: 'taken', reason: null, fix: null,
        }),
        candidate({
          label: 'Cursor · Delta', runtimeName: 'Cursor', seat: { runtime: 'cursor' },
          reason: { kind: 'unheld', level: 'read', detail: null }, fix: { kind: 'ceilings' },
          alsoPassed: [{ kind: 'sameProvider' }],
        }),
      ],
    } as SeatPlan,
  }
  const warning = 'Can’t confirm that Cursor uses a different provider from fixer, so independence is checked when this step is reached.'
  const preview: FlowPreview = { ...emptyPreview(), seats: [reviewer], problems: [{ level: 'warning', at: 'roles.reviewer', text: warning }] }
  const theStore = store({
    entries: [ENTRY('fix')], agents: [AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n', preview: () => preview,
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  expect(container.textContent).toContain('Same provider as the writer')
  expect(container.textContent).toContain('cannot enforce read-only access')
  // Delta's alsoPassed reason renders beside its primary one; Alpha's alone would not prove it.
  expect(container.textContent).toMatch(/Choose another runtime that supports this access\. — Same provider as the writer/)
  expect(container.textContent).not.toContain('Can’t confirm a different provider from the writer')
  expect(container.textContent).toContain('Picked')
  expect(container.textContent).toContain(warning)
})

// #1053: a reading step handed an isolated step's one commit gets a worktree of its own, and the dry run says so.
it('a seat the run opens at the commit it is handed says so, in plain words', async () => {
  const seat: FlowPreviewSeat = {
    role: 'tester', index: 0, agent: 'reviewer', isolate: false, atPredecessor: 'always', reviews: true,
    plan: { id: 'reviewer', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'asked' }, candidates: [candidate({ state: 'taken', reason: null, fix: null, label: 'Codex' })] } as SeatPlan,
  }
  const theStore = store({
    entries: [ENTRY('fix')],
    agents: [AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n',
    preview: () => ({ ...emptyPreview(), seats: [seat] }),
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  expect(container.textContent).toContain('Reviewer — tester')
  const chip = [...container.querySelectorAll('[title="Opens in a worktree of its own, at the commit it is handed"]')]
  expect(chip.map((one) => one.textContent)).toEqual(['Own worktree'])
})

it('a seat with mixed predecessor routes says its worktree is conditional', async () => {
  const seat: FlowPreviewSeat = {
    role: 'tester', index: 0, agent: 'reviewer', isolate: false, atPredecessor: 'may', reviews: true,
    plan: { id: 'reviewer', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'asked' }, candidates: [candidate({ state: 'taken', reason: null, fix: null, label: 'Codex' })] } as SeatPlan,
  }
  const theStore = store({
    entries: [ENTRY('fix')],
    agents: [AGENT('reviewer', 'Reviewer')],
    source: () => 'version: 2\n',
    preview: () => ({ ...emptyPreview(), seats: [seat] }),
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('fix')
  await act(async () => {})

  const chip = [...container.querySelectorAll('[title="May open in a worktree of its own, at the commit it is handed, depending on which rule opens it"]')]
  expect(chip.map((one) => one.textContent)).toEqual(['Sometimes own worktree'])
})

// #1582: what a seat's Agent declares beyond its brief sits under that seat, beside the counts of what would load — never only in the problems list above.
it('a seat the dry run attached nothing to shows nothing new under it', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [seat('fixer', false)])
  expect(container.textContent).not.toContain('Skills:')
})

it('an Agent that declares nothing says its runtime defaults on the one line', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [
    { ...seat('fixer', false), attachments: attachments({ skillsMode: 'runtime-defaults', mcpMode: 'runtime-defaults', declarations: [] }) },
  ])
  expect(seatLines()[0]!.textContent).toContain('Skills: agent defaults · Servers: agent defaults')
})

it('names that all load are counted, and the line says no name will fail', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [{ ...seat('fixer', false), attachments: attachments() }])
  expect(seatLines()[0]!.textContent).toContain('Skills: 2 will load · Servers: 1 will load')
  expect(container.textContent).not.toContain('won’t load')
})

it('a name that would not load joins the counts on the same line', async () => {
  const wont = ATTACHMENT('frontend-design', 'Review this content before loading it.')
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [{ ...seat('fixer', false), attachments: attachments({
    declarations: [ATTACHMENT('checkout-retries', null), wont, ATTACHMENT('browser', null, 'mcp')],
  }) }])
  expect(seatLines()[0]!.textContent).toContain('Skills: 1 will load · 1 won’t load · Servers: 1 will load')
})

it('a notes declaration is neither skill nor server and stays out of the line', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [{ ...seat('fixer', false), attachments: attachments({
    skillsMode: 'allowlist', mcpMode: 'runtime-defaults',
    declarations: [ATTACHMENT('checkout-retries', null), ATTACHMENT('desk-reminders', 'This attachment exceeds the Seat ceiling.', 'notes'), ATTACHMENT('scratch', null, 'notes')],
  }) }])
  expect(seatLines()[0]!.textContent).toBe('Skills: 1 will load · Servers: agent defaults')
  expect(container.textContent).not.toContain('desk-reminders')
  expect(container.textContent).not.toContain('scratch')
})

it('the line wears a check when every name loads and an alert when one will not', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [
    { ...seat('fixer', false), attachments: attachments() },
    { ...seat('reviewer', true), attachments: attachments({ declarations: [ATTACHMENT('review-checklist', null), ATTACHMENT('frontend-design', 'Review this content before loading it.')] }) },
  ])
  const lines = seatLines()
  expect(lines).toHaveLength(2)
  expect(lines[0]!.querySelector('[data-slot="row-mark"] svg')?.classList.contains('lucide-check')).toBe(true)
  expect(lines[1]!.querySelector('[data-slot="row-mark"] svg')?.classList.contains('lucide-triangle-alert')).toBe(true)
})

it('only the names that would not load are listed, verbatim under the seat line', async () => {
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [{ ...seat('fixer', false), attachments: attachments({
    declarations: [ATTACHMENT('checkout-retries', null), ATTACHMENT('frontend-design', 'Review this content before loading it.'), ATTACHMENT('browser', null, 'mcp')],
  }) }])
  // A name that loads is only counted, never written.
  expect(container.textContent).not.toContain('checkout-retries')
  const named = [...container.querySelectorAll('[data-slot="row"]')].find(one => one.textContent?.startsWith('frontend-design'))
  expect(named).toBeDefined()
  expect(named!.querySelector('code')?.textContent).toBe('frontend-design')
  expect(named!.querySelector('[data-slot="row-desc"]')?.textContent).toBe('Review this content before loading it.')
})

it('a refused seat says the host’s refusal in warning ink under its counts', async () => {
  const refusal = 'This agent cannot be stopped from loading unapproved repository content on its own for this Seat.'
  await renderTeam(TEAM_START_POLICIES['fix-and-review'], [{ ...seat('fixer', false), attachments: attachments({
    refusal, declarations: [ATTACHMENT('checkout-retries', null)],
  }) }])
  const line = seatLines()[0]!
  expect(line.querySelector('[data-slot="row-mark"] svg')?.classList.contains('lucide-triangle-alert')).toBe(true)
  expect(line.querySelector('[data-slot="row-desc"]')?.querySelector('[data-tone="warning"]')?.textContent).toBe(refusal)
})

it('the same preview stays startable with its choice, whatever a seat’s attachments say', async () => {
  const broken = { ...seat('fixer', false), attachments: attachments({
    mcpMode: 'runtime-defaults',
    refusal: 'This agent cannot be stopped from loading unapproved repository content on its own for this Seat.',
    declarations: [ATTACHMENT('frontend-design', 'Review this content before loading it.')],
  }) }
  const theStore = store({
    entries: [ENTRY('fix')], agents: [AGENT('fixer', 'Fixer')], source: () => 'version: 2\n',
    preview: () => ({ ...emptyPreview(), seats: [broken] }),
  })
  const change = vi.fn()
  render(theStore, change)
  await act(async () => {})
  await select('fix')
  await act(async () => {})
  // The dry run's own problems decide Start; the seat's attachment line adds none and removes none.
  expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'version: 2\n', token: 't' }))
  expect(container.textContent).toContain('Skills: 0 will load · 1 won’t load · Servers: agent defaults')
})

it('a review flow discloses its effective budget and the blind-round messaging restriction; a plain flow shows neither', async () => {
  const reviewSeat: FlowPreviewSeat = {
    role: 'reviewer', index: 0, agent: 'reviewer', isolate: false, reviews: true,
    plan: { id: 'reviewer', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'held' }, candidates: [] } as SeatPlan,
  }
  const reviewPreview: FlowPreview = {
    ...emptyPreview(),
    seats: [reviewSeat],
    compiled: {
      ...compiled({ flow: { version: 2, name: 'Review', inputs: [], roles: [], rules: [], seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240, budget: { rounds: 5, withoutProgress: 2 } } as never }),
      bindings: [{ role: 'reviewer', index: 0, agent: { id: 'reviewer', produces: ['review'] } as never, origin: 'project', digest: 'd', seats: [], grant: 'read' }],
    },
  }
  // An Agent that writes and reviews, seated to commit: the server says its Seats are not there to review.
  const debatePreview: FlowPreview = {
    ...reviewPreview,
    seats: [{ ...reviewSeat, role: 'analyst', agent: 'analyst', reviews: false }],
    compiled: {
      ...reviewPreview.compiled,
      bindings: [{ role: 'analyst', index: 0, agent: { id: 'analyst', produces: ['diff', 'review'] } as never, origin: 'project', digest: 'd', seats: [], grant: 'edit' }],
    },
  }
  const theStore = store({
    entries: [ENTRY('review'), ENTRY('plain'), ENTRY('debate')],
    agents: [AGENT('reviewer', 'Reviewer')],
    source: (id) => `version: 2\nname: ${id}\n`,
    preview: (source) => source.includes('review') ? reviewPreview : source.includes('debate') ? debatePreview : emptyPreview(),
  })
  render(theStore, () => {})
  await act(async () => {})
  await select('review')
  await act(async () => {})
  expect(container.textContent).toContain('stop for a person after 5 rounds')
  expect(container.textContent).toContain('cannot message or post')

  await select('plain')
  await act(async () => {})
  expect(container.textContent).not.toContain('stop for a person after')
  expect(container.textContent).not.toContain('cannot message or post')

  await select('debate')
  await act(async () => {})
  expect(container.textContent).not.toContain('stop for a person after')
  expect(container.textContent).not.toContain('cannot message or post')
})

it('late preview cannot re-enable Start after source changes', async () => {
  let resolveA!: (text: string) => void
  const theStore = store({
    entries: [ENTRY('a'), ENTRY('b')],
    source: (id) => (id === 'a' ? new Promise<string>((resolve) => { resolveA = resolve }) : 'version: 2\nname: B\n'),
    preview: (source) => source.includes('name: B')
      ? { ...emptyPreview(), token: null, problems: [{ level: 'error', at: 'roles.b.uses', text: 'There is no usable Agent called "missing".' }] }
      : { ...emptyPreview(), token: 'tokA' },
  })
  const onChange = vi.fn()
  render(theStore, onChange)
  await act(async () => {})

  await select('a')
  await select('b')
  await act(async () => {})
  expect(container.textContent).toContain('There is no usable Agent called')
  expect(onChange).toHaveBeenLastCalledWith(null)

  const callsBefore = onChange.mock.calls.length
  await act(async () => {
    resolveA('version: 2\nname: A\n')
    await Promise.resolve()
    await Promise.resolve()
  })
  // A's late reply changed nothing: no further onChange call adopted it, and
  // B's error is still what is on screen.
  expect(onChange.mock.calls.length).toBe(callsBefore)
  expect(onChange).toHaveBeenLastCalledWith(null)
  expect(container.textContent).toContain('There is no usable Agent called')
})

const previewWithRule = (messaging: FlowPreview['messaging']): FlowPreview => ({
  token: 't', messaging,
  compiled: {
    document: {
      format: 'agents',
      flow: {
        version: 2, name: 'Members', inputs: [], roles: [], messaging, wait: 240,
        seed: { role: 'fixer', title: 'Go' },
        rules: [{ id: 'r1', on: 'fixer', when: { every: ['done'] }, then: { role: 'reviewer', title: 'Look' } }],
      },
    },
    bindings: [], problems: [],
  },
  seats: [], commands: [],
  guards: [{ rule: 'r1', unevidenced: true, requires: [] }],
  problems: [],
})

it('unevidenced merge is an error and messages are disclosure only', async () => {
  const mergeError: FlowPreview = {
    ...emptyPreview(),
    token: null,
    problems: [{ level: 'error', at: 'rules[0]', text: 'This merge step needs fresh evidence. Add an evidence guard before starting it.' }],
  }
  const membersPreview = previewWithRule('members')
  const boardOnlyPreview = previewWithRule('board-only')

  const onChange = vi.fn()
  const theStore = store({
    entries: [ENTRY('merge'), ENTRY('members'), ENTRY('board')],
    source: (id) => `version: 2\nname: ${id}\n`,
    preview: (source) => source.includes('name: merge')
      ? mergeError
      : source.includes('name: members')
        ? membersPreview
        : boardOnlyPreview,
  })
  render(theStore, onChange)
  await act(async () => {})

  await select('merge')
  await act(async () => {})
  expect(container.textContent).toContain('This merge step needs fresh evidence')
  expect(onChange).toHaveBeenLastCalledWith(null)

  await select('members')
  await act(async () => {})
  expect(container.textContent).toContain('Unevidenced')
  expect(container.textContent).toContain('Members may message each other')
  expect(onChange).toHaveBeenLastCalledWith({ source: 'version: 2\nname: members\n', token: 't', vars: {} })

  await select('board')
  await act(async () => {})
  expect(container.textContent).toContain('Board-only: members do not message each other')
})

const previewWithGuard = (): FlowPreview => ({
  token: 't', messaging: 'board-only',
  compiled: {
    document: {
      format: 'agents',
      flow: {
        version: 2, name: 'Guarded', inputs: [], roles: [], messaging: 'board-only', wait: 240,
        seed: { role: 'fixer', title: 'Go' },
        rules: [{ id: 'r1', on: 'verify', when: { every: ['done'] }, then: { role: 'reviewer', title: 'Review the fix' } }],
      },
    },
    bindings: [], problems: [],
  },
  seats: [], commands: [],
  guards: [{ rule: 'r1', unevidenced: false, requires: [{ check: 'verify' }] }],
  problems: [],
})

it("a long guard sentence wraps as the round row's description, not its value column", async () => {
  const theStore = store({
    entries: [ENTRY('guarded')],
    source: (id) => `version: 2\nname: ${id}\n`,
    preview: () => previewWithGuard(),
  })
  render(theStore, () => {})
  await act(async () => {})

  await select('guarded')
  await act(async () => {})

  // The guard's sentence-length requirement belongs in a wrapped description
  // (`data-wrap`), never squeezed into the row's fixed value column — that
  // column does not shrink or wrap, so a sentence placed there instead
  // collapses the title next to it.
  const wrapped = [...container.querySelectorAll('[data-wrap]')].map((el) => el.textContent ?? '').join(' | ')
  expect(wrapped).toContain('A passing “verify” check at the selected revision')
})

const briefPreview = (): FlowPreview => ({
  ...emptyPreview(),
  compiled: compiled({ flow: {
    version: 2, name: 'Fix', inputs: [{ id: 'brief', label: 'Instructions', default: 'Existing draft' }, { id: 'ticket', label: 'Ticket', default: '42' }],
    roles: [], rules: [], seed: { role: 'fixer', title: 'Fix the ticket' }, messaging: 'board-only', wait: 240,
  } }),
})

const chooseBrief = async () => {
  const theStore = store({ entries: [ENTRY('brief'), ENTRY('plain')], source: (id) => id, preview: (source) => source === 'brief' ? briefPreview() : emptyPreview() })
  const onChange = vi.fn()
  render(theStore, onChange)
  await act(async () => {})
  await select('brief')
  return { theStore, onChange }
}

const editBrief = async (value: string) => {
  const control = container.querySelector('textarea')!
  expect(control).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(control, value)
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const attachBrief = async (file: File) => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input).not.toBeNull()
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

it('only a declared brief is multiline; other inputs keep their labels and defaults', async () => {
  await chooseBrief()
  const area = container.querySelector('textarea')!
  expect(area).not.toBeNull()
  expect(area.value).toBe('Existing draft')
  expect(container.querySelector(`label[for="${area.id}"]`)?.textContent).toBe('Brief')
  expect(container.querySelector('input:not([type="file"])')?.getAttribute('value')).toBe('42')
  expect(container.textContent).toContain('Ticket')
  expect(container.textContent).toContain('Attach a file…')
  await select('plain')
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('input[type="file"]')).toBeNull()
})

it('paragraphs reach the preview and the start choice intact as vars.brief', async () => {
  const { theStore, onChange } = await chooseBrief()
  const brief = 'Fix the ticket.\n\nKeep the current interface.\n\nVerify the result.'
  await editBrief(brief)
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'brief', { brief, ticket: '42' })
  expect(onChange).toHaveBeenLastCalledWith({ source: 'brief', token: 't', vars: { brief, ticket: '42' } })
})

it('a text file replaces the brief through the same vars path, including a file at the cap', async () => {
  const { theStore } = await chooseBrief()
  const text = 'A'.repeat(64 * 1024)
  const file = new File([text], 'brief.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'text', { value: async () => text })
  await attachBrief(file)
  expect(container.querySelector('textarea')?.value).toBe(text)
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'brief', { brief: text, ticket: '42' })
})

it('an oversized file is refused before reading and names the cap, preserving the draft', async () => {
  await chooseBrief()
  const file = new File(['A'.repeat(64 * 1024 + 1)], 'brief.txt', { type: 'text/plain' })
  const read = vi.fn()
  Object.defineProperty(file, 'text', { value: read })
  await attachBrief(file)
  expect(read).not.toHaveBeenCalled()
  expect(container.textContent).toContain('64 KiB')
  expect(container.querySelector('textarea')?.value).toBe('Existing draft')
})

it('a non-text or unreadable file preserves the draft and shows a refusal', async () => {
  await chooseBrief()
  const binary = new File(['pdf'], 'brief.pdf', { type: 'application/pdf' })
  const read = vi.fn()
  Object.defineProperty(binary, 'text', { value: read })
  await attachBrief(binary)
  expect(read).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Choose a text file')
  const file = new File(['text'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: async () => { throw new Error('unreadable') } })
  await attachBrief(file)
  expect(container.textContent).toContain('could not be read')
  expect(container.querySelector('textarea')?.value).toBe('Existing draft')
})

it('a late file read cannot replace newer typing or the newly selected flow', async () => {
  const { theStore, onChange } = await chooseBrief()
  let resolve!: (text: string) => void
  const file = new File(['old'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((done) => { resolve = done }) })
  await attachBrief(file)
  await editBrief('Newer typing')
  expect(onChange).toHaveBeenLastCalledWith({ source: 'brief', token: 't', vars: { brief: 'Newer typing', ticket: '42' } })
  await act(async () => resolve('Old file'))
  expect(container.querySelector('textarea')?.value).toBe('Newer typing')
  await attachBrief(file)
  await select('plain')
  await act(async () => resolve('Old file'))
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'plain', {})
  expect(onChange).toHaveBeenLastCalledWith({ source: 'plain', token: 't', vars: {} })
})

it('preview replies for other inputs cannot enable Start during a file read', async () => {
  const { theStore, onChange } = await chooseBrief()
  let resolvePreview!: (preview: FlowPreview) => void
  vi.mocked(theStore.previewFlow).mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve }))
  const ticket = container.querySelector<HTMLInputElement>('input:not([type="file"])')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(ticket, '43')
    ticket.dispatchEvent(new Event('input', { bubbles: true }))
  })
  let resolveFile!: (text: string) => void
  const file = new File(['File brief'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((resolve) => { resolveFile = resolve }) })
  await attachBrief(file)
  await act(async () => resolvePreview(briefPreview()))
  expect(onChange).toHaveBeenLastCalledWith(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(ticket, '44')
    ticket.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(onChange).toHaveBeenLastCalledWith(null)
  await act(async () => resolveFile('File brief'))
  expect(onChange).toHaveBeenLastCalledWith({ source: 'brief', token: 't', vars: { brief: 'File brief', ticket: '44' } })
})

it.each(['unreadable', 'binary'])('a pending %s file restores the valid choice without changing the draft', async (kind) => {
  const { onChange } = await chooseBrief()
  const previous = onChange.mock.calls.at(-1)![0]
  let resolve!: (text: string) => void
  let reject!: (error: Error) => void
  const file = new File(['text'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>((done, fail) => { resolve = done; reject = fail }) })
  await attachBrief(file)
  expect(onChange).toHaveBeenLastCalledWith(null)
  await act(async () => {
    if (kind === 'unreadable') reject(new Error('unreadable'))
    else resolve('binary\0text')
  })
  expect(container.querySelector('textarea')?.value).toBe('Existing draft')
  expect(onChange).toHaveBeenLastCalledWith(previous)
})

it('changing a recorded seat preference invalidates consent until that exact choice is previewed', async () => {
  const first: FlowPreview = { ...emptyPreview(), seats: [{ role: 'fixer', index: 0, agent: 'builder', isolate: false, reviews: false,
    plan: { id: 'builder', from: 'machine', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'held' }, candidates: [
      candidate({ state: 'taken', label: 'Alpha', reason: null, fix: null }),
      candidate({ state: 'untried', label: 'Beta', seat: { runtime: 'beta' }, reason: null, fix: null }),
    ] } }] }
  let resolve!: (value: FlowPreview) => void
  let calls = 0
  const theStore = store({ entries: [], source: () => 'unused', preview: () => ++calls === 1 ? first : new Promise<FlowPreview>(done => { resolve = done }) })
  const change = vi.fn()
  const initial = { source: 'saved', vars: {} }
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={initial} onChange={change} /></StoreProvider>))
  await select(JSON.stringify({ runtime: 'beta' }))
  expect(change).toHaveBeenLastCalledWith(null)
  expect(theStore.previewFlow).toHaveBeenLastCalledWith('/repo', 'saved', {}, { seats: { fixer: [{ runtime: 'beta' }] }, attended: undefined })
  await act(async () => resolve({ ...first, token: 'second' }))
  expect(change).toHaveBeenLastCalledWith({ source: 'saved', vars: {}, token: 'second', seats: { fixer: [{ runtime: 'beta' }] }, attended: undefined })
})

it.each([
  ['Build the checkout', 'Build the checkout'],
  ['', 'What both should attempt'],
  ['  ', 'What both should attempt'],
  ['Keep {{task}} literal', 'Keep {{task}} literal'],
])('fills the seed preview from the form (%s)', async (value, expected) => {
  const flow: import('@harnessdesk/protocol').FlowPolicy = {
    version: 2, name: 'Comparison', inputs: [{ id: 'task', label: 'What both should attempt' }],
    roles: [], seed: { role: 'competitor', title: '{{ task }}' },
    rules: [{ id: 'check', on: 'competitor', then: { role: 'verify', title: 'Check the attempt' } }],
    messaging: 'board-only', wait: 240,
  }
  const theStore = store({ entries: [], source: () => '', preview: () => ({ ...emptyPreview(), compiled: compiled({ flow }) }) })
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" initial={{ source: 'saved', vars: { task: value } }} onChange={() => {}} /></StoreProvider>))
  const rounds = () => container.querySelector('[aria-label="Rounds and rules"]')!.textContent
  expect(rounds()).toContain(`Seed round — ${expected}`)
  const control = container.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(control, 'The edited task')
    control.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(rounds()).toContain('Seed round — The edited task')
})

it.each(['judge', 'reviewer'].flatMap(roleId => [{ repeated: false, disabled: false, offered: true }, { repeated: true, disabled: false, offered: true }, { repeated: false, disabled: true, offered: true }, { repeated: false, disabled: false, offered: false }].map(test => ({ ...test, roleId }))))('offers a held-ceiling agent and preserves sibling slots (%j)', async ({ repeated, disabled, offered, roleId }) => {
  const onPolicy = vi.fn()
  const flow = TEAM_START_POLICIES[roleId === 'judge' ? 'comparison' : 'fix-and-review']
  const refused = { ...seat(roleId, true), plan: { ...seat(roleId, true).plan, winner: null, ceiling: null, candidates: [candidate({
    seat: { runtime: 'unheld' }, runtimeName: 'Stale name', reason: { kind: 'unheld', level: 'read', detail: null, required: true }, fix: { kind: 'seats' },
  })] } } as FlowPreviewSeat
  const runtimes = [
    { id: 'unheld', presentation: { name: 'Runtime Alpha' } },
    { id: 'read-holder', presentation: { name: 'Runtime Beta' }, ceilings: offered ? { read: { settings: [], how: 'Native guard' } } : {} },
  ] as never
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview, runtimes })
  await act(async () => { root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{
    flow, template: flow, disabled, preview: { ...emptyPreview(), seats: repeated ? [refused, { ...refused, index: 1 }] : [refused] }, roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy,
  }} /></StoreProvider>) })
  expect(container.textContent).toContain('Runtime Alpha can be asked to stay read-only here but cannot be held to it. Choose another runtime, or start from /race.')
  const use = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use Runtime Beta')!
  if (!offered) { expect(use).toBeUndefined(); return }
  expect(use).toBeTruthy()
  expect(use.disabled).toBe(disabled)
  act(() => use.click())
  if (disabled) { expect(onPolicy).not.toHaveBeenCalled(); return }
  expect(onPolicy).toHaveBeenCalledWith({ ...flow, roles: flow.roles.map(role => role.id === roleId ? { ...role, seats: repeated ? [{ runtime: 'read-holder' }, { runtime: 'unheld' }] : [{ runtime: 'read-holder' }] } : role) })
})


it('explains an edit refusal next to Writes and offers a compatible runtime', async () => {
  const refused = seat('fixer', false)
  const plan = { ...refused.plan, winner: null, ceiling: null, candidates: [candidate({ seat: { runtime: 'alpha' }, runtimeName: 'Runtime Alpha', state: 'passed', reason: { kind: 'unheld', level: 'edit', detail: null, required: true }, fix: { kind: 'seats' } })] }
  await renderTeam(EDIT_TEAM_START_POLICY, [{ ...refused, plan }], [
    { id: 'alpha', presentation: { name: 'Runtime Alpha' }, ceilings: {} } as never,
    { id: 'beta', presentation: { name: 'Runtime Beta' }, ceilings: { edit: { settings: [], how: 'Workspace guard' } } } as never,
  ])
  expect(container.textContent).toContain('Runtime Alpha cannot enforce editing and local commits without publishing. Choose another runtime that supports this access.')
  expect(container.querySelector('button[aria-label="Configure Writes"]')).not.toBeNull()
  expect([...container.querySelectorAll('button')].some(one => one.textContent === 'Use Runtime Beta')).toBe(true)
})


it('loads the automatic runtime models and offers menu choices before an agent is picked', async () => {
  const theStore = store({ entries: [], source: () => '', preview: emptyPreview,
    runtimes: [{ id: 'gamma', presentation: { name: 'Gamma' } } as never] })
  const models = [{ id: 'large', displayName: 'Large model', isDefault: true, hidden: false,
    reasoningLevels: [{ id: 'high', label: 'High' }], supportsImages: false }]
  Object.assign(theStore, { modelsFor: vi.fn().mockResolvedValue(models) })
  const automatic = seat('writer', false)
  const policy = TEAM_START_POLICIES['fix-and-review']
  await act(async () => root.render(<StoreProvider store={theStore}><FlowStart root="/repo" onChange={() => {}} team={{
    flow: policy, template: policy, preview: { ...emptyPreview(), seats: [{ ...automatic, role: 'fixer' }] },
    roster: new Map(), vars: {}, onVar: () => {}, onReadingChange: () => {}, onPolicy: () => {},
  }} /></StoreProvider>))
  expect(theStore.modelsFor).toHaveBeenCalledWith('gamma')
  await openConfiguration('Writes')
  for (const label of ['Runtime', 'Model', 'Effort']) {
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${label} for Writes"]`)!
    expect(trigger).not.toBeNull()
    expect(trigger.disabled).toBe(false)
    await act(async () => trigger.click())
    const menu = document.body.querySelector('[role="menu"]')!
    expect(menu).not.toBeNull()
    if (label === 'Model') expect(menu.textContent).toContain('Large model')
    if (label === 'Effort') expect(menu.textContent).toContain('High')
    await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.body.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('[aria-label="Writes configuration"]')).not.toBeNull()
  }
  await act(async () => document.querySelector('[aria-label="Writes configuration"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[aria-label="Writes configuration"]')).toBeNull()
  expect(document.activeElement).toBe(container.querySelector('[aria-label="Configure Writes"]'))
})
