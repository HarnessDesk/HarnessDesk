// Native Chromium cookie proof, against an owned loopback server and private profile.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
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
// Diagnostic-only: inspect owned process group fields, never command lines or environment.
const observeGroup = (pid, boundary) => {
  const members = []; let unreadable = 0
  for (const name of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8'), end = stat.lastIndexOf(')')
      if (end < 0) { unreadable++; continue }
      const fields = stat.slice(end + 2).split(' ')
      if (Number(fields[2]) === pid) members.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), state: fields[0], starttime: fields[19] })
    } catch { unreadable++ }
  }
  console.error('HD_COOKIE_GROUP_DIAGNOSTIC '+JSON.stringify({ boundary, pgid: pid, monotonicNs: process.hrtime.bigint().toString(), members, unreadable }))
}
const groupPresent = pid => {
  try { process.kill(-pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
// Only detached children spawned by this proof are ever signalled. Keep the
// profile until every such process group is demonstrably absent.
const ownedGroups = new Set()
const waitGone = async (pid, ms) => {
  const until = Date.now() + ms
  while (groupPresent(pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 25))
  return !groupPresent(pid)
}
const retireGroup = async pid => {
  if (!groupPresent(pid)) { ownedGroups.delete(pid); return }
  for (const [signal, ms] of [['SIGTERM', 2000], ['SIGKILL', 3000]]) {
    observeGroup(pid, `before-${signal}`)
    try { process.kill(-pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    if (await waitGone(pid, ms)) { ownedGroups.delete(pid); return }
  }
  throw new Error('owned process group could not be retired; profile retained')
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
  if (child.pid) ownedGroups.add(child.pid)
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
  child.once('close', async (code, signal) => {
    if (child.pid) observeGroup(child.pid, `${name}-leader-close`)
    clearTimeout(timer)
    clearTimeout(watchdog)
    try {
      if (spawnError) throw spawnError
      if (killError) throw killError
      assert.ok(child.stdout.destroyed && child.stderr.destroyed, `${name} left an owned output pipe open`)
      assert.equal(timedOut, false, `${name} timed out`)
      if (child.pid && groupPresent(child.pid)) {
        const leak = new Error(`${name} left an owned process group`)
        try { await retireGroup(child.pid) } catch (error) { throw new AggregateError([leak, error], `${name} cleanup failed; profile retained`) }
        throw leak
      }
      if (child.pid) ownedGroups.delete(child.pid)
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
  // A rejected phase (including a watchdog) can still own a live helper.
  // Never remove the profile unless all captured groups are gone.
  for (const pid of ownedGroups) await retireGroup(pid)
  await rm(profile, { recursive: true, force: true })
}
