// A real subprocess tree with the same inherited pipes as npm's Electron CLI.
// The helper deliberately refuses SIGTERM; no Electron or display is needed.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { closeDesk, connectDesk } from '../lib/desk.mjs'

const mode = process.argv[2]
const helper = mode === 'slow-disposal' ? `
  ;(async () => {
    const { spawn } = require('node:child_process')
    const { once, EventEmitter } = require('node:events')
    const { attachQuitSignals } = await import(${JSON.stringify(new URL('../../packages/desktop/electron/quit-signals.mjs', import.meta.url).href)})
    const runtime = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    await once(runtime, 'spawn')
    const app = new EventEmitter()
    app.quit = () => app.emit('before-quit')
    app.on('before-quit', async () => {
      await new Promise(resolve => setTimeout(resolve, 6500))
      const closed = once(runtime, 'close')
      process.kill(-runtime.pid, 'SIGTERM')
      await closed
    })
    attachQuitSignals(app)
    console.log('runtime:' + runtime.pid)
  })()
` : `
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
let runtime
child.stdout.on('data', chunk => {
  const match = /runtime:(\d+)/.exec(chunk.toString())
  if (match) {
    runtime = Number(match[1])
    console.log(`runtime:${runtime}`)
  }
})
await once(child.stdout, 'data')
if (mode === 'exited-launcher' && child.exitCode === null) await once(child, 'exit')
const desk = { child, processGroup: child.pid }
let logFinished = false
const sink = { writableEnded: false, end: done => { logFinished = true; done() } }
const incompleteDisposal = error => error instanceof AggregateError
  && error.errors.some(one => /runtime disposal could not be confirmed/.test(one.message))
if (mode === 'discovery-failure') {
  await assert.rejects(connectDesk({ ...desk, sink, browserUrl: 'ws://owned', port: 1,
    discoveryAttempts: 0,
  }), error => error instanceof AggregateError
    && /no renderer appeared/.test(error.errors[0].message)
    && incompleteDisposal(error.errors[1]))
} else if (mode === 'connected') {
  const connected = await connectDesk({
    ...desk, sink, port: 1, browserUrl: 'ws://owned',
    sleepImpl: async () => {},
    fetchImpl: async url => ({ json: async () => url.endsWith('/json/version')
      ? { webSocketDebuggerUrl: 'ws://owned' }
      : [{ type: 'page', title: 'HarnessDesk', webSocketDebuggerUrl: 'ws://renderer' }] }),
    openCdp: async () => ({ eval: async () => true, close: () => {} }),
  })
  await assert.rejects(closeDesk(connected), incompleteDisposal)
} else if (mode === 'slow-disposal') {
  try {
    await assert.rejects(closeDesk({ ...desk, sink }), incompleteDisposal)
    // The separate group survives the interrupted disposer even though the
    // launcher's own pipes close. A successful cleanup result would be false.
    process.kill(runtime, 0)
    console.log('detached-runtime-survived')
  } finally {
    if (runtime) process.kill(-runtime, 'SIGKILL')
  }
} else if (mode === 'normal-helper') {
  await closeDesk({ ...desk, sink, cdp: { close: () => {} } })
} else {
  await assert.rejects(closeDesk({ ...desk, sink, cdp: { close: () => {} } }), incompleteDisposal)
}
console.log(JSON.stringify({
  stdoutClosed: child.stdout.destroyed,
  stderrClosed: child.stderr.destroyed,
  logFinished,
  resources: process.getActiveResourcesInfo(),
}))
console.log('cleanup-complete')
// Natural process termination is the assertion: the parent imposes a deadline.
