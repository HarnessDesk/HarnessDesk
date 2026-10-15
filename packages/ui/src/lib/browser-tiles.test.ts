import { expect, it } from 'vitest'
import { sessionKey, type GoalView, type Lane, type Session, type SeatRecord } from '@harnessdesk/protocol'
import { emptySnapshot } from '../state/store'
import { browserView } from '../state/layout'
import { dock, findView, readWorkbench, viewAt } from '../state/workbench'
import { BrowserTileRegistry, seatBrowserProfile, tileBrowserWorkbench } from './browser-tiles'

it('reads the frozen Seat checkout, refuses unknown and released lanes, and respects a shared profile', () => {
  const key = sessionKey('assistant', 'alpha')
  const snapshot = emptySnapshot()
  const seat = { session: { runtime: 'assistant', sessionId: 'alpha' }, checkout: { cwd: '/workspace/alpha' }, board: 'demo', closed: null } as SeatRecord
  const lanes = [{ cwd: '/workspace/alpha', browserProfile: 'lane-alpha', state: 'active' }] as Lane[]
  const known = { ...snapshot, lanePreferences: { start: 30000, width: 20, browserProfile: true }, lanes, goals: new Map([['demo', { goal: { checkout: 'isolated' }, members: [seat] } as unknown as GoalView]]), sessions: new Map([[key, { cwd: '/workspace/other' } as Session]]) }
  expect(seatBrowserProfile(snapshot, key)).toBeUndefined()
  expect(seatBrowserProfile(known, key)).toBe('lane-alpha')
  expect(seatBrowserProfile({ ...known, lanes: [] }, key)).toBeUndefined()
  expect(seatBrowserProfile({ ...known, lanes: [{ ...lanes[0]!, state: 'released' }] }, key)).toBeUndefined()
  expect(seatBrowserProfile({ ...known, lanes: [{ ...lanes[0]!, browserProfile: null }] }, key)).toBeNull()
})

it('hands a shared browser to the next mounted tile and ignores a repeated release', () => {
  const registry = new BrowserTileRegistry()
  const a = { paneId: 'room', key: sessionKey('assistant', 'alpha') }
  const b = { paneId: 'room', key: sessionKey('assistant', 'beta') }
  let owners: ReadonlyMap<string, typeof a> = new Map()
  const publish = (next: typeof owners) => { owners = next }
  const releaseA = registry.mount(null, a, publish)
  const releaseB = registry.mount(null, b, publish)
  expect(owners.get('default')).toBe(a)
  releaseA()
  expect(owners.get('default')).toBe(b)
  releaseA()
  expect(owners.get('default')).toBe(b)
  releaseB()
  expect(owners.size).toBe(0)
})

it('projects borrowed browsers away without changing saved tabs, other panels or restarted modes', () => {
  const snapshot = emptySnapshot()
  const key = sessionKey('assistant', 'alpha')
  const workbench = dock(dock(snapshot.workbench, 'right', browserView('https://example.com/alpha', 'lane-alpha')), 'right', { kind: 'room', room: 'demo', sideBySide: { tiles: [key], modes: { [key]: 'browser' }, expanded: key } })
  const browser = findView(workbench, browserView('about:blank', 'lane-alpha'))!
  const projected = tileBrowserWorkbench({ ...snapshot, workbench, browserTiles: new Map([['lane-alpha', { paneId: 'room', key }]]) })
  expect(findView(projected, browserView('about:blank', 'lane-alpha'))).toBeNull()
  expect(findView(projected, { kind: 'room', room: 'demo' })).not.toBeNull()
  expect(findView(workbench, browserView('about:blank', 'lane-alpha'))).toEqual(browser)
  const restored = readWorkbench(JSON.parse(JSON.stringify(workbench)))!
  const room = findView(restored, { kind: 'room', room: 'demo' })!
  expect(viewAt(restored, room.area === 'main' ? room.pane : room.mounted.id)).toMatchObject({ sideBySide: { modes: { [key]: 'browser' }, expanded: key } })
  expect(findView(restored, browserView('about:blank', 'lane-alpha'))).not.toBeNull()
})
