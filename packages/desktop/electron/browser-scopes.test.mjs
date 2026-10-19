import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { browserPartition, createProfileBrowserEngine } from './browser-scopes.mjs'

function rig(keep = true) {
  const ipc = new EventEmitter()
  const sessions = new Map()
  const sessionForPartition = (key) => {
    if (!sessions.has(key)) sessions.set(key, {})
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
  const engine = createProfileBrowserEngine({
    ipc,
    contents: { fromId: (id) => contents.get(id) },
    sessionForPartition,
    window: () => window,
    show: async () => window,
    allowedProfile: (profile) => ['lane-a', 'lane-b', 'session-WyJhIiwiMSJd', 'session-WyJhIiwiMiJd'].includes(profile),
    resolveProfile: partition => ['session-WyJhIiwiMSJd', 'session-WyJhIiwiMiJd'].find(profile => [browserPartition(profile, true), browserPartition(profile, false)].includes(partition)),
    keep: () => keep,
    readyTimeoutMs: 25,
  })
  return { engine, ipc, window, makeGuest, fronts, contents }
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
