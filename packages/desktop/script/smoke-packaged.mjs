#!/usr/bin/env node
/**
 * Packaged-app smoke: launch the built `.app` and ask its catalogue whether
 * every bridge actually shipped.
 *
 * `pnpm verify` never packages the app, so a packaging defect is invisible to
 * every test and every dev launch — the workspace serves the bridges as
 * ordinary files. This script is the check that runs against the artifact a
 * user would download: it boots the app with a throwaway home and profile,
 * reads `agents/catalog` through the real renderer, and fails on the one
 * sentence that means the build is missing a bridge: "This build of
 * HarnessDesk does not carry …". Rows that are unavailable because a CLI is
 * not installed on this machine are fine — that is the machine's fact, not
 * the build's.
 *
 *   pnpm --filter @harnessdesk/desktop run pack
 *   pnpm --filter @harnessdesk/desktop run smoke   # [path/to/HarnessDesk.app]
 *
 * The CDP port defaults to 9271; set HD_SMOKE_CDP_PORT when something else
 * owns it. The script refuses a port that already answers, so it can never
 * judge somebody else's Electron.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = fileURLToPath(new URL('.', import.meta.url))
const PORT = Number(process.env['HD_SMOKE_CDP_PORT'] ?? 9271)
// The first launch of a freshly signed bundle sits in Gatekeeper's scan for
// minutes before Electron runs a line — measured at 3m12s for this app — and
// during that scan the debugger port accepts connections it never answers.
// Hence the generous deadline, and a timeout on every individual call.
const READY_MS = 300_000

const fail = (message) => {
  console.error(`smoke: ${message}`)
  process.exitCode = 1
}

const appPath = (() => {
  if (process.argv[2]) return process.argv[2]
  const candidates = ['release/mac-arm64', 'release/mac', 'release/mac-x64'].map((dir) =>
    join(here, '..', dir, 'HarnessDesk.app'),
  )
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
})()
const binary = join(appPath, 'Contents/MacOS/HarnessDesk')
if (!existsSync(binary)) {
  fail(`no built app at ${appPath} — run \`pnpm --filter @harnessdesk/desktop run pack\` first`)
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const targets = async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, {
    signal: AbortSignal.timeout(3000),
  })
  return response.json()
}

/** One Runtime.evaluate over the page's debugger socket, result by value. */
const evaluate = (socketUrl, expression) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl)
    const expiry = setTimeout(() => {
      socket.close()
      reject(new Error('the page did not answer'))
    }, 10_000)
    socket.onerror = () => {
      clearTimeout(expiry)
      reject(new Error('debugger socket refused'))
    }
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(expiry)
      socket.close()
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description ?? 'threw'))
      } else {
        resolve(message.result?.result?.value)
      }
    }
  })

// A port that already answers belongs to some other Electron; judging that
// app's catalogue would be worse than not running.
const portFree = await targets().then(
  () => false,
  () => true,
)
if (!portFree) {
  fail(`port ${PORT} is already a debugger — set HD_SMOKE_CDP_PORT to a free one`)
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'hd-smoke-home-'))
const profile = mkdtempSync(join(tmpdir(), 'hd-smoke-profile-'))
const child = spawn(
  binary,
  [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`],
  { env: { ...process.env, HARNESSDESK_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] },
)
let stderr = ''
child.stderr.on('data', (chunk) => (stderr += String(chunk)))
let exited = null
child.on('exit', (code) => (exited = code ?? -1))

try {
  // The window, then the store: both take a moment, and an app that dies
  // early should say so with its own stderr rather than a timeout.
  const deadline = Date.now() + READY_MS
  let rows = null
  let lastProblem = 'the debugger never answered'
  while (Date.now() < deadline && rows === null) {
    if (exited !== null) {
      throw new Error(`the app exited (${exited}) before it was ready\n${stderr.slice(-2000)}`)
    }
    await sleep(500)
    try {
      const page = (await targets()).find(
        (target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1'),
      )
      if (!page) {
        lastProblem = 'no renderer page yet'
        continue
      }
      rows = await evaluate(
        page.webSocketDebuggerUrl,
        `window.__hdStore ? window.__hdStore.agentCatalog() : Promise.reject(new Error('store not mounted'))`,
      )
    } catch (error) {
      lastProblem = error instanceof Error ? error.message : String(error)
    }
  }
  if (rows === null) throw new Error(`not ready after ${READY_MS / 1000}s: ${lastProblem}`)

  // The store answers [] for a transport error, so an empty catalogue is a
  // failure here, never a pass.
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('the catalogue came back empty')
  }
  for (const row of rows) {
    console.log(
      `smoke: ${row.key} available=${row.available}${row.reason ? ` — ${row.reason}` : ''}`,
    )
  }
  const missing = rows.filter((row) => typeof row.reason === 'string' && row.reason.includes('does not carry'))
  if (missing.length > 0) {
    throw new Error(
      `this build is missing bridges: ${missing.map((row) => row.key).join(', ')} — ` +
        `check dependencies and asarUnpack in packages/desktop/package.json, ` +
        `and that pnpm build:node ran before packaging`,
    )
  }
  console.log(`smoke: ok — every bridge this build promises is on disk (${rows.length} rows)`)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  if (exited === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(3000)])
    if (exited === null) child.kill('SIGKILL')
  }
  rmSync(home, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
}
process.exit(process.exitCode ?? 0)
