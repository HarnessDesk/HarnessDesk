import { expect, test, vi } from 'vitest'
import { AppStore } from './store'
import { panes } from './layout'
import '../panels/builtins'

const settings = { kind: 'settings', route: { kind: 'section', section: 'appearance', focus: null } } as const
const dashboard = { kind: 'dashboard', view: 'overview', scope: null } as const

test('page navigation retains work and selecting the same hidden Team returns to work', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  store.openTeamRoom('team-demo')
  const main = store.getSnapshot().layout
  store.openDestination(settings)
  expect(store.getSnapshot().layout).toBe(main)
  store.openDestination(dashboard)
  await store.navigateBack()
  expect(store.getSnapshot().workbench.navigation.current).toEqual(settings)
  await store.navigateBack()
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  store.openDestination(settings)
  store.openTeamRoom('team-demo')
  expect(store.getSnapshot().workbench.navigation.current.kind).toBe('work')
  expect(panes(store.getSnapshot().layout.root)[0]!.view).toMatchObject({ kind: 'room', room: 'team-demo' })
})

test('rapid history requests serialize and a fresh page clears Forward', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  store.openDestination(settings)
  store.openDestination(dashboard)
  store.openDestination({ kind: 'agents', id: null })
  await Promise.all([store.navigateBack(), store.navigateBack()])
  expect(store.getSnapshot().workbench.navigation.current).toEqual(settings)
  expect(store.getSnapshot().navCanForward).toBe(true)
  store.openDestination({ kind: 'teams', filter: 'active' })
  expect(store.getSnapshot().navCanForward).toBe(false)
})

test('Team controls replace a visit and a history step restores payload even for the same room', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  store.openTeamRoom('team-demo')
  store.setTeamFramePage('team-demo', 'findings')
  const selected = store.getSnapshot().workbench.navigation
  store.openDestination(settings)
  store.setTeamFramePage('team-demo', 'room', 'side-by-side')
  expect(store.getSnapshot().workbench.navigation.current).toEqual(settings)
  await store.navigateBack()
  expect(panes(store.getSnapshot().layout.root)[0]!.view).toMatchObject({ kind: 'room', framePage: 'findings' })
  expect(store.getSnapshot().workbench.navigation.back).toEqual(selected.back)
  store.openDestination(settings)
  store.openTeamRoom('team-demo')
  expect(panes(store.getSnapshot().layout.root)[0]!.view).toMatchObject({ kind: 'room', framePage: 'findings' })
  const count = store.getSnapshot().workbench.navigation.back.length
  store.setTeamFramePage('team-demo', 'room', 'side-by-side')
  expect(store.getSnapshot().workbench.navigation.back).toHaveLength(count)
  expect(store.getSnapshot().workbench.navigation.current).toMatchObject({ kind: 'work', view: { chatLayout: 'side-by-side' } })
})

test('a queued step is cancelled by a fresh destination before it starts', async () => {
  const store = new AppStore('ws://localhost:0/')
  store.openDestination(settings)
  store.openDestination(dashboard)
  const back = store.navigateBack()
  store.openDestination({ kind: 'agents', id: null })
  const before = store.getSnapshot().workbench.navigation
  await back
  expect(store.getSnapshot().workbench.navigation).toBe(before)
})

test('draft selection is a visit while replacement and tool state are not', async () => {
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockResolvedValue(null as never)
  store.openTeamRoom('team-demo')
  store.newDraft()
  expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'work', view: { kind: 'conversation', session: null } })
  await store.navigateBack()
  expect(store.getSnapshot().workbench.navigation.current).toMatchObject({ kind: 'work', view: { kind: 'room' } })
  const history = store.getSnapshot().workbench.navigation
  store.resizePanel('right', 480)
  expect(store.getSnapshot().workbench.navigation).toBe(history)
  store.openDestination({ kind: 'teams', filter: 'active' })
  const length = store.getSnapshot().workbench.navigation.back.length
  store.replaceDestination({ kind: 'teams', filter: 'settled' })
  expect(store.getSnapshot().workbench.navigation.back).toHaveLength(length)
})

test('Changes review captures remembered work without changing its layout or docks', () => {
  const store = new AppStore('ws://localhost:0/')
  store.openTeamRoom('team-demo')
  store.setTeamFramePage('team-demo', 'run')
  const before = store.getSnapshot().workbench
  store.openReview()
  expect(store.getSnapshot().workbench.navigation.current).toEqual({ kind: 'changes-review', root: null,
    returnTo: { kind: 'room', room: 'team-demo', framePage: 'run' } })
  expect(store.getSnapshot().layout).toBe(before.main)
  expect(store.getSnapshot().workbench.right).toBe(before.right)
  expect(store.getSnapshot().workbench.bottom).toBe(before.bottom)
  store.returnToWork()
  expect(store.getSnapshot().layout).toBe(before.main)
})


test('review freezes its root and originating work, then returns without closing it', () => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), { workspace: { path: '/synthetic/project', name: 'project' } })
  const origin = store.getSnapshot().workbench.navigation.current
  store.openReview()
  const review = store.getSnapshot().workbench.navigation.current
  if (review.kind !== 'changes-review' || origin.kind !== 'work') throw new Error('review/work expected')
  expect(review.root).toBe('/synthetic/project')
  expect(review.returnTo).toEqual(origin.view)
  store.openDestination(settings)
  expect(store.selectWork(review.returnTo)).toBe(true)
  expect(store.getSnapshot().workbench.navigation.current).toEqual(origin)
})

test('review receipt bridge refuses a missing conversation without changing navigation or work', () => {
  const store = new AppStore('ws://localhost:0/')
  store.openReview()
  const before = store.getSnapshot().workbench
  expect(store.selectWork({ kind: 'conversation', session: 'synthetic:missing' as never })).toBe(false)
  expect(store.getSnapshot().workbench).toBe(before)
})

test('review receipt bridge returns to the captured Team view with docks and layout intact', () => {
  const store = new AppStore('ws://localhost:0/')
  store.openTeamRoom('team-demo')
  store.setTeamFramePage('team-demo', 'run')
  const before = store.getSnapshot().workbench
  store.openReview()
  const review = store.getSnapshot().workbench.navigation.current
  if (review.kind !== 'changes-review') throw new Error('review expected')
  expect(store.selectWork(review.returnTo)).toBe(true)
  expect(store.getSnapshot().workbench.navigation.current).toEqual(before.navigation.current)
  expect(store.getSnapshot().layout).toBe(before.main)
  expect(store.getSnapshot().workbench.right).toBe(before.right)
  expect(store.getSnapshot().workbench.bottom).toBe(before.bottom)
})
