import assert from 'node:assert/strict'
import { app, session } from 'electron'
import { createInlineBrowserEngine } from '../../electron/browser-engine.mjs'
import { checkCookies } from '../browser-cookie-policy.mjs'

app.setPath('userData', process.env.HD_COOKIE_PROFILE)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('use-mock-keychain')
const profiles = ['session-fixtureA', 'session-fixtureB', 'session-fixtureMemory']
const engine = (keep) => createInlineBrowserEngine({
  window: () => null, show: () => {}, allowedProfile: profile => profiles.includes(profile), keep: () => keep,
})
app.whenReady().then(async () => {
  const kept = engine(true), transient = engine(false)
  const names = [kept.partition(profiles[0]), kept.partition(profiles[1]), transient.partition(profiles[2])]
  assert.equal(new Set(names).size, 3)
  assert.ok(names[0].startsWith('persist:') && names[1].startsWith('persist:') && !names[2].startsWith('persist:'))
  const [a, b, memory] = names.map(name => session.fromPartition(name))
  const url = new URL(process.env.HD_COOKIE_URL)
  assert.equal(url.hostname, '127.0.0.1')
  for (const target of [a, b, memory]) target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${url.origin}/`) })
  })
  const request = async (target, path) => (await target.fetch(`${url.origin}${path}`)).text()
  if (process.env.HD_COOKIE_PHASE === 'write') {
    await request(a, '/set/a')
    await request(b, '/set/b')
    await request(memory, '/set/memory')
  }
  checkCookies(process.env.HD_COOKIE_PHASE, { a: await request(a, '/read'), b: await request(b, '/read'), memory: await request(memory, '/read') })
  if (process.env.HD_COOKIE_PHASE === 'write') await Promise.all([a.cookies.flushStore(), b.cookies.flushStore()])
  console.log(`${process.env.HD_COOKIE_PHASE}: cookie assertions passed`)
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
