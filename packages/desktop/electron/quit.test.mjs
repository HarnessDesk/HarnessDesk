import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8')
const handler = source.slice(source.indexOf("app.on('before-quit', async"), source.indexOf('// SIGTERM must'))

for (const failing of ['client door', 'phone link', 'server', 'host', 'extensions', 'log flush', 'tray']) {
  test(`quit finishes without a rejected handler when ${failing} fails`, async () => {
    const calls = [], failures = []
    const step = name => () => {
      calls.push(name)
      if (name === failing) throw new Error(`${name} failed: unsaved history`)
    }
    let quit
    const sandbox = {
      app: { on: (_name, callback) => { quit = callback }, quit: step('quit') },
      clientDoor: { close: step('client door') }, phoneLink: { close: step('phone link') },
      running: { close: step('server') }, host: { dispose: step('host') },
      extensions: { dispose: step('extensions') }, tray: { destroy: step('tray') },
      logger: { flush: step('log flush'), error: (message, detail) => failures.push({ message, detail }) },
    }
    vm.runInNewContext(handler, sandbox)
    await assert.doesNotReject(() => quit({ preventDefault: step('prevent') }))
    assert.deepEqual(calls, ['prevent', 'client door', 'phone link', 'server', 'host', 'extensions', 'log flush', 'tray', 'quit'])
    assert.equal(failures.length, 1)
    assert.match(failures[0].message, new RegExp(failing))
    assert.match(failures[0].detail.error, /failed: unsaved history/)
    await quit({ preventDefault: () => assert.fail('second quit must pass through') })
  })
}
