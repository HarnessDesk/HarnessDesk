import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureMetricDeltas, observeLateFailure, recordLateFailure } from './late-observation.mjs'

const protectedState={enabled:true,pressureRunning:false,pressureDirty:false,visibleMounted:true,visibleLoaded:true,draftPresent:true,draftLoaded:true,pendingPresent:true,pendingLoaded:true,pendingActive:true,pendingMounted:false,pendingCloseSent:0,pendingCloseResolved:0,pendingCloseRejected:0,knownMissing:0,loaded:9,released:3,recovery:0,metadata:12,knownLoaded:9,eligibilityKnown:false}
const rig=(read,heap=async()=>({usedSize:40,backingStorageSize:5}))=>{
 let now=0,gc=0,heaps=0,reads=0
 const original={phase:'checkpoint-400',error:'profile failed',errorCode:'quiescence-deadline',checkpoint:400,endState:{pressureRunning:true},checkpoints:[{completed:200}]}
 const options={now:()=>now,sleep:async ms=>{now+=ms},read:async()=>{reads++;return read(reads)},collect:async()=>{gc++},heap:async()=>{heaps++;return heap()}}
 return {original,options,counts:()=>({gc,heaps,reads})}
}

test('late observation keeps original failure unchanged and takes one heap only after stable protected quiescence',async()=>{
 const r=rig(()=>protectedState), before=structuredClone(r.original)
 const late=await observeLateFailure(r.options)
 assert.deepEqual(r.original,before)
 assert.equal(late.outcome,'quiescent');assert.equal(late.protection,true);assert.equal(late.quiescent,true)
 assert.deepEqual(late.counts,{metadata:12,loaded:9,released:3,recovery:0,knownLoaded:9,knownMissing:0})
 assert.deepEqual(late.heap,{usedBytes:40,backingBytes:5});assert.deepEqual(r.counts(),{gc:1,heaps:1,reads:2})
})
test('late observer times out with no heap and preserves a failure',async()=>{
 const r=rig(()=>({...protectedState,pressureRunning:true})),before=structuredClone(r.original)
 const late=await observeLateFailure(r.options)
 assert.deepEqual(r.original,before);assert.equal(late.outcome,'timeout');assert.equal(late.elapsedMs,60000);assert.equal(r.counts().gc,0)
})
test('protected loss or unreadable scalar refuses heap immediately',async()=>{
 for(const read of [()=>({...protectedState,pendingPresent:false}),()=>{throw Error('private details')}]){
  const r=rig(read),late=await observeLateFailure(r.options)
  assert.ok(['protection-lost','unavailable'].includes(late.outcome));assert.equal(r.counts().gc,0);assert.doesNotMatch(JSON.stringify(late),/private/)
 }
})
test('performance deltas allow only bounded finite counters and never leak unknown fields',()=>{
 const start={metrics:[{name:'TaskDuration',value:5},{name:'ScriptDuration',value:3},{name:'private-url',value:2},{name:'LayoutDuration',value:8},{name:'RecalcStyleDuration',value:0}]}
 const end={metrics:[{name:'TaskDuration',value:8},{name:'ScriptDuration',value:NaN},{name:'private-url',value:9},{name:'LayoutDuration',value:7},{name:'RecalcStyleDuration',value:90000}]}
 assert.deepEqual(captureMetricDeltas(start,end),{TaskDuration:3})
})


test('attaching a late observation leaves the original failure, checkpoint and end state intact',async()=>{
 const r=rig(()=>protectedState),before=structuredClone(r.original)
 await recordLateFailure(r.original,r.options)
 const {lateObservation,...original}=r.original
 assert.deepEqual(original,before);assert.equal(lateObservation.outcome,'quiescent')
 const other=rig(()=>protectedState);other.original.errorCode='other';await recordLateFailure(other.original,other.options)
 assert.equal('lateObservation' in other.original,false);assert.equal(other.counts().reads,0)
})

test('a close receipt or lost draft blocks the late heap sample',async()=>{
 for(const changed of [{pendingCloseResolved:1},{pendingCloseRejected:1},{draftLoaded:false},{knownMissing:1},{visibleMounted:false}]){
  const r=rig(()=>({...protectedState,...changed})),late=await observeLateFailure(r.options)
  assert.equal(late.outcome,'protection-lost');assert.equal(r.counts().gc,0)
 }
})
test('a failed heap read is an unavailable late measurement and does not change failure',async()=>{
 const r=rig(()=>protectedState,async()=>{throw Error('private details')}),before=structuredClone(r.original)
 await recordLateFailure(r.original,r.options)
 assert.equal(r.original.lateObservation.outcome,'quiescent');assert.equal(r.original.lateObservation.heapUnavailable,true)
 const {lateObservation,...original}=r.original;assert.deepEqual(original,before)
 assert.deepEqual(r.counts(),{gc:1,heaps:1,reads:2});assert.doesNotMatch(JSON.stringify(lateObservation),/private/)
})
