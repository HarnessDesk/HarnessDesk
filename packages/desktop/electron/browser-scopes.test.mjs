import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { browserPartition, createProfileBrowserEngine } from './browser-scopes.mjs'

function rig(keep = true, storedPartitions = []) {
  const ipc = new EventEmitter()
  const sessions = new Map()
  const sessionForPartition = (key) => {
    if (!sessions.has(key)) sessions.set(key, {
      storageClears: 0, cacheClears: 0,
      async clearStorageData() { this.storageClears++; delete this.cookies; delete this.localStorage },
      async clearCache() { this.cacheClears++ },
    })
    return sessions.get(key)
  }
  const contents = new Map()
  const fronts = []
  let visible = null
  const window = {
    isDestroyed: () => false,
    webContents: {
      send(channel, payload) {
        if (channel === 'harnessdesk:browser-show') {
          const wc = makeGuest(payload.profile)
          ipc.emit(
            'harnessdesk:browser-ready',
            { sender: window.webContents },
            { profile: payload.profile, webContentsId: wc.id },
          )
        }
        if (channel === 'harnessdesk:browser-focus') {
          visible = payload.profile
          fronts.push(visible)
          ipc.emit(
            'harnessdesk:browser-focused',
            { sender: window.webContents },
            payload,
          )
        }
      },
    },
  }
  function makeGuest(profile) {
    const wc = new EventEmitter()
    const debug = new EventEmitter()
    let attached = false
    Object.assign(debug, {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
      },
      sendCommand: async (method) => {
        if (method === 'Runtime.evaluate') {
          assert.equal(visible, profile)
          return { result: { value: profile } }
        }
        if (method === 'Page.captureScreenshot') {
          assert.equal(visible, profile)
          return { data: Buffer.from(String(profile)).toString('base64') }
        }
        return {}
      },
    })
    Object.assign(wc, {
      id: contents.size + 1,
      session: sessionForPartition(browserPartition(profile, keep)),
      hostWebContents: window.webContents,
      getType: () => 'webview',
      isDestroyed: () => false,
      debugger: debug,
      focus() {},
    })
    contents.set(wc.id, wc)
    return wc
  }
  const allowedProfiles = new Set(['lane-a', 'lane-b', 'session-WyJhIiwiMSJd', 'session-WyJhIiwiMiJd'])
  const engine = createProfileBrowserEngine({
    ipc,
    contents: { fromId: (id) => contents.get(id) },
    sessionForPartition,
    window: () => window,
    show: async () => window,
    allowedProfile: profile => allowedProfiles.has(profile),
    storedPartitions: typeof storedPartitions === 'function' ? storedPartitions : async () => storedPartitions,
    resolveProfile: partition => ['session-WyJhIiwiMSJd', 'session-WyJhIiwiMiJd'].find(profile => [browserPartition(profile, true), browserPartition(profile, false)].includes(partition)),
    keep: () => keep,
    readyTimeoutMs: 25,
  })
  return { engine, ipc, window, makeGuest, fronts, contents, sessionForPartition, allowedProfiles }
}

const identity = (profile) => ({ invocation: `call-${profile}`, profile })

test('concurrent senders stay bound to their own guest and wait for that profile to be fronted', async () => {
  const { engine, fronts } = rig()
  const [a, b] = await Promise.all([
    engine.ensure(identity('lane-a')),
    engine.ensure(identity('lane-b')),
  ])
  const values = await Promise.all([a.send('Runtime.evaluate'), b.send('Runtime.evaluate')])
  assert.deepEqual(
    values.map((value) => value.result.value),
    ['lane-a', 'lane-b'],
  )
  assert.deepEqual(fronts, ['lane-a', 'lane-b'])
  const shots = await Promise.all([engine.capture(1), engine.capture(2)])
  assert.deepEqual(
    shots.map((value) => value.toString()),
    ['lane-a', 'lane-b'],
  )
})

test('foreign renderer, foreign host and wrong partition cannot announce a driven guest', async () => {
  const { engine, ipc, window, makeGuest } = rig()
  const a = makeGuest('lane-a')
  const announce = (sender, profile) =>
    ipc.emit(
      'harnessdesk:browser-ready',
      { sender },
      { profile, webContentsId: a.id },
    )
  announce({}, 'lane-a')
  assert.equal(engine.knows(a.id), false)
  announce(window.webContents, 'lane-b')
  assert.equal(engine.knows(a.id), false)
  a.hostWebContents = {}
  announce(window.webContents, 'lane-a')
  assert.equal(engine.knows(a.id), false)
  a.hostWebContents = window.webContents
  announce(window.webContents, 'lane-a')
  assert.equal(engine.knows(a.id), true)
  await assert.rejects(engine.ensure(identity('lane-unknown')), /not owned/)
})

test('closing B preserves A, and event drains do not cross profiles', async () => {
  const { engine, contents } = rig()
  const a = await engine.ensure(identity('lane-a'))
  const b = await engine.ensure(identity('lane-b'))
  contents.get(1).debugger.emit('message', {}, 'Log.entryAdded', { text: 'A' })
  contents.get(2).debugger.emit('message', {}, 'Log.entryAdded', { text: 'B' })
  assert.deepEqual(await a.drain(), [{ method: 'Log.entryAdded', params: { text: 'A' } }])
  assert.deepEqual(await b.drain(), [{ method: 'Log.entryAdded', params: { text: 'B' } }])
  await engine.close(identity('lane-b'))
  assert.equal((await a.send('Runtime.evaluate')).result.value, 'lane-a')
})

test('default browser remains available and unknown partition strings refuse', async () => {
  const { engine } = rig()
  const ordinary = await engine.ensure()
  assert.equal((await ordinary.send('Runtime.evaluate')).result.value, null)
  assert.throws(() => engine.partition('../personal'), /host did not name/)
})


test('session profiles isolate persistent storage, restore admission and close independently', async () => {
  const { engine, contents } = rig()
  const aProfile = 'session-WyJhIiwiMSJd'
  const bProfile = 'session-WyJhIiwiMiJd'
  const a = await engine.ensure(identity(aProfile))
  const b = await engine.ensure(identity(bProfile))
  const [aGuest, bGuest] = [...contents.values()]
  aGuest.session.cookies = { login: 'alpha' }
  aGuest.session.localStorage = { login: 'alpha' }
  assert.notEqual(aGuest.session, bGuest.session)
  assert.equal(bGuest.session.cookies, undefined)
  assert.equal(bGuest.session.localStorage, undefined)
  assert.equal(engine.profileForPartition(browserPartition(aProfile, true)), aProfile)
  assert.equal(engine.profileForPartition('persist:hd-session-forged'), undefined)
  await engine.close(identity(bProfile))
  assert.equal((await a.send('Runtime.evaluate')).result.value, aProfile)
  assert.equal(aGuest.session.cookies.login, 'alpha')
  await assert.rejects(engine.ensure(identity('session-forged')), /not owned/)
})

test('persisted session partitions stay distinct after Electron lowercases their directory names', () => {
  const first = 'session-WyJmaXh0dXJlIiwiYWFhIl0'
  const second = 'session-WyJmaXh0dXJlIiwiYWFHIl0'
  assert.notEqual(browserPartition(first, true).toLowerCase(), browserPartition(second, true).toLowerCase())
})

test('a long logical session identity stays within one portable filesystem component', () => {
  const profile = `session-${Buffer.from(JSON.stringify(['fixture', 's'.repeat(180)])).toString('base64url')}`
  assert.ok(Buffer.byteLength(browserPartition(profile, true).slice('persist:'.length)) <= 100)
})

test('cold hashed partitions need a host-owned logical identity before any guest announces itself', () => {
  const { engine } = rig()
  assert.equal(engine.profileForPartition(browserPartition('session-WyJhIiwiMSJd', true)), 'session-WyJhIiwiMSJd')
  assert.equal(engine.profileForPartition(`persist:hd-session-${'a'.repeat(64)}`), undefined)
})

test('session persistence follows the preference while legacy lanes stay persisted', () => {
  const profile = 'session-WyJhIiwiMSJd'
  assert.equal(browserPartition(profile, false), browserPartition(profile, true).slice('persist:'.length))
  assert.equal(browserPartition('lane-a', false), 'persist:hd-lane-a')
})

test('cold in-memory session partitions require the same known owner and remain isolated', async () => {
  const { engine, contents } = rig(false)
  const profile = 'session-WyJhIiwiMSJd'
  const memory = browserPartition(profile, true).slice('persist:'.length)
  assert.equal(engine.profileForPartition(memory), profile)
  assert.equal(engine.profileForPartition(`hd-session-${'a'.repeat(64)}`), undefined)
  assert.equal(engine.partition(profile), memory)
  const first = await engine.ensure(identity(profile))
  await engine.ensure(identity('session-WyJhIiwiMiJd'))
  const guests = [...contents.values()]
  assert.notEqual(guests[0].session, guests[1].session)
  assert.equal((await first.send('Runtime.evaluate')).result.value, profile)
})

test('global clear covers live and cold owned browser storage without clearing foreign or released profiles or changing the live mode', async () => {
  const profile = 'session-WyJhIiwiMSJd'
  const coldPartition = browserPartition(profile, true)
  const foreignPartition = `persist:hd-session-${'f'.repeat(64)}`
  const { engine, sessionForPartition, allowedProfiles } = rig(false, [coldPartition.slice('persist:'.length), 'hd-lane-b', foreignPartition.slice('persist:'.length), 'unrelated-agent'])
  const sender = await engine.ensure(identity(profile))
  const livePartition = browserPartition(profile, false)
  const live = sessionForPartition(livePartition)
  const cold = sessionForPartition(coldPartition)
  const released = sessionForPartition('persist:hd-lane-b')
  const foreign = sessionForPartition(foreignPartition)
  const other = sessionForPartition('persist:unrelated-agent')
  for (const target of [live, cold, released, foreign, other]) target.cookies = { login: 'fixture' }
  allowedProfiles.delete('lane-b')
  await engine.clearAllData()
  for (const target of [live, cold]) {
    assert.equal(target.cookies, undefined)
    assert.equal(target.storageClears, 1)
    assert.equal(target.cacheClears, 1)
  }
  for (const target of [released, foreign, other]) {
    assert.deepEqual(target.cookies, { login: 'fixture' })
    assert.equal(target.storageClears, 0)
  }
  assert.equal(engine.partition(profile), livePartition, 'cold discovery never changes the live guest partition')
  assert.equal((await sender.send('Runtime.evaluate')).result.value, profile)
})

test('global clear rechecks a lane released while persisted discovery is pending', async () => {
  let revoke = () => {}
  const { engine, contents, allowedProfiles } = rig(true, async () => { revoke(); return [] })
  await engine.ensure(identity('lane-b'))
  const guest = [...contents.values()][0]
  guest.session.cookies = { login: 'retained' }
  revoke = () => allowedProfiles.delete('lane-b')
  await engine.clearAllData()
  assert.deepEqual(guest.session.cookies, { login: 'retained' })
})

test('global clear reaches a known persistent session before any browser guest attaches after restart', async () => {
  const profile = 'session-WyJhIiwiMiJd'
  const persisted = browserPartition(profile, true)
  const { engine, sessionForPartition, contents } = rig(true, [persisted.slice('persist:'.length)])
  const cold = sessionForPartition(persisted)
  cold.cookies = { login: 'old' }
  await engine.clearAllData()
  assert.equal(cold.cookies, undefined)
  assert.equal(cold.cacheClears, 1)
  assert.equal(contents.size, 0)
})
