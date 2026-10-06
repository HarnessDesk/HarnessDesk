import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { CeilingLevel, FlowAgentRole, FlowPolicy, FlowPolicyRole, FlowPolicyRule, SeatCeiling } from '@harnessdesk/protocol'

import { flowLayout } from '../../lib/flow-layout'
import { flowModel } from '../../lib/flow-model'
import { FlowGraph } from './FlowGraph'
import { canvasDOM } from '../../test/flow-canvas-dom'

// The real layout, with its calls counted, so a test can see how often a drawing asks for one.
vi.mock('../../lib/flow-layout', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/flow-layout')>()
  return { ...real, flowLayout: vi.fn(real.flowLayout) }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  canvasDOM()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await import('./FlowCanvas/Engine')
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const agent = (id: string, grant: CeilingLevel = 'read', over: Partial<FlowAgentRole> = {}): FlowAgentRole => ({
  id, kind: 'agent', uses: [`${id}-agent`], seats: [], isolate: false, grant, independentOf: [], ...over,
})
const check = (id: string, run: string): FlowPolicyRole => ({ id, kind: 'check', check: { run, timeout: 300, exits: { 0: 'pass' }, otherwise: 'fail' } })
const person = (id: string, outcomes: readonly string[]): FlowPolicyRole => ({ id, kind: 'person', outcomes })
const rule = (id: string, on: string, to: string, every?: readonly string[]): FlowPolicyRule => ({
  id, on, ...(every ? { when: { every } } : {}), then: { role: to, title: `Open ${to}` },
})
const policy = (roles: readonly FlowPolicyRole[], rules: readonly FlowPolicyRule[], over: Partial<FlowPolicy> = {}): FlowPolicy => ({
  version: 2, name: 'Write, review, land', inputs: [], roles, rules, seed: { role: roles[0]!.id, title: 'Go' }, messaging: 'board-only', wait: 240, ...over,
})

const blueprint = () => policy(
  [agent('write', 'edit'), check('check', 'pnpm verify'), agent('review', 'read', { count: 3 }), check('land', 'gh pr merge'), agent('fix', 'edit'), person('you', ['merged', 'dropped'])],
  [
    rule('r1', 'write', 'check'),
    rule('r2', 'check', 'review', ['passes']),
    rule('r3', 'review', 'land', ['approve']),
    rule('r4', 'review', 'fix', ['request-changes']),
    rule('r5', 'fix', 'check'),
    rule('r6', 'land', 'you', ['landed']),
  ],
)

const ran = (level: CeilingLevel, hold: SeatCeiling['hold']): SeatCeiling => ({ level, hold })
const draw = async (flow: FlowPolicy, ceilings?: ReadonlyMap<string, SeatCeiling>) => {
  const model = flowModel(flow, ceilings ? { ceilings } : {})
  await act(async () => root.render(<FlowGraph model={model} />))
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('.react-flow__node')).not.toBeNull()) })
  return model
}
const stepsOf = () => [...container.querySelectorAll<HTMLElement>('[data-slot="flow-step"]')]

it('draws a card for each step, in the model\'s order, each saying what it is, its name and its one line', async () => {
  await draw(blueprint(), new Map([['write', ran('edit', 'asked')]]))
  const steps = stepsOf()
  expect(steps.map((step) => step.dataset['step'])).toEqual(['write', 'check', 'review', 'land', 'fix', 'you'])
  expect(steps.map((step) => step.dataset['kind'])).toEqual(['agent', 'check', 'agent', 'check', 'agent', 'person'])
  expect(steps[0]!.textContent).toContain('Write')
  expect(steps[0]!.textContent).toContain('Edit · asked, not enforced')
  expect(steps[1]!.textContent).toContain('pnpm verify')
  expect(steps[5]!.textContent).toContain('merged · dropped')
})

it('tints a step by its kind and draws every mark as the thing it is, not a face', async () => {
  await draw(blueprint())
  const tiles = stepsOf().map((step) => step.querySelector('[data-slot="icon-tile"]'))
  expect(tiles.map((tile) => tile?.getAttribute('data-tint'))).toEqual(['violet', 'sky', 'violet', 'sky', 'violet', 'amber'])
  expect(tiles.every((tile) => tile?.getAttribute('data-shape') === 'square')).toBe(true)
})

it('scales layout pitch to the rendered card dimensions without a second layout', async () => {
  const model = await draw(blueprint())
  const layout = flowLayout(model)
  for (const node of layout.nodes) {
    const step = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${node.id}"]`)!
    expect(step.style.transform).toBe(`translate(${node.box.x * ((232 + 64) / (176 + 64))}px,${node.box.y * ((130 + 88) / (68 + 88))}px)`)
  }
})

it('fans a step that opens several seats into cards behind the front one, which assistive technology skips', async () => {
  await draw(blueprint())
  const review = container.querySelector<HTMLElement>('[data-step="review"]')!
  const behind = review.querySelectorAll('[data-behind]')
  expect(behind).toHaveLength(2)
  expect([...behind].every((one) => one.getAttribute('aria-hidden') === 'true')).toBe(true)
  expect(container.querySelector('[data-step="write"]')!.querySelectorAll('[data-behind]')).toHaveLength(0)
})

it('draws the merged rules as engine edges, including loops and arrow markers', async () => {
  await draw(blueprint())
  const edges = [...container.querySelectorAll<SVGGElement>('[data-slot="flow-edge"]')]
  expect(edges.map(edge => `${edge.dataset.edge}:${edge.dataset.kind}`)).toEqual([
    'write>check:forward', 'check>review:forward', 'review>land:forward', 'review>fix:loop', 'fix>check:loop', 'land>you:forward',
  ])
  for (const edge of edges) expect(edge.querySelector('path')?.getAttribute('marker-end')).toContain('url(')
})

it('says the outcome word of a rule on its line, and marks a loop\'s word as a retry', async () => {
  await draw(blueprint())
  const words = [...container.querySelectorAll<HTMLElement>('[data-slot="flow-word"]')]
  expect(words.map((word) => word.textContent)).toEqual(['passes', 'approve', 'request-changes', 'landed'])
  expect(words.map((word) => word.hasAttribute('data-retry'))).toEqual([false, false, true, false])
  expect(words[2]!.querySelector('svg')).not.toBeNull()
  expect(words[0]!.querySelector('svg')).toBeNull()
})

it('draws no word for a rule nothing guards', async () => {
  await draw(policy([agent('write'), agent('review')], [rule('r1', 'write', 'review')]))
  expect(container.querySelectorAll('[data-slot="flow-word"]')).toHaveLength(0)
})

it('exposes both engine selection and an accessible step list at every width', async () => {
  await draw(blueprint())
  expect(container.querySelector('[data-slot="flow-canvas"]')?.getAttribute('role')).toBe('region')
  expect(container.querySelector('[data-slot="flow-drawing"]')?.getAttribute('aria-hidden')).toBeNull()
  expect(container.querySelector('[data-slot="flow-list"]')?.closest('[aria-hidden="true"]')).toBeNull()
})

it('lists every step and says what each is, so a screen reader reaches what the drawing shows', async () => {
  await draw(blueprint(), new Map([['write', ran('edit', 'held')]]))
  const steps = container.querySelector<HTMLElement>('section[aria-label="Steps"]')!
  const rows = [...steps.querySelectorAll('[data-slot="list-row"]')]
  expect(rows).toHaveLength(6)
  expect(rows[0]!.textContent).toContain('Write')
  expect(rows[0]!.textContent).toContain('Agent')
  expect(rows[0]!.textContent).toContain('Edit')
  expect(rows[1]!.textContent).toContain('Check')
  expect(rows[1]!.textContent).toContain('pnpm verify')
  expect(rows[2]!.textContent).toContain('3 at once')
  expect(rows[5]!.textContent).toContain('Person')
})

it('lists every rule as a sentence, loops included, in the order the file wrote them', async () => {
  await draw(blueprint())
  const rules = container.querySelector<HTMLElement>('section[aria-label="Rules"]')!
  const rows = [...rules.querySelectorAll('[data-slot="row"]')]
  expect(rows.map((row) => row.querySelector('[data-slot="row-title"]')!.textContent)).toEqual([
    'Write → Check', 'Check → Review', 'Review → Land', 'Review → FixLoops back', 'Fix → CheckLoops back', 'Land → You',
  ])
  expect(rows[0]!.textContent).toContain('Whatever the outcome')
  expect(rows[1]!.textContent).toContain('When every answer says passes')
  expect(rows[3]!.textContent).toContain('When every answer says request-changes')
})

it('says so when a Flow has no rule, instead of an empty list', async () => {
  await draw(policy([agent('write')], []))
  const rules = container.querySelector<HTMLElement>('section[aria-label="Rules"]')!
  expect(rules.textContent).toContain('No rules')
})

it('draws a Flow with no steps as a sentence and nothing else', async () => {
  await act(async () => root.render(<FlowGraph model={flowModel({ ...policy([agent('x')], []), roles: [] })} />))
  expect(container.querySelector('[data-slot="flow-step"]')).toBeNull()
  expect(container.textContent).toContain('This Flow has no steps')
})

it('lays a Flow out once for the model it was given, however often the window draws it again', async () => {
  const model = flowModel(blueprint())
  vi.mocked(flowLayout).mockClear()
  await act(async () => root.render(<FlowGraph model={model} />))
  await act(async () => root.render(<FlowGraph model={model} />))
  await act(async () => root.render(<FlowGraph model={model} />))
  expect(flowLayout).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<FlowGraph model={flowModel(blueprint())} />))
  expect(flowLayout).toHaveBeenCalledTimes(2)
})

it('keeps each engine instance independent, including its background and arrow markers', async () => {
  await act(async () => root.render(<><FlowGraph model={flowModel(blueprint())} /><FlowGraph model={flowModel(blueprint())} /></>))
  const ids = [...container.querySelectorAll('pattern')].map(pattern => pattern.id)
  expect(ids).toHaveLength(2)
  expect(new Set(ids).size).toBe(2)
})

it('draws a Flow from the position its file gave, and says nothing about it', async () => {
  const model = await draw(policy(
    [agent('write'), agent('review')],
    [rule('r1', 'write', 'review')],
    { layout: { positions: { write: { x: 300, y: 40 }, review: { x: 40, y: 40 } } } },
  ))
  const write = container.querySelector<HTMLElement>('[data-step="write"]')!
  const review = container.querySelector<HTMLElement>('[data-step="review"]')!
  expect(parseFloat(write.closest<HTMLElement>('.react-flow__node')!.style.transform.split('(')[1]!)).toBeGreaterThan(parseFloat(review.closest<HTMLElement>('.react-flow__node')!.style.transform.split('(')[1]!))
  expect(container.textContent).not.toContain('layout')
  expect(model.positions['write']).toEqual({ x: 300, y: 40 })
})

it('draws recorded Run state with faces, a badge and duration, a working ring and a counted route', async () => {
  const model = flowModel(blueprint())
  const overlay = {
    steps: new Map([
      ['write', { state: 'done' as const, runs: 1, durationMs: 660_000, since: null, line: 'published', seats: ['alpha'] }],
      ['review', { state: 'done' as const, runs: 1, durationMs: 360_000, since: null, line: 'changes', seats: ['beta', 'gamma'] }],
      ['fix', { state: 'working' as const, runs: 1, durationMs: 0, since: 1000, line: null, seats: ['alpha'] }],
      ['land', { state: 'future' as const, runs: 0, durationMs: null, since: null, line: null, seats: [] }],
    ]),
    rules: new Map([['r4', { count: 1, current: true }]]),
  }
  const select = vi.fn()
  await act(async () => root.render(<FlowGraph model={model} overlay={overlay} now={121000} selectedStep="fix" onSelectStep={select}
    faces={new Map([['alpha', <span>Alpha mark</span>], ['beta', <span>Beta mark</span>], ['gamma', <span>Gamma mark</span>]])}
    doing={new Map([['alpha', 'Editing src/retry.ts']])} />))
  const write = container.querySelector('[data-step="write"]')!
  const future = container.querySelector('[data-step-row="land"] [data-slot="list-row-trail"]')!
  expect(future.querySelector('[data-slot="chip"][data-tone="neutral"]')?.textContent).toBe('Not reached')
  expect(write.getAttribute('data-state')).toBe('done')
  expect(write.querySelector('[data-slot="flow-complete"]')).not.toBeNull()
  expect(write.querySelector('[data-slot="flow-duration"]')?.textContent).toBe('11m')
  expect(write.querySelector('[data-shape="face"]')?.textContent).toContain('Alpha mark')
  expect(container.querySelector('[data-step="review"]')!.querySelectorAll('[data-shape="face"]')).toHaveLength(2)
  expect([...container.querySelectorAll('[data-slot="flow-faces"] [data-shape="face"]')].every(face => !face.hasAttribute('title'))).toBe(true)
  const fix = container.querySelector('[data-step="fix"]')!
  expect(fix.textContent).toContain('Working')
  expect(fix.textContent).toContain('Editing src/retry.ts')
  expect(fix.getAttribute('data-selected')).toBe('true')
  expect(container.querySelector('[data-edge="review>fix"]')!.getAttribute('data-state')).toBe('travelled')
  expect(container.querySelector('[data-slot="flow-baton"]')).not.toBeNull()
  expect(container.textContent).toContain('request-changes ×1')
  act(() => (container.querySelector('section[aria-label="Steps"] button') as HTMLButtonElement).click())
  expect(select).toHaveBeenCalledWith('write')
})

it('the list carries waiting, repeat counts and unknown duration; agent words are sanitized', async () => {
  const model = flowModel(blueprint())
  await act(async () => root.render(<FlowGraph model={model} overlay={{ rules: new Map(), steps: new Map([
    ['you', { state: 'waiting', runs: 1, durationMs: null, since: null, line: 'merged · dropped', seats: [] }],
    ['write', { state: 'done', runs: 2, durationMs: null, since: null, line: '<script>bad()</script><b>published</b>', seats: [] }],
  ]) }} />))
  expect(container.querySelector('[data-step="you"]')!.textContent).toContain('Needs you')
  const list = container.querySelector('[data-slot="flow-list"]')!
  expect(list.textContent).toContain('Needs you')
  expect(list.querySelector('[data-step-row="you"] [data-slot="chip"][data-tone="warning"]')?.textContent).toBe('Needs you')
  expect(list.querySelector('[data-step-row="write"] [title="Time not recorded"]')?.textContent).toBe('—')
  expect(list.textContent).toContain('2 runs')
  expect(list.querySelector('[data-step-row="write"] [data-slot="list-row-trail"]')?.textContent).toBe('Published— · 2 runs')
  expect(container.textContent).not.toContain('<script>')
  expect(container.querySelector('script')).toBeNull()
})


it('marks command steps with terminals in the blueprint drawing and catalogue list', async () => {
  await draw(blueprint())
  for (const id of ['check', 'land']) {
    expect(container.querySelector(`[data-step="${id}"] .lucide-square-terminal`)).not.toBeNull()
    expect(container.querySelector(`[data-step-row="${id}"] .lucide-square-terminal`)).not.toBeNull()
    expect(container.querySelector(`[data-step="${id}"] .lucide-check`)).toBeNull()
  }
})

it('shares sanitized live activity with the list and replaces ceiling words with its object', async () => {
  const model = flowModel(blueprint(), { ceilings: new Map([['fix', ran('edit', 'held')]]) })
  const live = { state: 'working' as const, runs: 1, durationMs: 0, since: 1000, line: null, seats: ['alpha'] }
  const overlay = { rules: new Map(), steps: new Map([['fix', live]]) }
  const render = async (doing: string | null, state = live) => act(async () => root.render(<FlowGraph model={model}
    overlay={{ ...overlay, steps: new Map([['fix', state]]) }} doing={new Map([['alpha', doing]])} />))
  const card = () => container.querySelector('[data-step="fix"]')!
  const line = () => card().querySelector('[data-slot="text"][data-role="meta"]')
  const row = () => container.querySelector('[data-step-row="fix"]')!
  await render('<script>bad()</script>Editing <b>src/retry.ts</b>')
  expect(line()?.textContent).toBe('retry.ts')
  expect(line()?.getAttribute('title')).toBe('retry.ts')
  expect(row().textContent).toContain('Editing src/retry.ts')
  expect(line()?.textContent).not.toBe('Edit')
  expect(container.textContent).not.toContain('bad()')
  expect(container.querySelector('script')).toBeNull()
  await render('Read src/checkout.ts')
  expect(line()?.textContent).toBe('checkout.ts')
  expect(row().textContent).toContain('Read src/checkout.ts')
  expect(row().textContent).not.toContain('retry.ts')
  await render(null)
  expect(row().textContent).not.toContain('Read src/checkout.ts')
  expect(line()?.textContent).toBe('Agent')
  await render('Running a command')
  expect(line()?.textContent).toBe('Agent')
  await render('Read README')
  expect(line()?.textContent).toBe('README')
  await render('Editing files')
  expect(line()?.textContent).toBe('Agent')
  await render('Reading a file')
  expect(line()?.textContent).toBe('Agent')
})


it('updates and clears the accessible doing sentence while the same step remains working', async () => {
  const model = flowModel(blueprint())
  const overlay = { rules: new Map(), steps: new Map([['fix', { state: 'working' as const, runs: 1, durationMs: 0, since: 1000, line: null, seats: ['alpha'] }]]) }
  const render = async (doing: string | null) => act(async () => root.render(<FlowGraph model={model} overlay={overlay} doing={new Map([['alpha', doing]])} />))
  await render('Editing src/retry.ts')
  expect(container.querySelector('[data-step-row="fix"]')!.textContent).toContain('Editing src/retry.ts')
  await render('Read src/checkout.ts')
  expect(container.querySelector('[data-step-row="fix"]')!.textContent).toContain('Read src/checkout.ts')
  expect(container.querySelector('[data-step-row="fix"]')!.textContent).not.toContain('retry.ts')
  await render(null)
  expect(container.querySelector('[data-step-row="fix"]')!.textContent).not.toContain('Read src/checkout.ts')
})


it('shows an ended unfinished step as Stopped without activity, completion, motion or glow', async () => {
  const overlay = { rules: new Map([['r4', { count: 1, current: false }]]), steps: new Map([
    ['fix', { state: 'stopped' as const, runs: 1, durationMs: 120000, since: null, line: null, seats: ['alpha'] }],
  ]) }
  const model = flowModel(blueprint())
  const render = async (now: number) => act(async () => root.render(<FlowGraph model={model} overlay={overlay} now={now} doing={new Map([['alpha', 'Editing src/retry.ts']])} />))
  await render(500000)
  const fix = container.querySelector('[data-step="fix"]')!
  expect(fix.textContent).toContain('Stopped')
  expect(fix.querySelector('[data-slot="flow-duration"]')?.textContent).toBe('2m')
  expect(container.querySelector('[data-slot="flow-ring"], [data-slot="flow-baton"], [data-slot="flow-doing"], path[filter]')).toBeNull()
  expect(fix.querySelector('[data-slot="flow-complete"]')).toBeNull()
  await render(900000)
  expect(fix.querySelector('[data-slot="flow-duration"]')?.textContent).toBe('2m')
})


it('shows a person waiting for evidence as Waiting without asking for another answer', async () => {
  const overlay = { rules: new Map(), steps: new Map([
    ['you', { state: 'blocked' as const, runs: 1, durationMs: 60000, since: null, line: 'merged', seats: [] }],
  ]) }
  await act(async () => root.render(<FlowGraph model={flowModel(blueprint())} overlay={overlay} />))
  const you = container.querySelector('[data-step="you"]')!
  expect(you.querySelector('[data-slot="flow-state"]')?.textContent).toBe('Waiting')
  expect(you.textContent).not.toContain('Needs you')
  expect(you.querySelector('[data-slot="flow-complete"], [data-slot="flow-ring"]')).toBeNull()
})

it('keeps explanations on unknown readings of an unconfirmed check',async ()=>{
 const model=flowModel(blueprint())
 await act(async ()=>root.render(<FlowGraph model={model} overlay={{rules:new Map(),steps:new Map([
  ['check',{state:'blocked',runs:null,durationMs:null,since:null,line:null,seats:[]}],
 ])}}/>))
 const readings=container.querySelector('[data-step-row="check"] [data-slot="list-row-trail"]')!
 expect(readings.querySelector('[title="Time not recorded"]')?.textContent).toBe('—')
 expect(readings.querySelector('[title="Run count unavailable"]')?.textContent).toBe('—')
})

it('keeps check Steps square when the fallback has no seated Agent', async () => {
 await draw(policy([check('verify','pnpm test')], []))
 expect(container.querySelector('[data-step-row="verify"] [data-slot="icon-tile"]')?.getAttribute('data-shape')).toBe('square')
})

it('uses the shared read-only canvas and refuses edits while keeping step selection', async () => {
  await act(async () => root.render(<FlowGraph model={flowModel(blueprint())} />))
  await vi.waitFor(() => expect(container.querySelector('[data-slot="flow-canvas"][data-readonly="true"]')).not.toBeNull())
  expect(container.querySelector('.react-flow__node.draggable')).toBeNull()
  expect(container.querySelector('.react-flow__handle.connectable')).toBeNull()
})

it('selects a Run step through the engine node as well as the accessible list', async () => {
  const select = vi.fn()
  await act(async () => root.render(<FlowGraph model={flowModel(blueprint())} onSelectStep={select} />))
  act(() => (container.querySelector('.react-flow__node[data-id="check"]') as HTMLElement).click())
  expect(select).toHaveBeenCalledWith('check')
})

it('a docked text alternative keeps screen-reader selection without invisible tab stops', async () => {
  const select = vi.fn()
  await act(async () => root.render(<FlowGraph model={flowModel(blueprint())} listPlacement="dock" onSelectStep={select} />))
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[data-slot="flow-list"] button')]
  expect(rows).toHaveLength(6)
  expect(rows.every(row => row.tabIndex === -1)).toBe(true)
  act(() => rows[1]!.click())
  expect(select).toHaveBeenCalledWith('check')
})
