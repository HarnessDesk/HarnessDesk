/** Local only: targets an existing disposable hd-input-proof-* simulator. Never creates or selects another device. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { measureProofEnvironment } from './ios-proof-environment.mjs'
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
await run('xcrun',['simctl','terminate',udid,'app.harnessdesk.input-fixture']).catch(()=>{})
await run('xcrun',['simctl','install',udid,app])
await run('xcrun',['simctl','launch',udid,'app.harnessdesk.input-fixture'])
const metadata = await measureProofEnvironment({ run, devices: JSON.parse(listing), udid, arch: process.arch })
const helper = resolve(root, metadata.helper)
const measurement=resolve(scratch,'fixture-before.png')
await run('xcrun',['simctl','io',udid,'screenshot',measurement])
const png=await readFile(measurement)
const geometry={width:png.readUInt32BE(16),height:png.readUInt32BE(20),rotation:0}
assert(geometry.width===1206 && geometry.height===2622,'This recorded fixture trajectory requires a 1206 × 2622 portrait simulator.')
const pointer = async () => JSON.parse((await run(helper,['--pointer'])).stdout)
const stateAt=process.argv.indexOf('--window-state')
const windowState=stateAt<0?'closed':process.argv[stateAt+1]
assert(['closed','moved','minimized'].includes(windowState),'Choose closed, moved or minimized.')
let windowReceipt=''
if(windowState!=='closed') {
  const script=`tell application "System Events"
    tell process "DeviceHub"
      set ownedWindows to every window whose name contains "${device.name}"
      if (count of ownedWindows) is not 1 then error "The owned simulator window is not uniquely visible."
      set ownedWindow to item 1 of ownedWindows
      set value of attribute "AXMinimized" of ownedWindow to false
      set position of ownedWindow to {200, 100}
      set size of ownedWindow to {460, 760}
      ${windowState==='minimized'?'set value of attribute "AXMinimized" of ownedWindow to true':''}
      return {name of ownedWindow, position of ownedWindow, size of ownedWindow, value of attribute "AXMinimized" of ownedWindow}
    end tell
  end tell`
  windowReceipt=(await run('osascript',['-e',script],{timeout:10000})).stdout.trim()
}
const before = await pointer()
// Observe only; never close or change another person's Simulator window.
const processes = (await run('ps',['-axo','comm'])).stdout
if(windowState==='closed') assert(!processes.split('\n').some(s => /\/(Simulator|DeviceHub|Device Hub)\.app\//.test(s)), 'The closed-app proof requires Simulator and Device Hub to already be closed.')
const { spawn } = await import('node:child_process')
async function request(action) {
  const child = spawn(helper,[],{env:process.env,stdio:['pipe','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',d=>stdout+=d)
  child.stderr.on('data',d=>stderr+=d)
  child.stdin.end(JSON.stringify({id:'proof',protocolVersion:1,udid,operation:'interact',geometry,action})+'\n')
  const code = await new Promise((res,rej)=> { child.on('error',rej); child.on('exit',res) })
  assert.equal(code,0,stderr)
  const response=JSON.parse(stdout)
  assert(!response.error, JSON.stringify(response.error))
  return response.result
}
await new Promise(r=>setTimeout(r,1500))
await request({kind:'tap',x:300,y:1800})
await request({kind:'longPress',x:600,y:1300,durationMs:750})
await request({kind:'swipe',from:{x:300,y:1800},to:{x:800,y:1800},durationMs:350})
await request({kind:'drag',path:[{x:200,y:2000,tMs:0},{x:600,y:1900,tMs:200},{x:900,y:2100,tMs:400}]})
await request({kind:'rotateGesture',center:{x:600,y:1600},radius:200,angleDegrees:90,durationMs:600})
await request({kind:'pinch',center:{x:600,y:1700},startDistance:250,endDistance:650,durationMs:600})
await request({kind:'tap',x:300,y:540})
await request({kind:'text',text:'Native proof 27'})
await request({kind:'key',key:'return',count:1})
await request({kind:'button',button:'home',durationMs:100})
await new Promise(r=>setTimeout(r,500))
const {stdout:container} = await run('xcrun',['simctl','get_app_container',udid,'app.harnessdesk.input-fixture','data'])
let receipts=[]
const deadline=Date.now()+3000
while(Date.now()<deadline) {
  receipts=JSON.parse(await readFile(resolve(container.trim(),'Documents/receipts.json'),'utf8'))
  if(receipts.some(r=>r.kind==='lifecycle' && r.state==='background')) break
  await new Promise(r=>setTimeout(r,50))
}
assert(receipts.some(r=>r.kind==='touch' && r.phase==='began'), 'No tap receipt.')
assert(receipts.some(r=>r.kind==='touch' && r.phase==='moved'), 'No drag or swipe receipt.')
assert(receipts.some(r=>r.kind==='rotate' && Math.abs(r.angle)>0.8), 'No rotation-gesture receipt.')
const held=receipts.filter(r=>r.kind==='touch' && r.contacts.length===1 && Math.abs(r.contacts[0].x-200)<1 && Math.abs(r.contacts[0].y-1300/3)<1)
assert(held.some(r=>r.phase==='ended' && held.some(b=>b.phase==='began' && r.atSeconds-b.atSeconds>0.7)), 'No timed long-press receipt.')
assert(receipts.some(r=>r.kind==='pinch' && r.scale > 1.5), 'No two-contact pinch receipt.')
assert(receipts.some(r=>r.kind==='text' && r.text==='Native proof 27'), 'No text receipt.')
assert(receipts.some(r=>r.kind==='key' && r.key==='return'), 'No Return receipt.')
assert(receipts.some(r=>r.kind==='lifecycle' && r.state==='background'), 'No Home-button lifecycle receipt.')
await run('xcrun',['simctl','launch',udid,'app.harnessdesk.input-fixture'])
const after = await pointer()
assert.deepEqual(after,before,'The macOS pointer moved during native input.')
const result={udid,device:device.name,runtime:metadata.runtime,runtimeIdentifier:metadata.runtimeIdentifier,xcode:metadata.xcode,simulatorApp:windowState,windowReceipt,pointerBefore:before,pointerAfter:after,receipts}
await writeFile(resolve(scratch,`native-proof-${windowState}.json`),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result,null,2))
