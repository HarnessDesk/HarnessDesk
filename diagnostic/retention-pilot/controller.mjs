import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const taskSource = resolve('.')
const taskSha = 'bdff0b1169289b67cdbb9ea138f45d6dd7b46fe4'
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', ['-C',taskSource,...args], {encoding:'utf8'}).trim()
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('hosted macOS runner required')
if (git('merge-base','HEAD',taskSha)!==taskSha) throw new Error('source base mismatch')
const changed=git('diff','--name-only',taskSha,'HEAD','--',':(exclude).github/workflows/ci.yml',':(exclude)diagnostic/retention-pilot')
if (changed || git('status','--porcelain=v1')) throw new Error('production source or checkout changed')
const fixture=join(taskSource,'diagnostic/retention-pilot/fake-codex-1545.mjs')
const osHome=homedir()
for (const path of ['.codex/sessions','.codex/archived_sessions','.codex/auth.json','.codex/config.toml','.codex/history.jsonl','.claude','.cursor','.config/gh','.ssh','.aws','.netrc','.git-credentials','.gemini','.qwen','Library/Application Support/Cursor/User/globalStorage','.local/share/opencode','.config/opencode','.cline','.openclaw','.hermes','.codebuddy','.kimi','.pi','.grok','.copilot','.dsh','.devin','.config/gcloud']) {
 if(existsSync(join(osHome,path))) throw new Error('ambient agent or credential location exists')
}
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
const env={HOME:osHome,USER:process.env.USER??'',LOGNAME:process.env.LOGNAME??'',LANG:'en_US.UTF-8',HARNESSDESK_HOME:taskDeskHome,CODEX_HOME:taskCodexProfile,HARNESSDESK_CODEX_BINARY:fixture,PATH:[taskFakebin,'/usr/bin','/bin','/usr/sbin','/sbin'].join(':'),HARNESSDESK_PATH:taskFakebin,SHELL:'',TMPDIR:taskRoot,HARNESSDESK_NO_UPDATE_CHECK:'1',HARNESSDESK_LEAD:'0',HARNESSDESK_PHONE_LINK:'0',HARNESSDESK_MENU_BAR:'off',HARNESSDESK_CATALOG_REFRESH_MINUTES:'0',HARNESSDESK_ACP_REGISTRY_URL:'http://127.0.0.1:1/disabled',HARNESSDESK_CLOUD_URL:'http://127.0.0.1:1',HD_1545_OUTPUT_BYTES:'32768',HARNESSDESK_CODEX_PROCESS_GROUP:randomUUID(),FAKE_CODEX_ROLLOUT_HOME:taskCodexProfile,FAKE_CODEX_PERSIST_TURN:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}
const result={source:taskSha,fixtureSha256:sha(fixture),phase:'prepared',checks:{}}
let desk
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
 result.phase='close';await cdp.eval('window.__hdStore.closePane(window.__hdStore.getSnapshot().layout.focused)')
 const addr={runtime,sessionId:id}
 result.phase='snapshot';const snapshot=await waitFor('host snapshot',()=>cdp.json(`window.__hdStore.transport.request('session/cache-snapshot',${JSON.stringify(addr)}).then(x=>x&&({identity:x.identity,watermark:x.watermark,turns:x.session.turns.length}))`),30000)
 result.checks.snapshot={identityLength:snapshot.identity?.length,watermarkFields:['epoch','generation','revision','sequence'].every(k=>snapshot.watermark?.[k]!==undefined),turns:snapshot.turns}
 const receipt=await waitFor('fresh host receipt',()=>cdp.json(`window.__hdStore.transport.request('session/prepare-eviction',${JSON.stringify({...addr,identity:snapshot.identity})}).then(x=>x&&({identity:x.identity,epoch:x.epoch,generation:x.generation,revision:x.revision,sequence:x.sequence}))`),30000)
 if(receipt.identity!==snapshot.identity||['epoch','generation','revision','sequence'].some(k=>receipt[k]!==snapshot.watermark[k]))throw new Error('receipt does not match host snapshot')
 result.checks.exactReceipt=true
 result.phase='release';await waitFor('real release',()=>cdp.eval(`window.__hdStore.unloadTranscript(${JSON.stringify(runtime)},${JSON.stringify(id)})`),30000)
 if(await cdp.eval(`window.__hdStore.getSnapshot().sessions.get(${JSON.stringify(key)})?.itemsLoaded`)!==false)throw new Error('body was not released')
 result.phase='restore';if(!await cdp.eval(`window.__hdStore.restoreTranscript(${JSON.stringify(runtime)},${JSON.stringify(id)})`))throw new Error('restore refused')
 const restored=await cdp.json(`window.__hdStore.transport.request('session/cache-snapshot',${JSON.stringify(addr)}).then(x=>x&&({identity:x.identity,turns:x.session.turns.length}))`)
 if(restored?.identity!==snapshot.identity||restored.turns!==snapshot.turns)throw new Error('restored body identity mismatch')
 result.checks.restoreExact=true;result.checks.listenersAtEnd=assertListeners(desk.processGroup);result.phase='passed'
} catch { result.error='checkpoint failed';process.exitCode=1 }
finally {try{await closeDesk(desk??{})}catch{result.cleanupError=true;process.exitCode=1} console.log(JSON.stringify(result)); rmSync(taskRoot,{recursive:true,force:true})}
