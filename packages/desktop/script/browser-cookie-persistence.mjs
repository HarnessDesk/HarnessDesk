// Native Chromium cookie proof, against an owned loopback server and private profile.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const profile = await mkdtemp(join(tmpdir(), 'hd-cookie-proof-'))
const server = createServer((request, response) => {
  const name = /^\/set\/(a|b|memory)$/.exec(request.url ?? '')?.[1]
  if (name) response.setHeader('Set-Cookie', `fixture=${name}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`)
  response.end(request.headers.cookie ?? '')
})
const fixture = fileURLToPath(new URL('./fixtures/browser-cookie-child.mjs', import.meta.url))
const groupPresent = pid => {
  try { process.kill(-pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
const phase = (name, url) => new Promise((resolve, reject) => {
  const env = {
    HOME: profile, TMPDIR: profile, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
    XDG_CONFIG_HOME: join(profile, 'config'), XDG_CACHE_HOME: join(profile, 'cache'),
    HD_COOKIE_PROFILE: profile, HD_COOKIE_URL: url, HD_COOKIE_PHASE: name,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  }
  const child = spawn(electron, [...(process.platform === 'linux' ? ['--no-sandbox'] : []), fixture], {
    env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  })
  child.stdout.pipe(process.stdout, { end: false })
  child.stderr.pipe(process.stderr, { end: false })
  let timedOut = false, spawnError, killError, watchdog
  const timer = setTimeout(() => {
    timedOut = true
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL') }
    catch (error) {
      if (error.code !== 'ESRCH') {
        killError = error
        try { child.kill('SIGKILL') } catch (fallback) { killError = new AggregateError([error, fallback], 'owned process cleanup failed') }
      }
    }
    watchdog = setTimeout(() => reject(killError ?? new Error(`${name} timed out and did not close`)), 5000)
  }, 30_000)
  child.once('error', error => { spawnError = error })
  child.once('close', (code, signal) => {
    clearTimeout(timer)
    clearTimeout(watchdog)
    try {
      if (spawnError) throw spawnError
      if (killError) throw killError
      assert.ok(child.stdout.destroyed && child.stderr.destroyed, `${name} left an owned output pipe open`)
      assert.equal(timedOut, false, `${name} timed out`)
      assert.equal(groupPresent(child.pid), false, `${name} left an owned process group`)
      assert.equal(code, 0, `${name} exited ${code} (${signal})`)
      resolve()
    } catch (error) { reject(error) }
  })
})
try {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const url = `http://127.0.0.1:${server.address().port}`
  await phase('write', url)
  await phase('read', url)
  console.log('Native cookie persistence, bidirectional isolation and disabled persistence passed.')
} finally {
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
