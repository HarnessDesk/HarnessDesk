import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allowed, inspectPaths, SSH_SHIM } from './ambient-shape.mjs'
import { compareReceipt, compareSnapshot } from './receipt-diagnostics.mjs'
import { listenerCounts } from './listener-diagnostics.mjs'
import { canonicalBytes, summarize, pendingAfterNavigation } from './profile-scalars.mjs'
import { stageRecord } from './profile-stage.mjs'

const taskSource = resolve('.')
const taskSha = 'b5dad1cac3b5c26a563413d0e586b44508374b5c'
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', ['-C',taskSource,...args], {encoding:'utf8'}).trim()
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('hosted macOS runner required')
if (git('merge-base','HEAD',taskSha)!==taskSha) throw new Error('source base mismatch')
const changed=git('diff','--name-only',taskSha,'HEAD','--',':(exclude).github/workflows/ci.yml',':(exclude)diagnostic/retention-pilot')
if (changed || git('status','--porcelain=v1')) throw new Error('production source or checkout changed')
if(sha(join(taskSource,'packages/server/src/host.ts'))!=='fcb9807fd0545c3dabb7341250ea36fe7f5cd1426a3b6dbad5360ffb0d034925' || sha(join(taskSource,'packages/server/src/transcripts.ts'))!=='eb9e49eb57b1ec8a539f8e2d778be4e317b2e02377765f932647867fe5becf47') throw new Error('production source fingerprint changed')
if(sha(join(taskSource,'packages/protocol/src/canonical-transcript.ts'))!=='67037c20924ec2f68178911374b8a5a5afa44da74e03f236f18b9cb8d427ea56') throw new Error('canonical source fingerprint changed')
const fixture=join(taskSource,'diagnostic/retention-pilot/fake-codex-1545.mjs')
const fixtureHashes={
 'packages/adapter-codex/test/fixtures/fake-codex.mjs':'f4d8fcb27e24a3e871dd5660030e4c0fbd718bc429952e98970de81f43e7b1d1',
 'packages/adapter-codex/test/fixtures/scripted-flow.mjs':'1b6f58123021ce772025a525aaedabd99784655772631299d27a6dbe4c8099d7',
 'packages/adapter-codex/test/fixtures/plugin-icon.svg':'611ca48d4da7767c7cc051442c2e389a2d5a288a2fbb09c5edd3f3b1e7499d79',
 'diagnostic/retention-pilot/fake-codex-1545.mjs':'70d44e8a425ca3215ad66f92ec8fcd3f970048c745aba6d3a48054acefbc9fcc',
 'diagnostic/retention-pilot/scripted-flow.mjs':'1b6f58123021ce772025a525aaedabd99784655772631299d27a6dbe4c8099d7',
 'diagnostic/retention-pilot/plugin-icon.svg':'611ca48d4da7767c7cc051442c2e389a2d5a288a2fbb09c5edd3f3b1e7499d79',
}
for(const [path,expected] of Object.entries(fixtureHashes)) if(sha(join(taskSource,path))!==expected) throw new Error('fixture fingerprint mismatch')
const osHome=homedir()
if (inspectPaths(osHome).some(row => !allowed(row))) throw new Error('ambient agent or credential location exists')
const { launchDesk, closeDesk, openWorkspace, seat, sleep } = await import(pathToFileURL(join(taskSource,'script/lib/desk.mjs')).href)
const taskRoot=realpathSync(mkdtempSync(join(tmpdir(),'hd1545-pilot-')))
const taskDeskHome=join(taskRoot,'desk'), taskCodexProfile=join(taskRoot,'codex'), taskFakebin=join(taskRoot,'bin'), taskElectron=join(taskRoot,'electron'), taskProject=join(taskRoot,'project')
for(const dir of [taskDeskHome,taskCodexProfile,taskFakebin,taskElectron,taskProject,join(taskCodexProfile,'sessions'),join(taskCodexProfile,'archived_sessions')]) mkdirSync(dir,{recursive:true,mode:0o700})
const write=(path,value,mode=0o600)=>{writeFileSync(path,value,{flag:'wx',mode});if(lstatSync(path).nlink!==1)throw new Error('unexpected hard links')}
write(join(taskDeskHome,'agents.json'),'{"agents":[]}\n')
write(join(taskDeskHome,'accounts.json'),'{"accounts":[]}\n')
write(join(taskCodexProfile,'sessions','rollout.jsonl'),'')
write(join(taskProject,'README.md'),'# Synthetic retention smoke\n')
symlinkSync(process.execPath,join(taskFakebin,'node'))
const fakeGh=join(taskFakebin,'gh');write(fakeGh,'#!/bin/sh\nexit 1\n',0o700);chmodSync(fakeGh,0o700)
const fakeSsh=join(taskFakebin,'ssh');write(fakeSsh,SSH_SHIM,0o700);chmodSync(fakeSsh,0o700)
accessSync('/usr/bin/false',constants.X_OK)
const sshProbe=spawnSync(fakeSsh,[],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000})
if(sshProbe.status!==1 || sshProbe.stdout!=='' || sshProbe.stderr!=='') throw new Error('ssh refusal probe failed')
const env={HOME:osHome,USER:process.env.USER??'',LOGNAME:process.env.LOGNAME??'',LANG:'en_US.UTF-8',HARNESSDESK_HOME:taskDeskHome,CODEX_HOME:taskCodexProfile,HARNESSDESK_CODEX_BINARY:fixture,PATH:[taskFakebin,'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),HARNESSDESK_PATH:taskFakebin,SHELL:'',TMPDIR:taskRoot,HARNESSDESK_NO_UPDATE_CHECK:'1',HARNESSDESK_LEAD:'0',HARNESSDESK_PHONE_LINK:'0',HARNESSDESK_MENU_BAR:'off',HARNESSDESK_CATALOG_REFRESH_MINUTES:'0',HARNESSDESK_ACP_REGISTRY_URL:'http://127.0.0.1:1/disabled',HARNESSDESK_CLOUD_URL:'http://127.0.0.1:1',HD_1545_OUTPUT_BYTES:'32768',HARNESSDESK_CODEX_PROCESS_GROUP:randomUUID(),FAKE_CODEX_ROLLOUT_HOME:taskCodexProfile,FAKE_CODEX_PERSIST_TURN:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'file',GIT_SSH_COMMAND:'/usr/bin/false'}
const result={source:taskSha,fixtureSha256:sha(fixture),phase:'prepared',checks:{}}
let desk
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


// Keys and fingerprints stay inside this disposable controller; no body or CDP
// remote handle is returned by a measurement expression.
const keys=[]
let cdp, runtime, visible, draft, pending
const addr = key => { const [runtime,sessionId]=key.split(String.fromCharCode(0)); if(runtime!=='codex'||!sessionId)throw new Error('session ownership'); return {runtime,sessionId} }
const closeCurrent = async key => {
 const before=await cdp.json(`(()=>{const x=window.__hd1545Closes.get(${JSON.stringify(key)});return x?{...x}:{sent:0,resolved:0,rejected:0}})()`)
 const focused=await cdp.json(`(()=>{const s=window.__hdStore.getSnapshot(),p=(n)=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...p(n.first),...p(n.second)]:[];const f=p(s.layout.root).find(x=>x.id===s.layout.focused);return {id:f?.id,matches:f?.view?.kind==='conversation'&&f.view.session===${JSON.stringify(key)}}})()`)
 if(!focused.matches||!focused.id)throw new Error('focused pane ownership')
 await cdp.eval(`window.__hdStore.closePane(${JSON.stringify(focused.id)})`)
 await waitFor('close acknowledgement',()=>cdp.eval(`(()=>{const x=window.__hd1545Closes.get(${JSON.stringify(key)});if(x?.rejected>${before.rejected})throw Error('close rejected');return x?.sent===${before.sent+1}&&x?.resolved===${before.resolved+1}})()`),30000)
}
const newTurn = async (leavePending=false) => {
 const key=await seat(cdp,{work:taskProject,runtime:'codex',picks:{}});addr(key)
 if(keys.includes(key)||[visible,draft,pending].includes(key))throw new Error('duplicate session identity')
 await cdp.eval(`window.__hdStore.send([{type:'text',text:'Synthetic retention smoke'}],${JSON.stringify(key)})`,30000)
 const approval=await waitFor('fake approval',()=>cdp.json(`(()=>{const a=window.__hdStore.getSnapshot().approvals.filter(x=>x.key===${JSON.stringify(key)});if(!a.length)return null;if(a.length!==1||a[0].approval.type!=='command'||a[0].approval.command!=='ls -la')throw Error('unexpected approval');return {id:a[0].approval.id,option:(a[0].approval.options??[]).find(x=>x.intent==='approve')?.id}})()`),20000)
 if(!approval.option)throw new Error('missing approval option')
 if(!leavePending){
  await cdp.eval(`window.__hdStore.respondToApproval(${JSON.stringify(key)},${JSON.stringify(approval.id)},{type:'option',optionId:${JSON.stringify(approval.option)}})`)
  await waitFor('completed synthetic command',()=>cdp.eval(`(()=>{const s=window.__hdStore.getSnapshot().sessions.get(${JSON.stringify(key)});return !!s?.turns.some(t=>t.status==='completed'&&t.items.some(i=>i.type==='command'&&typeof i.output==='string'&&i.output.length===32768))})()`),30000)
 }
 return key
}
const openVisible = async () => {
 const {runtime,sessionId}=addr(visible)
 if(!await cdp.eval(`window.__hdStore.openSession(${JSON.stringify(sessionId)},{runtime:${JSON.stringify(runtime)}})`))throw new Error('visible sentinel open')
}
const pendingCheck = async () => cdp.eval(`(()=>{const s=window.__hdStore,snap=s.getSnapshot(),check=${pendingAfterNavigation.toString()},p=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...p(n.first),...p(n.second)]:[],k=${JSON.stringify(pending)};return check(snap.sessions.get(k),snap.approvals.some(a=>a.key===k),p(snap.layout.root).some(x=>x.view?.kind==='conversation'&&x.view.session===k),window.__hd1545Closes.get(k))})()`)
const sample = async () => {
 const keyList=JSON.stringify(keys), sentinels=JSON.stringify({visible,draft,pending})
 return await cdp.json(`(()=>{const s=window.__hdStore, snap=s.getSnapshot(), stats=s.transcriptCacheStats(), work=${keyList}, sent=${sentinels}, bytes=${canonicalBytes.toString()};
  const panes=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...panes(n.first),...panes(n.second)]:[];
  const mounted=panes(snap.layout.root).some(p=>p.view?.kind==='conversation'&&p.view.session===sent.visible);
  const protectedKeys=Object.values(sent), summarize=${summarize.toString()}, measured=summarize(snap.sessions,work,protectedKeys,bytes);
  if(!mounted||!s.drafts.live(sent.draft)||!snap.approvals.some(a=>a.key===sent.pending)||!snap.sessions.get(sent.pending)?.turns.some(t=>t.status==='inProgress'))throw Error('sentinel protection missing');
  return {metadata:snap.sessions.size,loadedFullBodies:stats.loadedFullBodies,releasedBodies:stats.releasedBodies,trackedRecoveryRecords:stats.trackedRecoveryRecords,enabled:stats.enabled,pressureRunning:stats.pressureRunning,pressureDirty:stats.pressureDirty,eligibleBodies:stats.eligibleBodies,eligibleBytes:stats.eligibleBytes,...measured,mounted,draft:true,pending:true}})()`)
}
// The failure record contains only fixed stage names and allowlisted scalars.
const mark400 = async (count, stage, selected=null) => {
 if(count!==400)return
 let state
 try {
  state=await cdp.json(`(()=>{const s=window.__hdStore,snap=s.getSnapshot(),stats=s.transcriptCacheStats(),keys=${JSON.stringify(keys)},p=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...p(n.first),...p(n.second)]:[],panes=p(snap.layout.root),pending=${JSON.stringify(pending)},visible=${JSON.stringify(visible)},draft=${JSON.stringify(draft)},selected=${JSON.stringify(selected)};
   return {metadata:snap.sessions.size,loaded:stats.loadedFullBodies,released:stats.releasedBodies,recovery:stats.trackedRecoveryRecords,pressureRunning:stats.pressureRunning,pressureDirty:stats.pressureDirty,enabled:stats.enabled,eligibilityKnown:stats.eligibleBodies!==null||stats.eligibleBytes!==null,visibleMounted:panes.some(x=>x.view?.kind==='conversation'&&x.view.session===visible),visibleLoaded:snap.sessions.get(visible)?.itemsLoaded===true,draftPresent:!!s.drafts.live(draft),draftLoaded:snap.sessions.get(draft)?.itemsLoaded===true,pendingPresent:snap.approvals.some(a=>a.key===pending),pendingLoaded:snap.sessions.get(pending)?.itemsLoaded===true,pendingActive:!!snap.sessions.get(pending)?.turns.some(t=>t.status==='inProgress'),pendingMounted:panes.some(x=>x.view?.kind==='conversation'&&x.view.session===pending),pendingCloseSent:window.__hd1545Closes.get(pending)?.sent??0,knownLoaded:keys.filter(k=>snap.sessions.get(k)?.itemsLoaded===true).length,knownMissing:keys.filter(k=>!snap.sessions.has(k)).length,...(selected?{selectedPresent:snap.sessions.has(selected),selectedLoaded:snap.sessions.get(selected)?.itemsLoaded===true}:{})}})()`)
 } catch {state={stateUnavailable:true}}
 result.diagnostic=stageRecord(stage,state)
}
const compareRepresentative = async key => {
 const a=addr(key)
 return cdp.json(`(async()=>{const t=window.__hdStore.transport,a=${JSON.stringify(a)};const s=await t.request('session/cache-snapshot',a);if(!s)return {present:false};const r=await t.request('session/prepare-eviction',{...a,identity:s.identity});return {present:!!r,identity:!!r&&r.identity===s.identity,epoch:!!r&&r.epoch===s.watermark.epoch,generation:!!r&&r.generation===s.watermark.generation,revision:!!r&&r.revision===s.watermark.revision,sequence:!!r&&r.sequence===s.watermark.sequence}})()`)
}

try {
 result.phase='launch'; desk=await launchDesk({app:taskSource,home:taskDeskHome,userDataDir:taskElectron,env})
 await observedListeners('listenersAtLaunch');cdp=desk.cdp
 await waitFor('store connected',()=>cdp.eval("window.__hdStore?.getSnapshot().status === 'open'"),30000)
 const browser=await cdp.send('Browser.getVersion');result.browser={product:browser.product,protocolVersion:browser.protocolVersion,jsVersion:browser.jsVersion}
 const target=(await cdp.send('Target.getTargetInfo')).targetInfo?.targetId;if(!target)throw new Error('missing target identity')
 result.phase='workspace';await openWorkspace(cdp,taskProject)
 const runtimes=await cdp.json('window.__hdStore.getSnapshot().runtimes.map(r=>r.id)')
 if(!Array.isArray(runtimes)||runtimes.some(id=>id!=='codex'))throw new Error('unexpected configured runtime')
 await cdp.eval(`(()=>{const s=window.__hdStore,t=s.transport,original=t.request,m=new Map();window.__hd1545Closes=m;
  t.request=function(method,params,...rest){const key=method==='session/close'&&params?.runtime&&params?.sessionId?params.runtime+String.fromCharCode(0)+params.sessionId:null;
   let v;if(key){v=m.get(key)??{sent:0,resolved:0,rejected:0};v.sent++;m.set(key,v)}
   try{const answer=Reflect.apply(original,this,[method,params,...rest]);if(v)Promise.resolve(answer).then(()=>v.resolved++,()=>v.rejected++);return answer}catch(e){if(v)v.rejected++;throw e}
  };return true})()`)
 result.phase='sentinels'
 visible=await newTurn();await closeCurrent(visible)
 draft=await newTurn()
 await cdp.eval(`(()=>{const t=[...document.querySelectorAll('textarea')].filter(x=>!x.disabled&&x.offsetParent);if(t.length!==1)throw Error('composer unavailable');t[0].focus();return true})()`)
 await cdp.send('Input.insertText',{text:'Synthetic unsent draft'})
 await waitFor('draft sentinel',()=>cdp.eval(`window.__hdStore.drafts.live(${JSON.stringify(draft)})?.text==='Synthetic unsent draft'`),30000)
 await closeCurrent(draft)
 pending=await newTurn(true);await openVisible()
 if(!await pendingCheck())throw new Error('pending sentinel did not survive navigation')
 result.checks.pendingAfterNavigation=true
 result.checkpoints=[]
 for(const count of [0,128,200,400]) {
  result.phase=`workload-${count}`
  while(keys.length<count) {
   const key=await newTurn();await closeCurrent(key);keys.push(key)
   const persistent=await cdp.eval(`(()=>{const s=window.__hdStore,snap=s.getSnapshot();return !!s.drafts.live(${JSON.stringify(draft)})&&snap.sessions.get(${JSON.stringify(draft)})?.itemsLoaded===true&&snap.sessions.get(${JSON.stringify(pending)})?.itemsLoaded===true&&snap.approvals.some(a=>a.key===${JSON.stringify(pending)})&&snap.sessions.get(${JSON.stringify(pending)})?.turns.some(t=>t.status==='inProgress')})()`)
   if(!persistent||!await pendingCheck())throw new Error('persistent sentinel protection lost')
  }
  result.phase=`checkpoint-${count}`;if(count===400)await mark400(count,'open-visible');if(count!==0)await openVisible()
  if(count===400)await mark400(count,'pending');if(!await pendingCheck())throw new Error('pending sentinel did not survive navigation')
  if(count===400)await mark400(count,'quiescence');let state=await waitFor('quiescent pressure',async()=>{const first=await sample();if(!first.enabled||first.pressureRunning||first.pressureDirty)return false;await cdp.eval('new Promise(resolve=>setTimeout(()=>resolve(true),0))');const second=await sample();return JSON.stringify(first)===JSON.stringify(second)?second:false},30000)
  if(count===400){await mark400(count,'eligibility');result.diagnostic=stageRecord('eligibility',{...result.diagnostic.state,sampledEligibilityKnown:state.eligibleBodies!==null||state.eligibleBytes!==null})}if(state.eligibleBodies!==null||state.eligibleBytes!==null)throw new Error('eligibility surface changed')
  if(count===400){await mark400(count,'recovery');result.diagnostic=stageRecord('recovery',{...result.diagnostic.state,sampledRecovery:state.trackedRecoveryRecords})}if(state.trackedRecoveryRecords!==0)throw new Error('unresolved recovery record')
  const representatives=[];let mountedPressure={exercised:false}
  if(keys.length) {
   if(count===400)await mark400(count,'workload-metadata');const states=await cdp.json(`(()=>{const s=window.__hdStore.getSnapshot();return ${JSON.stringify(keys)}.map(k=>({present:s.sessions.has(k),loaded:s.sessions.get(k)?.itemsLoaded===true}))})()`)
   if(count===400)result.diagnostic=stageRecord('workload-metadata',{...result.diagnostic.state,capturedMissing:states.filter(x=>!x.present).length});if(states.some(x=>!x.present))throw new Error('workload metadata missing')
   const kept=states.findIndex(x=>x.loaded), released=states.findIndex(x=>!x.loaded)
   if(count===400){await mark400(count,'representative-selection');result.diagnostic=stageRecord('representative-selection',{...result.diagnostic.state,retainedFound:kept>=0,releasedFound:released>=0})}if(count>=200&&(kept<0||released<0))throw new Error('policy release or retained control absent')
   for(const [label,index] of [['retained',kept],['released',released]])if(index>=0){if(count===400)await mark400(count,label==='retained'?'receipt-retained':'receipt-released',keys[index]);const proof=await compareRepresentative(keys[index]);if(count===400)result.diagnostic=stageRecord(result.diagnostic.stage,{...result.diagnostic.state,receiptPresent:proof.present,identityMatches:proof.identity,epochMatches:proof.epoch,generationMatches:proof.generation,revisionMatches:proof.revision,sequenceMatches:proof.sequence});if(Object.values(proof).some(x=>x!==true))throw new Error('representative receipt mismatch');representatives.push({label,...proof})}
   if(count>=200){
    const chosen=keys[released], address=addr(chosen)
    if(count===400)await mark400(count,'restore-immediate',chosen);const restored=await cdp.json(`(async()=>{const s=window.__hdStore;const ok=await s.restoreTranscript(${JSON.stringify(address.runtime)},${JSON.stringify(address.sessionId)});const snap=s.getSnapshot();const p=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...p(n.first),...p(n.second)]:[];return {ok,loaded:snap.sessions.get(${JSON.stringify(chosen)})?.itemsLoaded===true,mounted:p(snap.layout.root).some(x=>x.view?.kind==='conversation'&&x.view.session===${JSON.stringify(visible)}),visibleLoaded:snap.sessions.get(${JSON.stringify(visible)})?.itemsLoaded===true}})()`)
    if(count===400)result.diagnostic=stageRecord('restore-immediate',{...result.diagnostic.state,restoreOk:restored.ok,restoreLoaded:restored.loaded,restoreVisibleMounted:restored.mounted,restoreVisibleLoaded:restored.visibleLoaded})
    if(Object.values(restored).some(x=>x!==true))throw new Error('restore did not preserve mounted sentinel')
    const previouslyLoaded=keys.filter((_,i)=>states[i].loaded)
    if(count===400)await mark400(count,'automatic-release',chosen);await waitFor('automatic release after restore',()=>cdp.eval(`(()=>{const s=window.__hdStore,snap=s.getSnapshot(),stats=s.transcriptCacheStats(),p=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...p(n.first),...p(n.second)]:[];const mounted=p(snap.layout.root).some(x=>x.view?.kind==='conversation'&&x.view.session===${JSON.stringify(visible)});if(!mounted||snap.sessions.get(${JSON.stringify(visible)})?.itemsLoaded!==true)throw Error('visible sentinel lost');return !stats.pressureRunning&&!stats.pressureDirty&&[${JSON.stringify(chosen)},...${JSON.stringify(previouslyLoaded)}].some(k=>snap.sessions.has(k)&&snap.sessions.get(k)?.itemsLoaded===false)})()`),30000)
    if(count===400)await mark400(count,'post-restore-stability',chosen);state=await sample();await cdp.eval('new Promise(resolve=>setTimeout(()=>resolve(true),0))');const stable=await sample();if(JSON.stringify(state)!==JSON.stringify(stable)||!state.enabled||state.pressureRunning||state.pressureDirty||state.trackedRecoveryRecords!==0)throw new Error('post-restore not quiescent')
    mountedPressure={exercised:true,restored:true,automaticReleaseObserved:true,visibleMountedAtEndpoints:true}
   }
  }
  if(count===400)await mark400(count,'heap');await cdp.send('HeapProfiler.collectGarbage');const heap=await cdp.send('Runtime.getHeapUsage')
  if(!Number.isFinite(heap.usedSize))throw new Error('missing renderer heap')
  if(count===400)await mark400(count,'target');const sameTarget=(await cdp.send('Target.getTargetInfo')).targetInfo?.targetId===target;if(!sameTarget)throw new Error('renderer target changed')
  result.checkpoints.push({completed:count,...state,mountedPressure,representatives,heapUsedBytes:heap.usedSize,backingStorageBytes:Number.isFinite(heap.backingStorageSize)?heap.backingStorageSize:null,sameTarget})
  if(count===400)await mark400(count,'listeners');await observedListeners(`listenersAt${count}`)
  if(count!==400)await closeCurrent(visible)
 }
 result.phase='passed'
} catch {result.error='profile failed';process.exitCode=1}
finally {let stopped=true;try{await closeDesk(desk??{})}catch{stopped=false;result.cleanupError=true;process.exitCode=1}console.log(JSON.stringify(result));if(stopped)rmSync(taskRoot,{recursive:true,force:true})}
