import { expect, it, vi } from 'vitest'
import { PREVIEW_ROOM, previewStore } from './harness'
import { overviewTeamStore } from './team-overview-fixture'

const OVERVIEW_TEAM = 'overview-team'
const twoTeams = () => {
  const primary = previewStore().getSnapshot().teams.get(PREVIEW_ROOM)!
  const other = overviewTeamStore('running').getSnapshot().teams.get(OVERVIEW_TEAM)!
  const teams = new Map([[PREVIEW_ROOM, primary], [OVERVIEW_TEAM, other]])
  return { teams, store: previewStore({ teams }) }
}

for (const target of [PREVIEW_ROOM, OVERVIEW_TEAM]) {
  it(`changes only the addressed preview Team's messaging: ${target}`, async () => {
    const { teams, store } = twoTeams()
    const original = teams.get(target)!
    const sibling = target === PREVIEW_ROOM ? OVERVIEW_TEAM : PREVIEW_ROOM
    const changed = vi.fn()
    const unsubscribe = store.subscribe(changed)
    try {
      await store.teamMessaging(target, false)
      const held = store.getSnapshot().teams
      expect([...held.keys()]).toEqual([...teams.keys()])
      expect(held.get(target)).toEqual({ ...original, messaging: false })
      expect(held.get(target)?.channel).toBe(original.channel)
      expect(held.get(sibling)).toBe(teams.get(sibling))
      expect(teams.get(target)).toBe(original)
      expect(teams.get(target)?.messaging).toBe(true)
      expect(changed).toHaveBeenCalledTimes(1)
      await store.teamMessaging(target, true)
      expect(store.getSnapshot().teams.get(target)?.messaging).toBe(true)
      expect(store.getSnapshot().teams.get(sibling)).toBe(teams.get(sibling))
      expect(changed).toHaveBeenCalledTimes(2)
    } finally { unsubscribe() }
  })
}

it('the actual Team wall fixture can hold and resume its own messaging', async () => {
  const store = overviewTeamStore('running')
  const before = store.getSnapshot()
  await store.teamMessaging(OVERVIEW_TEAM, false)
  expect(store.getSnapshot().teams.get(OVERVIEW_TEAM)?.messaging).toBe(false)
  expect(store.getSnapshot().goals).toBe(before.goals)
  expect(store.getSnapshot().flowExecutions).toBe(before.flowExecutions)
  await store.teamMessaging(OVERVIEW_TEAM, true)
  expect(store.getSnapshot().teams.get(OVERVIEW_TEAM)?.messaging).toBe(true)
})

it('an unknown preview Team resolves without fabricating a Team or changing existing Teams', async () => {
  const { teams, store } = twoTeams()
  const before = store.getSnapshot()
  const changed = vi.fn()
  const unsubscribe = store.subscribe(changed)
  try {
    await expect(store.teamMessaging('missing-team', false)).resolves.toBeUndefined()
    expect(store.getSnapshot()).toBe(before)
    expect(store.getSnapshot().teams).toBe(teams)
    expect([...teams.keys()]).toEqual([PREVIEW_ROOM, OVERVIEW_TEAM])
    expect(changed).not.toHaveBeenCalled()
  } finally { unsubscribe() }
})
