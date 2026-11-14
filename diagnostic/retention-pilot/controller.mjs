import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allowed, inspectPaths, SSH_SHIM } from './ambient-shape.mjs'
import { compareReceipt, compareSnapshot } from './receipt-diagnostics.mjs'
import { makeGuardMetrics } from './guard-metrics.mjs'

const taskSource = resolve('.')
const taskSha = '8d30cf17f720e4014020aac8c345776a4372953e'
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', ['-C',taskSource,...args], {encoding:'utf8'}).trim()
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('hosted macOS runner required')
if (git('merge-base','HEAD',taskSha)!==taskSha) throw new Error('source base mismatch')
const changed=git('diff','--name-only',taskSha,'HEAD','--',':(exclude).github/workflows/ci.yml',':(exclude)diagnostic/retention-pilot',':(exclude)packages/server/src/host.ts')
if (changed || git('status','--porcelain=v1')) throw new Error('production source or checkout changed')
const originalHost=execFileSync('git',['-C',taskSource,'show',`${taskSha}:packages/server/src/host.ts`])
if(sha(join(taskSource,'packages/server/src/host.ts'))!=='dc85352a3b4ad67aa4fd8caac4bd78010a546f089b45032d3bde9ff65b14234a' || createHash('sha256').update(originalHost).digest('hex')!=='304b7c38003520c80cfd5d5fbc47562cbbe9e37c394ab380fbc511e8174859d8') throw new Error('Host diagnostic source fingerprint changed')
const fixture=join(taskSource,'diagnostic/retention-pilot/fake-codex-1545.mjs')
const fixtureHashes={
 'packages/adapter-codex/test/fixtures/fake-codex.mjs':'f4d8fcb27e24a3e871dd5660030e4c0fbd718bc429952e98970de81f43e7b1d1',
 'packages/adapter-codex/test/fixtures/scripted-flow.mjs':'1b6f58123021ce772025a525aaedabd99784655772631299d27a6dbe4c8099d7',
 'packages/adapter-codex/test/fixtures/plugin-icon.svg':'611ca48d4da7767c7cc051442c2e389a2d5a288a2fbb09c5edd3f3b1e7499d79',
 'diagnostic/retention-pilot/fake-codex-1545.mjs':'8d06106401fa5076c489d4a879da79e831cde8a1400deb880579739d89d00738',
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
const env={HOME:osHome,USER:process.env.USER??'',LOGNAME:process.env.LOGNAME??'',LANG:'en_US.UTF-8',HARNESSDESK_HOME:taskDeskHome,CODEX_HOME:taskCodexProfile,HARNESSDESK_CODEX_BINARY:fixture,PATH:[taskFakebin,'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),HARNESSDESK_PATH:taskFakebin,SHELL:'',TMPDIR:taskRoot,HARNESSDESK_RETENTION_PILOT:'1',HARNESSDESK_NO_UPDATE_CHECK:'1',HARNESSDESK_LEAD:'0',HARNESSDESK_PHONE_LINK:'0',HARNESSDESK_MENU_BAR:'off',HARNESSDESK_CATALOG_REFRESH_MINUTES:'0',HARNESSDESK_ACP_REGISTRY_URL:'http://127.0.0.1:1/disabled',HARNESSDESK_CLOUD_URL:'http://127.0.0.1:1',HD_1545_OUTPUT_BYTES:'32768',HARNESSDESK_CODEX_PROCESS_GROUP:randomUUID(),FAKE_CODEX_ROLLOUT_HOME:taskCodexProfile,FAKE_CODEX_PERSIST_TURN:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_ALLOW_PROTOCOL:'file',GIT_SSH_COMMAND:'/usr/bin/false'}
const result={source:taskSha,fixtureSha256:sha(fixture),phase:'prepared',checks:{}}
let desk
const guardMetrics=makeGuardMetrics()
const waitFor=async (label,fn,ms=30000)=>{const until=Date.now()+ms;while(Date.now()<until){const value=await fn();if(value)return value;await sleep(200)}throw new Error(`${label}: readiness deadline`)}
const assertListeners = (group) => {
 const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number))
 const owned=new Set(rows.filter(row=>row[2]===group).map(row=>row[0]));let changed=true
 while(changed){changed=false;for(const [pid,ppid] of rows)if(owned.has(ppid)&&!owned.has(pid)){owned.add(pid);changed=true}}
 const ps=[...owned]
 if(!ps.length)throw new Error('owned process group disappeared')
 let out='';try {out=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',ps.join(','),'-iTCP','-sTCP:LISTEN','-Fpn'],{encoding:'utf8'})}catch(error){if(error.status!==1)throw error}
 const addresses=out.split('\n').filter(line=>line.startsWith('n')).map(line=>line.slice(1))
 if(!addresses.length || addresses.some(address=>!/^127\.0\.0\.1:\d+$/.test(address)&&!/^\[::1\]:\d+$/.test(address))) throw new Error('missing or non-loopback owned TCP listener')
 return {processes:ps.length,listeners:addresses.length,loopbackOnly:true}
}
try {
 result.phase='launch'; desk=await launchDesk({app:taskSource,home:taskDeskHome,userDataDir:taskElectron,env})
 desk.child.stderr?.on('data',guardMetrics.add)
 result.checks.listenersAtLaunch=assertListeners(desk.processGroup)
 const cdp=desk.cdp
 await waitFor('store connected',()=>cdp.eval("window.__hdStore?.getSnapshot().status === 'open'"),30000)
 result.phase='workspace';await openWorkspace(cdp,taskProject)
 const runtimes=await cdp.json("window.__hdStore.getSnapshot().runtimes.map(r => r.id)")
 if(!Array.isArray(runtimes)||runtimes.some(id=>id!=='codex'))throw new Error('unexpected configured runtime')
 result.checks.onlyFakeRuntime=true
 const key=await seat(cdp,{work:taskProject,runtime:'codex',picks:{}})
 const [runtime,id]=key.split(String.fromCharCode(0));if(runtime!=='codex'||!id)throw new Error('unexpected session identity')
 result.phase='turn'; await cdp.eval(`window.__hdStore.send([{type:'text',text:'Synthetic retention smoke'}],${JSON.stringify(key)})`,30000)
 await waitFor('fake approval',async()=>{const pending=await cdp.json(`window.__hdStore.getSnapshot().approvals.map(entry=>({key:entry.key,id:entry.approval.id,type:entry.approval.type,command:entry.approval.command,option:(entry.approval.options??[]).find(o=>o.intent==='approve')?.id}))`);if(!pending.length)return false;if(pending.length!==1||pending[0].type!=='command'||pending[0].command!=='ls -la'||!pending[0].option)throw new Error('unexpected approval refused');const a=pending[0];await cdp.eval(`window.__hdStore.respondToApproval(${JSON.stringify(a.key)},${JSON.stringify(a.id)},{type:'option',optionId:${JSON.stringify(a.option)}})`);return true},20000)
 await waitFor('completed synthetic command',()=>cdp.eval(`(()=>{const s=window.__hdStore.getSnapshot().sessions.get(${JSON.stringify(key)});return !!s?.turns.some(t=>t.status==='completed'&&t.items.some(i=>i.type==='command'&&typeof i.output==='string'&&i.output.length===32768))})()`),30000)
 result.checks.syntheticCompletion=true;result.checks.listenersDuringTurn=assertListeners(desk.processGroup)
 result.phase='close'
 // Observe only the target close request; attach handlers without replacing its result or changing dispatch.
 await cdp.eval(`(()=>{const s=window.__hdStore,t=s.transport,original=t.request,p={sent:0,resolved:0,rejected:0};
  window.__hd1545CloseProbe=p;
  t.request=function(method,params,...rest){
   const match=method==='session/close'&&params?.runtime===${JSON.stringify(runtime)}&&params?.sessionId===${JSON.stringify(id)};
   if(match)p.sent++;
   try {const answer=Reflect.apply(original,this,[method,params,...rest]);if(match)Promise.resolve(answer).then(()=>p.resolved++,()=>p.rejected++);return answer}
   catch(error){if(match)p.rejected++;throw error}
  };return true})()`)
 const closeState=()=>cdp.json(`(()=>{const s=window.__hdStore.getSnapshot(),key=${JSON.stringify(key)},session=s.sessions.get(key);
  const panes=n=>!n?[]:n.kind==='pane'?[n]:n.kind==='split'?[...panes(n.first),...panes(n.second)]:[];
  const all=panes(s.layout.root), focused=all.find(p=>p.id===s.layout.focused), target=all.filter(p=>p.view?.kind==='conversation'&&p.view.session===key);
  const probe=window.__hd1545CloseProbe;
  return {focusedMatches:!!focused&&focused.view?.kind==='conversation'&&focused.view.session===key,targetPaneCount:target.length,
   itemsLoaded:session?.itemsLoaded===true,sessionActive:session?.status?.type==='active',runningTurns:session?.turns?.filter(t=>t.status==='inProgress').length??0,
   approvals:s.approvals.filter(a=>a.key===key).length,closeSent:probe.sent,closeResolved:probe.resolved,closeRejected:probe.rejected}
 })()`)
 result.checks.beforeClose=await closeState()
 await cdp.eval('window.__hdStore.closePane(window.__hdStore.getSnapshot().layout.focused)')
 result.checks.afterClose=await closeState()
 const addr={runtime,sessionId:id}
 result.phase='snapshot';const snapshot=await waitFor('host snapshot',()=>cdp.json(`window.__hdStore.transport.request('session/cache-snapshot',${JSON.stringify(addr)}).then(x=>x&&({identity:x.identity,watermark:x.watermark,turns:x.session.turns.length}))`),30000)
 result.checks.snapshot={identityLength:snapshot.identity?.length,watermarkFields:['epoch','generation','revision','sequence'].every(k=>snapshot.watermark?.[k]!==undefined),turns:snapshot.turns}
 result.phase='receipt'
 const receiptProbe={attempts:0,nulls:0,requestError:false}
 result.checks.receipt=receiptProbe
 try {
  const receipt=await waitFor('fresh host receipt',async()=>{
   receiptProbe.attempts++
   try {
    const value=await cdp.json(`window.__hdStore.transport.request('session/prepare-eviction',${JSON.stringify({...addr,identity:snapshot.identity})}).then(x=>x&&({identity:x.identity,epoch:x.epoch,generation:x.generation,revision:x.revision,sequence:x.sequence}))`)
    if(!value)receiptProbe.nulls++
    return value
   } catch(error) { receiptProbe.requestError=true; throw error }
  },30000)
  receiptProbe.comparison=compareReceipt(snapshot,receipt)
  if(Object.values(receiptProbe.comparison).some(matches=>!matches))throw new Error('receipt does not match host snapshot')
  result.checks.exactReceipt=true
 } catch(error) {
  try { receiptProbe.closeState=await closeState() } catch { receiptProbe.closeStateError=true }
  try {
   const latest=await cdp.json(`window.__hdStore.transport.request('session/cache-snapshot',${JSON.stringify(addr)}).then(x=>x&&({identity:x.identity,watermark:x.watermark}))`)
   receiptProbe.latestSnapshot=compareSnapshot(snapshot,latest)
  } catch { receiptProbe.latestSnapshotError=true }
  throw error
 }
 result.phase='release';await waitFor('real release',()=>cdp.eval(`window.__hdStore.unloadTranscript(${JSON.stringify(runtime)},${JSON.stringify(id)})`),30000)
 if(await cdp.eval(`window.__hdStore.getSnapshot().sessions.get(${JSON.stringify(key)})?.itemsLoaded`)!==false)throw new Error('body was not released')
 result.phase='restore';if(!await cdp.eval(`window.__hdStore.restoreTranscript(${JSON.stringify(runtime)},${JSON.stringify(id)})`))throw new Error('restore refused')
 const restored=await cdp.json(`window.__hdStore.transport.request('session/cache-snapshot',${JSON.stringify(addr)}).then(x=>x&&({identity:x.identity,turns:x.session.turns.length}))`)
 if(restored?.identity!==snapshot.identity||restored.turns!==snapshot.turns)throw new Error('restored body identity mismatch')
 result.checks.restoreExact=true;result.checks.listenersAtEnd=assertListeners(desk.processGroup);result.phase='passed'
} catch { result.error='checkpoint failed';process.exitCode=1 }
finally {try{await closeDesk(desk??{})}catch{result.cleanupError=true;process.exitCode=1} result.checks.hostGuardMetrics=guardMetrics.summary();console.log(JSON.stringify(result)); rmSync(taskRoot,{recursive:true,force:true})}
