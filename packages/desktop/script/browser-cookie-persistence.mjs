// Native integration proof. Run with an absolute scratch directory as argv[2].
// The directory is only used for a temporary Electron profile and is removed on exit.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = process.argv[2]
if (!root || !isAbsolute(root)) throw new Error('Pass an absolute scratch directory')
const profile = await mkdtemp(join(root, 'cookie-profile-'))
const server = createServer((request, response) => {
  if (request.url === '/set') response.setHeader('Set-Cookie', 'fixture=present; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax')
  response.end(request.headers.cookie ?? '')
})
const fixture = fileURLToPath(new URL('./fixtures/browser-cookie-child.mjs', import.meta.url))
try {
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const url = `http://127.0.0.1:${server.address().port}`
  for (const phase of ['write', 'read']) {
    await new Promise((resolve, reject) => {
      const env = { ...process.env, HD_COOKIE_PROFILE: profile, HD_COOKIE_URL: url, HD_COOKIE_PHASE: phase }
      delete env.ELECTRON_RUN_AS_NODE
      const child = spawn(electron, [fixture], { env, stdio: 'inherit' })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        try { assert.equal(code, 0, `${phase} ${timedOut ? 'timed out' : `exited ${code} (${signal})`}`); resolve() } catch (error) { reject(error) }
      })
    })
  }
  console.log('Native cookie persistence, isolation and disabled persistence passed.')
} finally {
  await new Promise(resolve => server.close(resolve))
  await rm(profile, { recursive: true, force: true })
}
