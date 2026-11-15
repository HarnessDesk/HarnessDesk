import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRpcObserver, classifyProfileError } from './profile-rpc-observer.mjs'

test('observes promise identity, receiver, nulls, rejection and bounded scalar privacy', async () => {
 let clock=100, resolve, reject
 const a=new Promise(r=>{resolve=r}), b=new Promise((_,r)=>{reject=r})
 const receiver={tag:'private'}, seen=[]
 const original=function(method,params){seen.push(this);return method==='session/cache-snapshot'?a:b}
 const observer=createRpcObserver(original,()=>clock)
 assert.equal(observer.request.call(receiver,'session/cache-snapshot',{sessionId:'secret'}),a)
 assert.equal(observer.request.call(receiver,'session/prepare-eviction',{sessionId:'secret'}),b)
 clock=110
 let report=observer.snapshot(()=>7)
 assert.equal(report.cacheSnapshot.active,1);assert.equal(report.cacheSnapshot.oldestAgeMs,10);assert.equal(report.cacheSnapshot.oldestOrdinal,7)
 resolve(null);reject(new Error('private error'));await Promise.allSettled([a,b]);await Promise.resolve()
 clock=120;report=observer.snapshot()
 assert.equal(report.cacheSnapshot.nulls,1);assert.equal(report.cacheSnapshot.completed,1);assert.equal(report.prepareEviction.rejected,1);assert.equal(report.cacheSnapshot.sumDurationMs,10);assert.equal(report.prepareEviction.sumDurationMs,10)
 assert.deepEqual(seen,[receiver,receiver]);assert.doesNotMatch(JSON.stringify(report),/secret|private/)
})
test('classifies only exact known errors', () => {
 assert.equal(classifyProfileError(new Error('quiescent pressure: readiness deadline')),'quiescence-deadline')
 assert.equal(classifyProfileError(new Error('pending sentinel did not survive navigation')),'pending-sentinel')
 assert.equal(classifyProfileError(new Error('quiescent pressure: readiness deadline secret')),'unclassified')
 assert.equal(classifyProfileError({message:'quiescent pressure: readiness deadline'}),'unclassified')
})
test('observer preserves synchronous throws and marks bounded tracking overflow', async () => {
 const error=new Error('secret')
 const observer=createRpcObserver(function(method){if(method==='unrelated')throw error;return new Promise(()=>{})},()=>100)
 assert.throws(()=>observer.request('unrelated',{}),value=>value===error)
 for(let i=0;i<513;i++)observer.request('session/cache-snapshot',{sessionId:'secret'})
 const stats=observer.snapshot().cacheSnapshot
 assert.equal(stats.started,513);assert.equal(stats.active,513);assert.equal(stats.trackingOverflow,true);assert.equal(stats.oldestAgeMs,null);assert.equal(stats.oldestOrdinal,-1)
})
test('telemetry locator failure cannot change the request result', async () => {
 const answer=Promise.resolve('value'), receiver={}
 const observer=createRpcObserver(function(){assert.equal(this,receiver);return answer},()=>10,()=>{throw Error('private')})
 assert.equal(observer.request.call(receiver,'session/cache-snapshot',{}),answer)
 assert.equal(await answer,'value')
 await Promise.resolve()
 assert.equal(observer.snapshot().cacheSnapshot.completed,1)
})
test('only the fixed first-line sentinel diagnostic is classified', () => {
 assert.equal(classifyProfileError(new Error('Error: sentinel protection missing\nprivate stack')),'sentinel-protection')
 assert.equal(classifyProfileError(new Error('Error: sentinel protection missing and private')),'unclassified')
})
test('oldest active ordinal resolves through a private reference and reports no reference', async () => {
 let now=0,finishFirst,finishSecond
 const first=new Promise(resolve=>{finishFirst=resolve}),second=new Promise(resolve=>{finishSecond=resolve})
 const refA={opaque:'secret-a'},refB={opaque:'secret-b'},refs=[refA,refB];let i=0
 const observer=createRpcObserver(()=>i++===0?first:second,()=>now,()=>refs[i])
 observer.request('session/cache-snapshot',{});now=5;observer.request('session/cache-snapshot',{});now=20
 const ordinal=ref=>refs.indexOf(ref)+1
 assert.equal(observer.snapshot(ordinal).cacheSnapshot.oldestOrdinal,1)
 assert.equal(observer.snapshot(ordinal).cacheSnapshot.oldestAgeMs,20)
 finishFirst({});await first;await Promise.resolve()
 assert.equal(observer.snapshot(ordinal).cacheSnapshot.oldestOrdinal,2)
 assert.doesNotMatch(JSON.stringify(observer.snapshot(ordinal)),/secret/)
 finishSecond({});await second
})
test('renderer-serialized observer is self-contained', async () => {
 const {runInNewContext}=await import('node:vm')
 const create=runInNewContext(`(${createRpcObserver.toString()})`,{Promise})
 const answer=Promise.resolve(null),observer=create(()=>answer,()=>0)
 assert.equal(observer.request('session/cache-snapshot',{}),answer)
 await answer;await Promise.resolve()
 assert.equal(observer.snapshot().cacheSnapshot.nulls,1)
})
