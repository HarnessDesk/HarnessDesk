import assert from 'node:assert/strict'
import { app, session } from 'electron'
import { createInlineBrowserEngine } from '../../electron/browser-engine.mjs'

app.setPath('userData', process.env.HD_COOKIE_PROFILE)
const profiles = ['session-fixtureA', 'session-fixtureB', 'session-fixtureMemory']
const engine = (keep) => createInlineBrowserEngine({
  window: () => null,
  show: () => {},
  allowedProfile: profile => profiles.includes(profile),
  keep: () => keep,
})

app.whenReady().then(async () => {
  const kept = engine(true)
  const transient = engine(false)
  const a = session.fromPartition(kept.partition(profiles[0]))
  const b = session.fromPartition(kept.partition(profiles[1]))
  const memory = session.fromPartition(transient.partition(profiles[2]))
  const request = async (target, path) => (await target.fetch(`${process.env.HD_COOKIE_URL}${path}`)).text()
  const expectCookies = async (target, expected) => assert.equal(await request(target, '/read'), expected)
  if (process.env.HD_COOKIE_PHASE === 'write') {
    await request(a, '/set')
    await request(memory, '/set')
    await expectCookies(a, 'fixture=present')
    await expectCookies(b, '')
    await expectCookies(memory, 'fixture=present')
    // Wait for Chromium's cookie store, then exit the process normally.
    await a.cookies.flushStore()
  } else {
    await expectCookies(a, 'fixture=present')
    await expectCookies(b, '')
    await expectCookies(memory, '')
  }
  console.log(`${process.env.HD_COOKIE_PHASE}: cookie assertions passed`)
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
