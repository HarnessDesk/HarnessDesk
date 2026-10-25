import { expect, test, vi } from 'vitest'
import { availableDestinationHistory, destinationOf, leaveSettingsDestination, libraryBack, readDestination, readDestinationHistory, stepDestination, visitDestination } from './destinations'

const work = destinationOf({ kind: 'room', room: 'team-demo', framePage: 'findings' })
const settings = { kind: 'settings', route: { kind: 'section', section: 'appearance', focus: null } } as const
const dashboard = { kind: 'dashboard', view: 'plans', scope: null } as const

test('Lead history evaluates its fallback only when replacing an unavailable current entry', () => {
  const fallback = vi.fn(() => work), lead = { kind: 'lead' } as const
  const ordinary = { current: settings, back: [work], forward: [dashboard] }
  expect(availableDestinationHistory(ordinary, fallback)).toBe(ordinary)
  expect(availableDestinationHistory({ ...ordinary, back: [lead] }, fallback)).toEqual({ ...ordinary, back: [] })
  const enabled = { current: lead, back: [], forward: [] }
  expect(availableDestinationHistory(enabled, fallback, true)).toBe(enabled)
  expect(fallback).not.toHaveBeenCalled()
  expect(availableDestinationHistory(enabled, fallback)).toEqual({ current: work, back: [], forward: [] })
  expect(fallback).toHaveBeenCalledOnce()
})

test('Flows restores the catalogue, a new draft and an origin-bound file through Back and Forward', () => {
  const catalogue = { kind: 'flows', root: null, id: null, origin: null } as const
  const draft = { kind: 'flows', root: '/work/demo', id: null, origin: null } as const
  const flow = { kind: 'flows', root: '/work/demo', id: 'review', origin: 'project' } as const
  for (const destination of [catalogue, draft, flow]) expect(readDestination(destination)).toEqual(destination)
  const start = { context: { kind: 'pull-request', root: '/work/demo', number: 42 }, goal: { id: 'empty-team', revision: 2 }, task: 'Review this change', done: 'Findings resolved' }
  expect(readDestination({ ...draft, start })).toEqual({ ...draft, start })
  expect(readDestination({ ...draft, start: { ...start, context: { ...start.context, root: '/work/other' } } })).toBeNull()
  for (const invalid of [{ ...flow, root: null }, { ...flow, origin: 'unknown' }, { ...draft, origin: 'project' }]) {
    expect(readDestination(invalid)).toBeNull()
  }
  const history = visitDestination(visitDestination({ current: work, back: [], forward: [] }, catalogue), flow)
  expect(stepDestination(history, 'back')?.current).toEqual(catalogue)
  expect(stepDestination(stepDestination(history, 'back')!, 'forward')?.current).toEqual(flow)
})

test('Back/Forward crosses pages and preserves the complete work payload', () => {
  const start = { current: work, back: [], forward: [] }
  const two = visitDestination(visitDestination(start, settings), dashboard)
  const back = stepDestination(two, 'back')!
  expect(back.current).toEqual(settings)
  expect(stepDestination(back, 'back')!.current).toEqual(work)
  expect(stepDestination(back, 'forward')!.current).toEqual(dashboard)
  expect(visitDestination(back, settings)).toEqual(back)
  expect(visitDestination(back, { kind: 'agents', id: null }).forward).toEqual([])
})

test('draft is a destination; replacing control state makes no extra visit', () => {
  const draft = destinationOf({ kind: 'conversation', session: null })
  const start = { current: draft, back: [], forward: [] }
  const open = visitDestination(start, dashboard)
  const updated = visitDestination(open, { ...dashboard, view: 'spend' }, true)
  expect(updated.back).toEqual([draft])
  expect(updated.current).toEqual({ ...dashboard, view: 'spend' })
})

test('leaving Settings skips its visited routes and keeps them available through Forward', () => {
  const general = { kind: 'settings', route: { kind: 'section', section: 'general', focus: null } } as const
  const appearance = { kind: 'settings', route: { kind: 'section', section: 'appearance', focus: null } } as const
  const runtimes = { kind: 'settings', route: { kind: 'section', section: 'runtimes', focus: null } } as const
  const history = { current: runtimes, back: [work, general, appearance], forward: [] }
  const left = leaveSettingsDestination(history)!
  expect(left.current).toEqual(work)
  expect(left.back).toEqual([])
  expect(stepDestination(left, 'forward')?.current).toEqual(general)
  expect(stepDestination(stepDestination(left, 'forward')!, 'forward')?.current).toEqual(appearance)
  expect(stepDestination(stepDestination(stepDestination(left, 'forward')!, 'forward')!, 'forward')?.current).toEqual(runtimes)
})

test('old documents restore work; invalid entries are removed and history is bounded', () => {
  expect(readDestinationHistory(undefined, work)).toEqual({ current: work, back: [], forward: [] })
  const raw = { current: settings, back: Array(55).fill(work), forward: [{ kind: 'plugin', credential: 'discard' }] }
  const result = readDestinationHistory(raw, work)
  expect(result.current).toEqual(settings)
  expect(result.back).toHaveLength(50)
  expect(result.forward).toEqual([])
  expect(readDestinationHistory({ current: { kind: 'settings', route: { kind: 'section', section: 'library' } } }, work).current).toEqual(work)
})

test('restored routes strip transient fields and validate every entity payload', () => {
  expect(readDestination({ ...settings, dialog: 'discard', route: { ...settings.route, credential: 'discard' } })).toEqual(settings)
  expect(readDestination({ kind: 'settings', route: { kind: 'account', runtime: 'test-runtime', key: 'demo', auth: 'discard' } }))
    .toEqual({ kind: 'settings', route: { kind: 'account', runtime: 'test-runtime', key: 'demo' } })
  for (const raw of [null, [], { kind: 'work', view: { kind: 'conversation' } },
    { kind: 'work', view: { kind: 'room', room: '' } }, { kind: 'dashboard', view: 'other', scope: null },
    { kind: 'settings', route: { kind: 'project', root: '' } }, { kind: 'changes-review', root: null, returnTo: { kind: 'changes' } }]) {
    expect(readDestination(raw)).toBeNull()
  }
  expect(readDestination({ kind: 'changes-review', root: '/synthetic/project', returnTo: { kind: 'room', room: 'team-demo', framePage: 'findings' } })).toEqual({
    kind: 'changes-review', root: '/synthetic/project', returnTo: { kind: 'room', room: 'team-demo', framePage: 'findings' },
  })
})


test('Lead route parsing and restored history require a host capability', () => {
  const lead = { kind: 'lead' } as const
  expect(readDestination(lead)).toBeNull()
  expect(readDestination(lead, true)).toEqual(lead)
  const raw = { current: lead, back: [work, lead], forward: [lead, dashboard] }
  expect(readDestinationHistory(raw, work)).toEqual({ current: work, back: [work], forward: [dashboard] })
  expect(readDestinationHistory(raw, work, true)).toEqual(raw)
})

 test('Library changes round trips, rejects bad sections and returns through Back', () => {
  const library = { kind: 'library', section: 'skill' } as const
  const changes = { kind: 'library', section: 'changes' } as const
  expect(readDestination(changes)).toEqual(changes)
  expect(readDestination({ ...changes, section: 'bad' })).toBeNull()
  expect(readDestination({ ...changes, section: null })).toBeNull()
  const history = visitDestination({ current: library, back: [], forward: [] }, changes)
  expect(stepDestination(history, 'back')?.current).toEqual(library)
  expect(stepDestination(stepDestination(history, 'back')!, 'forward')?.current).toEqual(changes)
})

test('Library skill names round trip, validate, and preserve Back and Forward without changing Settings skills', () => {
  const library = { kind: 'library', section: 'skill' } as const
  const detail = { ...library, id: 'code-review' }
  expect(readDestination(detail)).toEqual(detail)
  for (const id of ['', null, 42, {}]) expect(readDestination({ ...detail, id })).toBeNull()
  expect(readDestination({ ...detail, section: 'mcp' })).toBeNull()
  expect(readDestination({ ...detail, section: 'changes' })).toBeNull()
  const history = visitDestination({ current: library, back: [], forward: [] }, detail)
  expect(stepDestination(history, 'back')?.current).toEqual(library)
  expect(stepDestination(stepDestination(history, 'back')!, 'forward')?.current).toEqual(detail)
  expect(readDestination({ kind: 'settings', route: { kind: 'skill', name: 'code-review' } })).toEqual({ kind: 'settings', route: { kind: 'skill', name: 'code-review' } })
})

test('Back to Library steps onto the page behind it, and otherwise visits the section last used', () => {
  const changes = { kind: 'library', section: 'changes' } as const
  const skill = { kind: 'library', section: 'skill' } as const
  const detail = { kind: 'library', section: 'skill', id: 'code-review' } as const
  const mcp = { kind: 'library', section: 'mcp' } as const
  // The Library page it came from, exactly — a detail keeps its id.
  expect(libraryBack({ current: changes, back: [detail], forward: [] })).toEqual({ step: true })
  expect(libraryBack({ current: changes, back: [skill], forward: [] })).toEqual({ step: true })
  // Nothing Library behind it at all: Skills.
  expect(libraryBack({ current: changes, back: [], forward: [] })).toEqual({ step: false, section: 'skill' })
  expect(libraryBack({ current: changes, back: [dashboard], forward: [] })).toEqual({ step: false, section: 'skill' })
  // A non-Library page directly behind, an MCP page earlier: visit MCP.
  expect(libraryBack({ current: changes, back: [mcp, settings], forward: [] })).toEqual({ step: false, section: 'mcp' })
})
