// Source-pinned synthetic native proof; diagnostic branch only, never merge.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allowed, inspectPaths, SSH_SHIM } from './ambient-shape.mjs'
import { listenerCounts } from './listener-diagnostics.mjs'
import { makeLedger } from './seed.mjs'
import { interruptCount, recordInterrupt } from './counter.mjs'
import { inspectFrame } from './frame-policy.mjs'
import { locateTarget } from './click-target.mjs'
import { runGuarded } from './run-guarded.mjs'
import { assertSource } from './source-guard.mjs'

const taskSource = resolve('.')
const taskSha = '9fac46ae066acbc2ba2dddd4e0815a1b703a7a36' // integrated source commit; repin if source changes.
const expectedFixtureSha = '12e1e552085c154e507ac1100dbcd9bcaeaf8184696ad02e9a696c3929c529ac'
const preparedOnly = true // Requires renewed parent review before another run.
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', ['-C',taskSource,...args], {encoding:'utf8'}).trim()
const result={source:taskSha,phase:'preflight',checks:{},readiness:{}}
let desk, cdp, taskRoot, closeDesk
await runGuarded(result, async()=>{
if (preparedOnly) throw new Error('prepared only; no run authorized')
if (!/^[0-9a-f]{40}$/.test(taskSha) || !/^[0-9a-f]{64}$/.test(expectedFixtureSha)) throw new Error('final source pin missing')
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('hosted macOS runner required')
const fixture=join(taskSource,'diagnostic/stop-history/fake-codex-1545.mjs')
if (sha(fixture)!==expectedFixtureSha) throw new Error('fixture fingerprint mismatch')
const fingerprints = {
  'packages/server/src/intake/mentions.ts':'c9d3fffb7a0fec75d84a79c58894fdb135fdc6d373f530d9ce81bd5d5649c46b',
  'packages/server/src/intake/plane.ts':'22dc993ae1f9103a03e3aa7c6e9dec8d36e95e468bbe6e8f7852b630d730c352',
  'packages/ui/src/components/ProjectTriggers.tsx':'34074e404999e4f11f37f77fa27478d9c50e645adbb41f21f1c82096e398a071',
  'packages/ui/src/components/MentionDecisions.tsx':'87828bc77e27ce5344c68017822bc0e34cec99e0e6600d0cd69ace48623f3a73',
  'packages/ui/src/state/lead.ts':'acf6979520182e01636bc4b97507fc3bbe073b5b398acfb89597b1626f132124',
  'packages/protocol/src/lead.ts':'b6c23570ebd42d66284a059a0e0c14332d4d7c2782ab98b14c1b2dfd6fb330ee',
  'script/lib/desk.mjs':'0d0083de7abeb2c371f2e0723f82585a58c3427ea5a2f5ce4fa08e65355c0ab8',
  'script/shots/audit.mjs':'9922f1cb40d882d792ab3745b4c44a63e318b5d833952ab00cb0d431d85166c8',
  'diagnostic/stop-history/scripted-flow.mjs':'1b6f58123021ce772025a525aaedabd99784655772631299d27a6dbe4c8099d7',
  'diagnostic/stop-history/plugin-icon.svg':'611ca48d4da7767c7cc051442c2e389a2d5a288a2fbb09c5edd3f3b1e7499d79',
  'diagnostic/stop-history/ambient-shape.mjs':'d73b2956892802e0203bf1a6c6fc3a1c1161ad7a15f4ff7403c6630d19eb2343',
  'diagnostic/stop-history/listener-diagnostics.mjs':'b00522c989516ba2bac183d8ea5d466472175b69520a9b857f65f1c5365f13b8',
  'diagnostic/stop-history/seed.mjs':'ac35c958f83509ac3807183d7955ec45614d5b8cd9bd99db0543696d5bdb8ca4',
  'diagnostic/stop-history/counter.mjs':'5d9ed3b4b2963a490cd5b565accf302aa184ceacb710a00c1372fcbae8033474',
  'diagnostic/stop-history/frame-policy.mjs':'3f22a99e3cb8bd7ffeaa5276a2a86c01a6592e3c1bf6d710ab3f46011a856abf',
  'diagnostic/stop-history/click-target.mjs':'ac5f983734174484e3c8129720cdf276e09e788c4bf2da3bc4fceb1c6268a70a',
  'diagnostic/stop-history/run-guarded.mjs':'29815be8925f7643eb7297f9eacfd355c1cbf5b945388dbc80332c8fc4819aac',
  'diagnostic/stop-history/source-guard.mjs':'56ae7de03897f455068b85c827dd159eb990e2d478e4cbda72f8ce26361be036',
}
assertSource({git,sha:fileName=>sha(join(taskSource,fileName)),base:taskSha,expected:fingerprints})
const osHome=homedir()
if (inspectPaths(osHome).some(row => !allowed(row))) throw new Error('ambient profile location exists')
const deskLib = await import(pathToFileURL(join(taskSource,'script/lib/desk.mjs')).href)
const { launchDesk, openWorkspace, sleep } = deskLib
closeDesk = deskLib.closeDesk
const { COLLECT, TILDIFY, textReasons } = await import(pathToFileURL(join(taskSource,'script/shots/audit.mjs')).href)
result.phase='setup'
 taskRoot=realpathSync(mkdtempSync(join(tmpdir(),'hd2065-proof-')))
const taskDeskHome=join(taskRoot,'desk'), taskCodexProfile=join(taskRoot,'codex'), taskFakebin=join(taskRoot,'bin'), taskElectron=join(taskRoot,'electron'), taskProject=join(taskRoot,'project')
for (const dir of [taskDeskHome,taskCodexProfile,taskFakebin,taskElectron,taskProject,join(taskCodexProfile,'sessions'),join(taskCodexProfile,'archived_sessions')]) mkdirSync(dir,{recursive:true,mode:0o700})
const project=realpathSync(taskProject)
const write=(path,value,mode=0o600)=>{writeFileSync(path,value,{flag:'wx',mode});if(lstatSync(path).nlink!==1)throw new Error('unexpected hard links')}
write(join(taskDeskHome,'agents.json'),' {"agents":[]}\n')
write(join(taskDeskHome,'accounts.json'),' {"accounts":[]}\n')
write(join(taskCodexProfile,'sessions','rollout.jsonl'),'')
write(join(project,'README.md'),'# Synthetic project\n')
const ledgerFile=join(taskDeskHome,'triggers-mentions.json'), ledger=makeLedger(project)
write(ledgerFile,JSON.stringify(ledger)+'\n')
const counter=join(taskRoot,'interrupts'), toy=join(taskRoot,'toy-counter'), forgeCounter=join(taskRoot,'forge-calls')
write(counter,'');write(toy,'');write(forgeCounter,'');recordInterrupt(toy)
if(interruptCount(toy)!==1 || interruptCount(counter)!==0)throw new Error('counter control failed')
symlinkSync(process.execPath,join(taskFakebin,'node'))
const fakeGh=join(taskFakebin,'gh');write(fakeGh,'#!/bin/sh\nprintf G >> "$HD_2065_FORGE_RECEIPT"\nexit 1\n',0o700)
const fakeSsh=join(taskFakebin,'ssh');write(fakeSsh,SSH_SHIM,0o700)
accessSync('/usr/bin/false',constants.X_OK)
const sshProbe=spawnSync(fakeSsh,[],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000})
if(sshProbe.status!==1 || sshProbe.stdout!=='' || sshProbe.stderr!=='') throw new Error('ssh refusal probe failed')
const env={HOME:osHome,USER:process.env.USER??'',LOGNAME:process.env.LOGNAME??'',LANG:'en_US.UTF-8',HARNESSDESK_HOME:taskDeskHome,CODEX_HOME:taskCodexProfile,HARNESSDESK_CODEX_BINARY:fixture,PATH:[taskFakebin,'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),HARNESSDESK_PATH:taskFakebin,SHELL:'',TMPDIR:taskRoot,HARNESSDESK_NO_UPDATE_CHECK:'1',HARNESSDESK_LEAD:'0',HARNESSDESK_PHONE_LINK:'0',HARNESSDESK_MENU_BAR:'off',HARNESSDESK_CATALOG_REFRESH_MINUTES:'0',HARNESSDESK_ACP_REGISTRY_URL:'http://127.0.0.1:1/disabled',HARNESSDESK_CLOUD_URL:'http://127.0.0.1:1',HD_2065_INTERRUPT_RECEIPT:counter,HD_2065_FORGE_RECEIPT:forgeCounter,HARNESSDESK_CODEX_PROCESS_GROUP:randomUUID(),FAKE_CODEX_ROLLOUT_HOME:taskCodexProfile,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'file',GIT_SSH_COMMAND:'/usr/bin/false'}
const waitFor=async (label,fn,ms=30000)=>{const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await sleep(200)}throw new Error(`${label}: readiness deadline`)}
const assertListeners = (group, probe) => {
 let processOutput
 try { processOutput=execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}) }
 catch(error){probe.failure='process_scan';probe.psExit=Number.isInteger(error.status)?error.status:null;probe.psSignaled=!!error.signal;throw error}
 const rows=processOutput.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number))
 const owned=new Set(rows.filter(row=>row[2]===group).map(row=>row[0]));let changed=true
 while(changed){changed=false;for(const [pid,ppid] of rows)if(owned.has(ppid)&&!owned.has(pid)){owned.add(pid);changed=true}}
 const ps=[...owned];probe.ownedProcesses=ps.length
 if(!ps.length){probe.failure='no_owned_processes';throw new Error('owned process group disappeared')}
 let out='';try {
  out=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',ps.join(','),'-iTCP','-sTCP:LISTEN','-Fpn'],{encoding:'utf8'})
  probe.lsofExit=0;probe.lsofSignaled=false;probe.reported=listenerCounts(out)
 }catch(error){
  probe.lsofExit=Number.isInteger(error.status)?error.status:null;probe.lsofSignaled=!!error.signal
  probe.reported=listenerCounts(error.stdout??'')
  if(error.status!==1){probe.failure='lsof_error';throw error}
 }
 // Preserve the original status-1 behavior: partial stdout is observed but does not authorize the guard.
 const effective=listenerCounts(out);probe.effective=effective
 if(!effective.total){probe.failure='no_listeners';throw new Error('missing or non-loopback owned TCP listener')}
 if(effective.nonloopback){probe.failure='nonloopback_listener';throw new Error('missing or non-loopback owned TCP listener')}
 probe.failure=null
 return {processes:ps.length,listeners:effective.total,loopbackOnly:true}
}
const observedListeners=async (name) => {
 const probe={};result.checks[name]=probe
 try {const passed=assertListeners(desk.processGroup,probe);Object.assign(probe,passed);return probe}
 catch(error){
  probe.childExited=desk.child.exitCode!==null;probe.childExit=Number.isInteger(desk.child.exitCode)?desk.child.exitCode:null;probe.childSignaled=desk.child.signalCode!==null
  try {probe.cdpAlive=await desk.cdp.eval('true',3000)===true}catch{probe.cdpAlive=false}
  throw error
 }
}
const point = async (selector,label,rowText=null) => cdp.json(`(${locateTarget.toString()})(document,${JSON.stringify(selector)},${JSON.stringify(label)},${JSON.stringify(rowText)})`)
const click = async (selector,label,row=null,checkpoint=null) => {
  const readiness={attempts:0,matches:0,eligible:0,inViewport:0,hits:0,scrolls:0}
  if(checkpoint)result.readiness[checkpoint]=readiness
  const hit=await waitFor('click target',async()=>{
    const observation=await point(selector,label,row)
    readiness.attempts=Math.min(1000,readiness.attempts+1)
    for(const key of ['matches','eligible','inViewport','hits']) {
      const value=observation?.[key]
      if(!Number.isInteger(value)||value<0)throw new Error('invalid readiness observation')
      readiness[key]=Math.min(1000,value)
    }
    if(observation.scrolled===true)readiness.scrolls=Math.min(1000,readiness.scrolls+1)
    return observation.point
  },15000)
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...hit})
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...hit,button:'left',clickCount:1})
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...hit,button:'left',clickCount:1})
}
const frame = async () => {
  // Presentation only: shorten the exact resolved, exclusively owned synthetic root.
  await cdp.eval(TILDIFY(taskRoot,'~/synthetic-stop-proof'))
  const observed=await cdp.json(COLLECT)
  const reasons=textReasons(observed,{user:process.env.USER??''})
  if(reasons.length)throw new Error('privacy audit failed')
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'})
  const after=await cdp.json(COLLECT)
  if(JSON.stringify(observed)!==JSON.stringify(after)||textReasons(after,{user:process.env.USER??''}).length)throw new Error('frame changed or privacy audit failed')
  return inspectFrame(Buffer.from(shot.data,'base64'),reasons)
}
const readLedger=()=>JSON.parse(readFileSync(ledgerFile,'utf8'))
const verifyLedger = (expected101) => {
  const value=readLedger(), records=value.stopIntents
  if(value.version!==2 || !Array.isArray(records) || records.length!==3)throw new Error('ledger mismatch')
  for (const original of ledger.stopIntents) {
    const row=records.find(one=>one.id===original.id)
    if(!row || JSON.stringify(row.key)!==JSON.stringify(original.key) || JSON.stringify(row.thread)!==JSON.stringify(original.thread))throw new Error('ledger identity mismatch')
  }
  const states=new Map(records.map(row=>[row.key.comment,row.state]))
  if(states.get('101')!==expected101||states.get('102')!=='unconfirmed'||states.get('103')!=='reviewed')throw new Error('ledger state mismatch')
  return true
}
const observeRequests=()=>cdp.eval(`(()=>{const t=window.__hdStore.transport;if(!t||typeof t.request!=='function')throw Error('transport unavailable');const original=t.request,counts={stop:0,interrupt:0,reevaluate:0,review:0};t.request=function(method,...args){if(method==='lead/stop')counts.stop++;if(method==='turn/interrupt'||method==='session/interrupt')counts.interrupt++;if(method==='trigger/decision/reevaluate')counts.reevaluate++;if(method==='trigger/stop-unconfirmed/review')counts.review++;return Reflect.apply(original,this,[method,...args])};window.__hd2065counts=counts;return true})()`)
const goToHistory=async()=>{
  await cdp.eval("window.__hdStore.openDestination({kind:'flows',root:null,id:null,origin:null})")
  await click('[data-topbar="more"] button','')
  await click('[role="menuitem"]','Manage triggers')
  await waitFor('retained history',()=>cdp.eval("document.body.innerText.includes('fixture-trigger · Retained stop history') && document.body.innerText.includes('Stop unconfirmed')"),30000)
}
const expectedOutput=resolve(process.env.RUNNER_TEMP??'', 'hd2065-private-frames')
if(!process.env.RUNNER_TEMP || expectedOutput!==join(resolve(process.env.RUNNER_TEMP),'hd2065-private-frames'))throw new Error('invalid output location')
let firstFrame,secondFrame,frameUnavailable=false
result.phase='launch'
desk=await launchDesk({app:taskSource,home:taskDeskHome,userDataDir:taskElectron,env})
await observedListeners('listenersAtLaunch');cdp=desk.cdp
await waitFor('store connected',()=>cdp.eval("window.__hdStore?.getSnapshot().status === 'open'"),30000)
await openWorkspace(cdp,project)
await observeRequests()
result.phase='recovery';await goToHistory()
await waitFor('durable recovery',()=>{try{return verifyLedger('unconfirmed')}catch{return false}},30000)
await waitFor('unconfirmed rows',()=>cdp.eval("[...document.querySelectorAll('[data-slot=\"list-row\"]')].filter(e=>e.innerText.includes('Stop unconfirmed')).length===2"),10000)
result.checks.recovery=true
verifyLedger('unconfirmed')
try {firstFrame=await frame()} catch {frameUnavailable=true}
const beforeCounts=await cdp.json('window.__hd2065counts')
if(Object.values(beforeCounts).some(Boolean)||interruptCount(counter)!==0||readFileSync(forgeCounter).length!==0)throw new Error('unexpected pre-review effect')
result.phase='review_target';await click('button','Mark reviewed','#101','review_target')
result.phase='review_durable'
await waitFor('durable review',()=>{try{return verifyLedger('reviewed')}catch{return false}},30000)
result.checks.review=true
const afterCounts=await cdp.json('window.__hd2065counts')
if(afterCounts.review!==1||afterCounts.stop||afterCounts.interrupt||afterCounts.reevaluate||interruptCount(counter)!==0||readFileSync(forgeCounter).length!==0)throw new Error('unexpected review effect')
await click('button','History')
await waitFor('reviewed visible',()=>cdp.eval("[...document.querySelectorAll('[data-slot=\"list-row\"]')].some(e=>e.innerText.includes('#101') && e.innerText.includes('Reviewed · Stop unconfirmed'))"),10000)
verifyLedger('reviewed')
try {secondFrame=await frame()} catch {frameUnavailable=true}
await observedListeners('listenersAfterReview')
await closeDesk(desk);desk=undefined
result.phase='restart';desk=await launchDesk({app:taskSource,home:taskDeskHome,userDataDir:taskElectron,env});await observedListeners('listenersAtRestart');cdp=desk.cdp
await waitFor('store reconnected',()=>cdp.eval("window.__hdStore?.getSnapshot().status === 'open'"),30000)
await openWorkspace(cdp,project);await goToHistory();verifyLedger('reviewed');await click('button','History')
await waitFor('review persists visually',()=>cdp.eval("[...document.querySelectorAll('[data-slot=\"list-row\"]')].some(e=>e.innerText.includes('#101') && e.innerText.includes('Reviewed · Stop unconfirmed'))"),10000)
if(interruptCount(counter)!==0||readFileSync(forgeCounter).length!==0)throw new Error('unexpected restart effect')
await observedListeners('listenersAtEnd');result.checks.persisted=true;result.checks.noObservedEffects=true;await closeDesk(desk);desk=undefined
result.phase='frames';if(frameUnavailable || !firstFrame || !secondFrame)throw new Error('frame unavailable')
mkdirSync(expectedOutput,{mode:0o700})
for(const [name,photo] of [['unconfirmed',firstFrame],['reviewed',secondFrame]])write(join(expectedOutput,`${name}.png`),photo.bytes)
const manifest={version:1,presentation:'synthetic-root-shortened',frames:[['unconfirmed',firstFrame],['reviewed',secondFrame]].map(([name,photo])=>({name:`${name}.png`,sha256:photo.sha256,width:photo.width,height:photo.height}))}
write(join(expectedOutput,'manifest.json'),JSON.stringify(manifest)+'\n')
write(join(expectedOutput,'publication-ready'),'audited\n');result.phase='passed'
}, async()=>{
  if(desk) await closeDesk(desk)
  if(taskRoot) rmSync(taskRoot,{recursive:true,force:true})
})
if(!result.passed) process.exitCode=1
console.log(JSON.stringify(result))
