#!/usr/bin/env node
/**
 * When does Codex say `account/updated` on its own? Starts `codex app-server`,
 * says nothing to it but `initialize`, listens for a few seconds and prints
 * each notice's method and how long after the server was up it came. No
 * request, no account read, no turn, no network of this script's own.
 *
 *   pnpm build:node && node script/probe/account-notice.mjs [seconds] [--isolated]
 *
 * By default it runs on the agent's own home (`CODEX_HOME`, else `~/.codex`),
 * because the notice is about a signed-in account and only a signed-in home
 * has one. `--isolated` runs on an empty home, which is signed out.
 *
 * It prints method names and times, never a notice's contents: they carry the
 * account's own details. See script/probe/README.md.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

import { CodexAppServer } from '../../packages/codex/dist/src/index.js'

const isolated = process.argv.includes('--isolated')
const seconds = Number(process.argv.slice(2).find((one) => /^\d+(\.\d+)?$/.test(one)) ?? 4)
const home = isolated ? await mkdtemp(join(tmpdir(), 'hd-account-notice-')) : null

const server = new CodexAppServer({
  clientInfo: { name: 'harnessdesk-probe', title: 'HarnessDesk probe', version: '0.0.0' },
  binaryPath: null,
  codexHome: home,
  configOverrides: [],
  experimentalApi: true,
})
let upAt = 0
const heard = []
server.onStateChange((state) => { if (state.type === 'ready') upAt = Date.now() })
// A notice sent straight after the `initialize` reply is dispatched before the ready state is set: it came at +0.
server.onNotification((notice) => heard.push([upAt === 0 ? 0 : Date.now() - upAt, notice.method]))
try {
  await server.start()
  await pause(seconds * 1000)
} finally {
  await server.stop()
}

console.log(`${isolated ? 'an empty home (signed out)' : "the agent's own home"}, ${seconds} s:`)
console.log('  +0.00 s  ready')
for (const [at, method] of heard) console.log(`  +${(at / 1000).toFixed(2)} s  ${method}`)

// A fresh home is written into for a moment after the server is stopped (a plugin catalogue it clones).
if (home) await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
