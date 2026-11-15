import assert from 'node:assert/strict'
import test from 'node:test'
import { repairMissingInterface, DOWNLOAD_PAGE } from './installation-repair.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const rig = ({ enabled = true } = {}) => {
  let menu = enabled ? { label: 'Check for Updates…', enabled: true, action: 'check', click() {} } : null
  let closed = false, checks = 0, quits = 0, installs = 0
  const dialogs = [], opens = [], pending = []
  const updates = { menu: () => menu, check: () => { checks++ } }
  const showDialog = request => { dialogs.push(request); return new Promise(resolve => pending.push(resolve)) }
  const repair = repairMissingInterface({ updates, showDialog, openExternal: async url => opens.push(url), quit: () => { quits++; closed = true }, stopped: () => closed })
  return { repair, dialogs, opens, pending, checks: () => checks, quits: () => quits, installs: () => installs,
    setMenu(value) { menu = value }, ready() { menu = { label: 'Restart to Update (1.2.3)', enabled: true, action: 'install', click: () => { installs++ } } }, stop() { closed = true } }
}

test('packaged repair stays alive and offers explicit download and update actions', async () => {
  const r = rig()
  assert.equal(r.dialogs.length, 1)
  assert.doesNotMatch(JSON.stringify(r.dialogs[0]), /pnpm build/)
  assert.deepEqual(r.dialogs[0].buttons, ['Open Downloads', 'Check for Updates', 'Quit'])
  r.pending.shift()(0); await tick()
  assert.deepEqual(r.opens, [DOWNLOAD_PAGE]); assert.equal(r.dialogs.length, 2); assert.equal(r.quits(), 0)
  r.pending.shift()(1); await tick()
  assert.equal(r.checks(), 1); assert.equal(r.dialogs.length, 3)
  r.pending.shift()(2); assert.equal(await r.repair, 'quit'); assert.equal(r.quits(), 1)
})

test('downloaded update uses existing install action once and stops presenting dialogs', async () => {
  const r = rig(); r.ready()
  r.pending.shift()(1); await tick()
  assert.equal(r.dialogs.length, 2)
  assert.deepEqual(r.dialogs[1].buttons, ['Open Downloads', 'Restart to Update', 'Quit'])
  r.pending.shift()(1); assert.equal(await r.repair, 'install')
  assert.equal(r.installs(), 1); assert.equal(r.dialogs.length, 2); assert.equal(r.quits(), 0)
})

test('disabled updates omit the check and Escape quits', async () => {
  const r = rig({ enabled: false })
  assert.deepEqual(r.dialogs[0].buttons, ['Open Downloads', 'Quit'])
  assert.equal(r.dialogs[0].cancelId, 1)
  r.pending.shift()(1); assert.equal(await r.repair, 'quit'); assert.equal(r.checks(), 0)
})

test('no action or new dialog occurs after quit begins while the dialog is pending', async () => {
  const r = rig(); r.stop(); r.pending.shift()(0)
  assert.equal(await r.repair, 'stopped'); assert.equal(r.opens.length, 0); assert.equal(r.dialogs.length, 1)
})

test('the actual startup routes packaged missing UI to repair before Host construction', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const start = async () => {')
  const bootstrap = source.indexOf('  const bootstrap = createDefaultHost(', start)
  assert.ok(start >= 0 && bootstrap > start)
  const section = source.slice(start + 'const start = async () => {'.length, bootstrap)
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
  const run = new AsyncFunction('app', 'existsSync', 'uiRoot', 'openInstallationRepair', `${section}\nreturn 'normal'`)
  let repairs = 0
  const repair = async () => { repairs++ }
  assert.equal(await run({isPackaged:true}, () => false, '/synthetic/ui', repair), undefined)
  assert.equal(repairs, 1)
  assert.equal(await run({isPackaged:false}, () => false, '/synthetic/ui', repair), 'normal')
  assert.equal(await run({isPackaged:true}, () => true, '/synthetic/ui', repair), 'normal')
  assert.equal(repairs, 1)
})

test('a refused browser launch is explained and repair remains available', async () => {
  const requests = []
  let quits = 0
  const choices = [0, 0, 1]
  const result = await repairMissingInterface({ updates: {menu: () => null},
    showDialog: async request => { requests.push(request); return choices.shift() },
    openExternal: async () => { throw new Error('synthetic') }, quit: () => { quits++ } })
  assert.equal(result, 'quit'); assert.equal(quits, 1)
  assert.match(requests[1].detail, /https:\/\//)
  assert.equal(requests.length, 3)
})

test('a failed update check does not abandon the repair dialog', async () => {
  const requests = []; let quits = 0
  const choices = [1, 0, 2]
  const updates = {menu: () => ({label:'Check for Updates…',enabled:true,action:'check'}), check: () => { throw new Error('synthetic') }}
  const result = await repairMissingInterface({updates, showDialog: async request => { requests.push(request); return choices.shift() },
    openExternal: async () => {}, quit: () => { quits++ }})
  assert.equal(result, 'quit'); assert.equal(quits, 1); assert.equal(requests.length, 3)
})

test('the actual repair startup attaches the existing updater and does not reach Host setup', async () => {
  const { readFile } = await import('node:fs/promises')
  const { EventEmitter } = await import('node:events')
  const { attachAppUpdates } = await import('./app-updates.mjs')
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8')
  const helper = source.indexOf('const startAppUpdates = () => {')
  const start = source.indexOf('const start = async () => {', helper)
  const bootstrap = source.indexOf('  const bootstrap = createDefaultHost(', start)
  assert.ok(helper >= 0 && start > helper && bootstrap > start)
  const text = source.slice(helper, start) + source.slice(start, bootstrap) + "\nreturn 'host-reached'\n}\nreturn start()"
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
  const run = new AsyncFunction('attachAppUpdates', 'repairMissingInterface', 'electronUpdater', 'app', 'existsSync', 'uiRoot', 'showMessage', 'shell', 'process', 'buildMenu', 'appUpdateBridge',
    'let appUpdates=null, updateMenuItem=null, repairMode=false, repairStopping=false, repairActive=false, repairResume=false, repairCheckStatus=null, logger=null;\n' + text)
  const updater = new EventEmitter(); let checks = 0, quits = 0, hostMenu = 0
  updater.checkForUpdates = () => { checks++; return Promise.resolve(null) }
  updater.quitAndInstall = () => {}; updater.setFeedURL = () => {}
  const dialogs = [], pending = []
  const promise = run(attachAppUpdates, repairMissingInterface, {autoUpdater:updater}, {isPackaged:true, getVersion:()=>'1.0', quit:()=>{quits++}},
    () => false, '/synthetic/ui', request => { dialogs.push(request); return new Promise(resolve => pending.push(resolve)) },
    {openExternal:async()=>{}}, {env:{}}, () => { hostMenu++ }, {publish:()=>{}})
  await tick()
  assert.equal(dialogs.length, 1); assert.equal(hostMenu, 0); assert.equal(quits, 0)
  pending.shift()(1); await tick(); assert.equal(checks, 1); assert.equal(dialogs.length, 2)
  pending.shift()(2); assert.equal(await promise, undefined); assert.equal(quits, 1)
})

test('background check outcomes are stated on the next repair dialog', async () => {
  const requests = [], choices = [1, 2]
  let outcome = null
  const updates = {menu:()=>({label:'Check for Updates…',enabled:true,action:'check'}), check:()=>{outcome='failed'}}
  const result = await repairMissingInterface({updates, showDialog:async request=>{requests.push(request);return choices.shift()},
    openExternal:async()=>{},quit:()=>{},status:()=>outcome,onCheck:()=>{outcome=null}})
  assert.equal(result,'quit')
  assert.match(requests[1].detail,/update check failed/i)
})

test('a delayed download failure cannot present a new dialog after quit starts', async () => {
  let rejectOpen, stopped = false, dialogs = 0
  const opened = new Promise((_,reject)=>{rejectOpen=reject})
  const result = repairMissingInterface({updates:{menu:()=>null}, showDialog:async()=>{dialogs++; return 0},
    openExternal:()=>opened, quit:()=>{}, stopped:()=>stopped})
  await tick(); stopped = true; rejectOpen(new Error('synthetic')); assert.equal(await result,'stopped'); assert.equal(dialogs,1)
})

test('the actual startup resumes repair after a failed install without overlapping dialogs', async () => {
  const { readFile } = await import('node:fs/promises')
  const { EventEmitter } = await import('node:events')
  const { attachAppUpdates } = await import('./app-updates.mjs')
  const source = await readFile(new URL('./main.mjs', import.meta.url), 'utf8')
  const helper = source.indexOf('const startAppUpdates = () => {'), start = source.indexOf('const start = async () => {', helper)
  const bootstrap = source.indexOf('  const bootstrap = createDefaultHost(', start)
  assert.ok(helper >= 0 && start > helper && bootstrap > start)
  const text = source.slice(helper, start) + source.slice(start, bootstrap) + "\nreturn 'host-reached'\n}\nreturn start()"
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
  const run = new AsyncFunction('attachAppUpdates', 'repairMissingInterface', 'electronUpdater', 'app', 'existsSync', 'uiRoot', 'showMessage', 'shell', 'process', 'buildMenu', 'appUpdateBridge',
    'let appUpdates=null, updateMenuItem=null, repairMode=false, repairStopping=false, repairActive=false, repairResume=false, repairCheckStatus=null, logger=null;\n' + text)
  const updater = new EventEmitter(); let quits = 0, active = 0, maxActive = 0
  updater.checkForUpdates = () => Promise.resolve(null)
  updater.quitAndInstall = () => { throw new Error('synthetic') }; updater.setFeedURL = () => {}
  const dialogs = [], pending = []
  const promise = run(attachAppUpdates, repairMissingInterface, {autoUpdater:updater}, {isPackaged:true, getVersion:()=>'1.0', quit:()=>{quits++}},
    () => false, '/synthetic/ui', request => { dialogs.push(request); active++; maxActive = Math.max(maxActive,active); return new Promise(resolve => pending.push(value=>{active--; resolve(value)})) },
    {openExternal:async()=>{}}, {env:{}}, ()=>{}, {publish:()=>{}})
  await tick(); updater.emit('update-downloaded',{version:'2'}); pending.shift()(1); await tick()
  assert.equal(dialogs[1].buttons[1],'Restart to Update')
  pending.shift()(1); await tick(); assert.match(dialogs[2].message,/couldn't be installed/)
  assert.equal(await promise,undefined); assert.equal(dialogs.length,3)
  pending.shift()(0); await tick(); assert.equal(dialogs.length,4); assert.equal(maxActive,1)
  pending.shift()(2); await tick(); assert.equal(quits,1); assert.equal(dialogs.length,4)
})
