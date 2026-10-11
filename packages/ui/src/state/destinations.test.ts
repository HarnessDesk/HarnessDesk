import { expect, test } from 'vitest'
import { destinationOf, readDestination, readDestinationHistory, stepDestination, visitDestination } from './destinations'

const work = destinationOf({ kind: 'room', room: 'team-demo', framePage: 'findings' })
const settings = { kind: 'settings', route: { kind: 'section', section: 'appearance', focus: null } } as const
const dashboard = { kind: 'dashboard', view: 'plans', scope: null } as const

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
