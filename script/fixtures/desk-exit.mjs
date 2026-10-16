// A real subprocess tree with the same inherited pipes as npm's Electron CLI.
// The helper deliberately refuses SIGTERM; no Electron or display is needed.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeDesk, connectDesk } from '../lib/desk.mjs'

const mode = process.argv[2]
const helper = `
  ${mode === 'normal-helper' ? '' : "process.on('SIGTERM', () => {})"}
  console.log('helper-ready')
  setInterval(() => {}, 1000)
`
const launcher = `
  const { spawn } = require('node:child_process')
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { stdio: 'inherit' })
  ${mode === 'exited-launcher' ? 'child.unref()' : "process.on('SIGTERM', () => child.kill('SIGTERM'))"}
`
const child = spawn(process.execPath, ['-e', launcher], {
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
console.log(`group:${child.pid}`)
await once(child.stdout, 'data')
if (mode === 'exited-launcher' && child.exitCode === null) await once(child, 'exit')
const desk = { child, processGroup: child.pid }
let logFinished = false
const sink = { writableEnded: false, end: done => { logFinished = true; done() } }
if (mode === 'discovery-failure') {
  try {
    await connectDesk({ ...desk, sink, browserUrl: 'ws://owned', port: 1,
      discoveryAttempts: 0,
    })
    throw new Error('discovery unexpectedly succeeded')
  } catch (error) {
    if (!/no renderer appeared/.test(error.message)) throw error
  }
} else if (mode === 'connected') {
  const connected = await connectDesk({
    ...desk, sink, port: 1, browserUrl: 'ws://owned',
    sleepImpl: async () => {},
    fetchImpl: async url => ({ json: async () => url.endsWith('/json/version')
      ? { webSocketDebuggerUrl: 'ws://owned' }
      : [{ type: 'page', title: 'HarnessDesk', webSocketDebuggerUrl: 'ws://renderer' }] }),
    openCdp: async () => ({ eval: async () => true, close: () => {} }),
  })
  await closeDesk(connected)
} else {
  await closeDesk({ ...desk, sink, cdp: { close: () => {} } })
}
console.log(JSON.stringify({
  stdoutClosed: child.stdout.destroyed,
  stderrClosed: child.stderr.destroyed,
  logFinished,
  resources: process.getActiveResourcesInfo(),
}))
console.log('cleanup-complete')
// Natural process termination is the assertion: the parent imposes a deadline.
