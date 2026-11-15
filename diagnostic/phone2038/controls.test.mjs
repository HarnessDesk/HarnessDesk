import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixture=fileURLToPath(new URL('./fake-codex-2038.mjs',import.meta.url))
test('fake refuses unsafe modes and controller refuses an ordinary host',()=>{
 const text=readFileSync(fixture,'utf8')
 assert.doesNotMatch(text,/https?:\/\/(?!127\.0\.0\.1:1)/)
 assert.match(text,/case 'command\/exec':\s*\{\s*send\(\{ id, error:/)
 assert.match(text,/said\.startsWith\('git-steer-run '\)\) \{ send\(\{ id, error:/)
 const fixtureVersion=spawnSync(process.execPath,[fixture,'--version'],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});assert.equal(fixtureVersion.status,0)
 const controller=spawnSync(process.execPath,[fileURLToPath(new URL('./controller.mjs',import.meta.url))],{env:{PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:5000});assert.notEqual(controller.status,0);assert.deepEqual(JSON.parse(controller.stdout),{phase:'preflight',checks:{},error:'checkpoint failed'})
})
test('two fake sends produce distinct turn IDs and exact approval receipts', {timeout:10000}, async()=>{
 const root=mkdtempSync(join(tmpdir(),'hd2038-fake-test-')),receipt=join(root,'receipt')
 const child=spawn(process.execPath,[fixture,'app-server'],{env:{PATH:'/usr/bin:/bin',HD_1545_OUTPUT_BYTES:'0',HD_2038_APPROVAL_RECEIPT:receipt},stdio:['pipe','pipe','pipe']})
 const lines=createInterface({input:child.stdout}), turns=[],requests=[],completed=[],commands=[];let thread
 try {
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('fixture timeout')),5000);child.once('error',reject);child.once('exit',()=>reject(Error('fixture exited')))
   lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
    if(m.id===1&&m.result?.thread?.id){thread=m.result.thread.id;child.stdin.write(JSON.stringify({id:2,method:'turn/start',params:{threadId:thread,input:[{type:'text',text:'first'}]}})+'\n')}
    if(m.method==='item/commandExecution/requestApproval'){requests.push(m.id);child.stdin.write(JSON.stringify({id:m.id,result:{decision:'accept'}})+'\n')}
    if(m.method==='item/completed'&&m.params?.item?.type==='commandExecution')commands.push(m.params.item.id)
    if(m.method==='turn/completed'){completed.push(m.params.turn.id);if(completed.length===1)child.stdin.write(JSON.stringify({id:3,method:'turn/start',params:{threadId:thread,input:[{type:'text',text:'second'}]}})+'\n');if(completed.length===2){clearTimeout(timer);resolve()}}
    if((m.id===2||m.id===3)&&m.result?.turn?.id)turns.push(m.result.turn.id)
   });child.stdin.write(JSON.stringify({id:1,method:'thread/start',params:{cwd:'/tmp',dynamicTools:[]}})+'\n')
  })
  assert.equal(turns.length,2);assert.equal(new Set(turns).size,2);assert.deepEqual(completed,turns);assert.equal(commands.length,2);assert.equal(commands[0],commands[1])
  const got=readFileSync(receipt,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(got,requests.map(id=>({id,decision:'accept'})))
 } finally {lines.close();child.stdin.end();child.kill();await new Promise(resolve=>child.once('close',resolve));rmSync(root,{recursive:true,force:true})}
})

test('listener guard accepts only the app-owned known phone port outside loopback', async()=>{
 const {checkListeners}=await import('./listener-guard.mjs')
 const owned=new Set([17,18]), valid='p17\nn127.0.0.1:1000\nn*:2000\np18\nn127.0.0.1:3000\n'
 assert.deepEqual(checkListeners(valid,owned,2000,1000),{total:3,nonloopback:1,owned:true})
 for(const bad of [valid+'n*:9999\n',valid.replace('p17\nn127','p18\nn127').replace('n*:2000','p17\nn*:2000'),valid.replace('*:2000','*:9999'),valid+'p19\nn127.0.0.1:3\n'])assert.throws(()=>checkListeners(bad,owned,2000,1000))
})
