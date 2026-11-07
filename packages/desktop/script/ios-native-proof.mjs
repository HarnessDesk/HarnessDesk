/** Local only: targets an existing disposable hd-input-proof-* simulator. Never creates or selects another device. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const at = process.argv.indexOf('--udid')
const udid = process.argv[at+1]
assert(at >= 0 && /^[0-9a-f-]{36}$/i.test(udid), 'Pass the disposable device UUID with --udid.')
const { stdout: listing } = await run('xcrun', ['simctl','list','devices','-j'])
const device = Object.values(JSON.parse(listing).devices).flat().find(d => d.udid === udid)
assert(device?.name.startsWith('hd-input-proof-') && device.state === 'Booted', 'Only a booted hd-input-proof-* device is allowed.')
const scratch = resolve(root, 'output/ios-input')
const app = resolve(scratch, 'InputFixture.app')
await mkdir(app, { recursive:true })
const fixture = resolve(root, 'packages/desktop/test/fixtures/ios-input')
await copyFile(resolve(fixture,'Info.plist'),resolve(app,'Info.plist'))
const { stdout:sdk } = await run('xcrun',['--sdk','iphonesimulator','--show-sdk-path'])
await run('xcrun',['swiftc','-sdk',sdk.trim(),'-target','arm64-apple-ios26.0-simulator',resolve(fixture,'main.swift'),'-o',resolve(app,'InputFixture')],{timeout:120000})
await run('codesign',['--force','--sign','-',app])
await run('xcrun',['simctl','install',udid,app])
await run('xcrun',['simctl','launch',udid,'app.harnessdesk.input-fixture'])
const helper = resolve(root,'packages/cordis-host/dist/native/darwin-arm64/hd-ios-control')
const pointer = async () => JSON.parse((await run(helper,['--pointer'])).stdout)
const before = await pointer()
// Observe only; never close or change another person's Simulator window.
const processes = (await run('ps',['-axo','comm'])).stdout
assert(!processes.split('\n').some(s => /\/(Simulator|Device Hub)\.app\//.test(s)), 'The closed-app proof requires Simulator and Device Hub to already be closed.')
const { spawn } = await import('node:child_process')
async function request(action) {
  const child = spawn(helper,[],{env:process.env,stdio:['pipe','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',d=>stdout+=d)
  child.stderr.on('data',d=>stderr+=d)
  child.stdin.end(JSON.stringify({id:'proof',protocolVersion:1,udid,operation:'interact',action})+'\n')
  const code = await new Promise((res,rej)=> { child.on('error',rej); child.on('exit',res) })
  assert.equal(code,0,stderr)
  const response=JSON.parse(stdout)
  assert(!response.error, JSON.stringify(response.error))
  return response.result
}
await new Promise(r=>setTimeout(r,1500))
await request({kind:'tap',x:300,y:1800})
await request({kind:'pinch',center:{x:600,y:1700},startDistance:250,endDistance:650,durationMs:600})
await request({kind:'tap',x:300,y:540})
await request({kind:'text',text:'Native proof 27'})
await request({kind:'key',key:'return',count:1})
await new Promise(r=>setTimeout(r,500))
const {stdout:container} = await run('xcrun',['simctl','get_app_container',udid,'app.harnessdesk.input-fixture','data'])
const receipts = JSON.parse(await readFile(resolve(container.trim(),'Documents/receipts.json'),'utf8'))
assert(receipts.some(r=>r.kind==='touch' && r.phase==='began'), 'No tap receipt.')
assert(receipts.some(r=>r.kind==='pinch' && r.scale > 1.5), 'No two-contact pinch receipt.')
assert(receipts.some(r=>r.kind==='text' && r.text==='Native proof 27'), 'No text receipt.')
assert(receipts.some(r=>r.kind==='key' && r.key==='return'), 'No Return receipt.')
const after = await pointer()
assert.deepEqual(after,before,'The macOS pointer moved during native input.')
const result={udid,device:device.name,simulatorApp:'closed',pointerBefore:before,pointerAfter:after,receipts}
await writeFile(resolve(scratch,'native-proof.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
