import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const root = process.env.HD_STATE
const { createDefaultHost, loadBuiltinPlugins } = await import(process.env.HD_BOOTSTRAP)
const { host, extensions, pathReady } = createDefaultHost({ stateDir: root, codexHome: join(root, 'codex'), codexBinaryPath: process.env.HD_FAKE, console: false, logLevel: 'error' })
try {
 await pathReady
 await loadBuiltinPlugins(extensions)
 await host.start()
 const complete = id => new Promise(resolve => {
  const stop = host.addBroadcaster(n => { if (n.method === 'event' && n.params.runtime === id && n.params.event.type === 'account/loginCompleted' && n.params.event.success) { stop(); resolve() } })
 })
 let done = complete('codex')
 await host.call('runtime/login', { runtime: 'codex', method: 'chatgptDeviceCode' })
 await done
 const added = await host.call('runtime/account/add', { runtime: 'codex' })
 const home = JSON.parse(readFileSync(join(root,'accounts.json'),'utf8')).accounts.find(x => x.id === added.runtime).home
 done = complete(added.runtime)
 await host.call('runtime/login', { runtime: added.runtime, method: 'chatgptDeviceCode' })
 await done
 const until = Date.now() + 3000
 while (Date.now() < until && host.syncPayload().params.runtimes.some(r => r.id === added.runtime)) await new Promise(r => setTimeout(r, 20))
 assert.equal(host.syncPayload().params.runtimes.some(r => r.id === added.runtime), false, 'successful fileless duplicate login should remove extra runtime')
 assert.equal(existsSync(home), true)
 assert.equal(existsSync(join(home, 'auth.json')), false)
} finally { await host.dispose(); await extensions.dispose() }
