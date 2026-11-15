import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyClosures, writeClosureIds } from './closure-classification.mjs'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('classifies only fixed roles, keeps source private and releases the owned group',async()=>{
 const calls=[];const cdp={send:async(method,params,timeout)=>{calls.push({method,params,timeout});if(method==='HeapProfiler.getObjectByHeapObjectId')return {result:{type:'function',objectId:'remote-secret'}};if(method==='Runtime.callFunctionOn')return {result:{value:{shortcut:true,settings:false,seatFix:false,navigation:true,preserveDraft:false,secret:'PRIVATE'}}};return {}}}
 const result=await classifyClosures(cdp,['123'])
 assert.deepEqual(result,{status:'ok',uniqueClosureCount:1,unavailable:0,roles:{shortcut:1,settings:0,seatFix:0,navigation:1,preserveDraft:0,other:0}})
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|remote-secret|123/)
 assert.equal(calls.at(-1).method,'Runtime.releaseObjectGroup');assert.ok(calls.every(c=>c.timeout===2000))
 assert.match(calls[1].params.functionDeclaration,/Function\.prototype\.toString\.call\(this\)/)
})
test('unknown and failed remote lookups are bounded and never leak errors',async()=>{
 let released=0;const cdp={send:async method=>{if(method==='HeapProfiler.getObjectByHeapObjectId')throw Error('PRIVATE');if(method==='Runtime.releaseObjectGroup'){released++;return {}};throw Error('unexpected')}}
 const out=await classifyClosures(cdp,['123','456']);assert.equal(out.unavailable,2);assert.equal(released,1);assert.doesNotMatch(JSON.stringify(out),/PRIVATE|123|456/)
 assert.equal((await classifyClosures(cdp,Array.from({length:17},(_,i)=>String(i+1)))).status,'unavailable')
})
test('private closure file is exclusive, 0600, bounded and does not contain arbitrary content',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hd-closures-test-'))
 try {const path=join(dir,'private.json');writeClosureIds(path,['23','23','45']);assert.equal(statSync(path).mode&0o777,0o600);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),['23','45']);assert.throws(()=>writeClosureIds(path,['23']));assert.throws(()=>writeClosureIds(join(dir,'bad'),['SECRET']));assert.throws(()=>writeClosureIds(join(dir,'many'),Array.from({length:17},(_,i)=>String(i+1))))}finally{rmSync(dir,{recursive:true,force:true})}
})
test('renderer role checks return only booleans for exact signatures and reject oversized sources',async()=>{
 const {closureRoleFlags}=await import('./closure-classification.mjs')
 const shortcut=function(){return ['new-team','nav-back','close-pane','new-session','private-secret']}
 assert.deepEqual(closureRoleFlags.call(shortcut),{shortcut:true,settings:false,seatFix:false,navigation:false,preserveDraft:false})
 const settings=function(){return ['settingsFor','askSettings']};assert.equal(closureRoleFlags.call(settings).settings,true)
 const seat=function(){return ['seatFix','askSeatFix']};assert.equal(closureRoleFlags.call(seat).seatFix,true)
 const other=function(){return 'private-secret'};assert.deepEqual(Object.values(closureRoleFlags.call(other)),[false,false,false,false,false])
 const big=Function(`return ${JSON.stringify('x'.repeat(65537))}`);assert.equal(closureRoleFlags.call(big),null)
 assert.equal(closureRoleFlags.call({}),null)
})
test('release failure suppresses results',async()=>{
 const out=await classifyClosures({send:async method=>{if(method==='Runtime.releaseObjectGroup')throw Error('private');throw Error('private')}},['123'])
 assert.deepEqual(out,{status:'unavailable'})
})
test('worker writes private sampled IDs while stdout excludes IDs and paths',async()=>{
 const {spawnSync}=await import('node:child_process');const {writeFileSync}=await import('node:fs')
 const dir=mkdtempSync(join(tmpdir(),'hd-worker-test-'))
 try {
  const a='a'.repeat(256),b='b'.repeat(256)
  const graph={snapshot:{meta:{node_fields:['type','name','id','self_size','edge_count'],node_types:[['synthetic','closure','string']],edge_fields:['type','name_or_index','to_node'],edge_types:[['property']]}},strings:['root','secret-function',a,b],nodes:[0,0,1,0,1,1,1,37,0,2,2,2,4,1,0,2,3,5,1,0],edges:[0,0,5,0,0,10,0,0,15]}
  const expected=Array.from({length:400},(_,i)=>({needle:i===0?a:i===1?b:i.toString(16).padStart(256,'0'),loaded:i!==1}))
  const heap=join(dir,'heap.json'),keys=join(dir,'keys.json'),ids=join(dir,'closures.json')
  writeFileSync(heap,JSON.stringify(graph));writeFileSync(keys,JSON.stringify(expected))
  const child=spawnSync(process.execPath,[new URL('./heap-worker.mjs',import.meta.url).pathname,heap,keys,ids],{encoding:'utf8'})
  assert.equal(child.status,0);assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(readFileSync(ids,'utf8')),['37']);assert.equal(statSync(ids).mode&0o777,0o600)
  assert.doesNotMatch(child.stdout,/secret-function|strongPaths|\"37\"|aaaa/);assert.equal(JSON.parse(child.stdout).status,'ok')
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('classifier awaits remote object-group release before returning',async()=>{
 let release,done=false
 const cdp={send:async method=>{if(method==='HeapProfiler.getObjectByHeapObjectId')throw Error('private');if(method==='Runtime.releaseObjectGroup')return new Promise(resolve=>{release=resolve})}}
 const pending=classifyClosures(cdp,['123']).then(value=>{done=true;return value})
 await new Promise(resolve=>setTimeout(resolve,1));assert.equal(done,false);release();assert.equal((await pending).unavailable,1)
})
