import { test } from 'node:test'
import assert from 'node:assert/strict'
import { quietPrecheck, quiescenceStep, sanitizeProbeCounts } from './profile-quiescence.mjs'
import { canonicalBytes, summarize } from './profile-scalars.mjs'
const counts=()=>({prechecks:0,busyPrechecks:0,fullSamples:0})
const fixture=()=>{
 const sent={visible:'v',draft:'d',pending:'p'},sessions=new Map(Object.values(sent).map(k=>[k,{itemsLoaded:true,turns:[]}]))
 sessions.get('p').turns.push({status:'inProgress',items:[]})
 sessions.set('w',{itemsLoaded:true,turns:[{items:[{text:'hello'}]}]})
 const snapshot={sessions,layout:{root:{kind:'pane',view:{kind:'conversation',session:'v'}}},approvals:[{key:'p'}]}
 const stats={enabled:true,pressureRunning:false,pressureDirty:false}
 const store={getSnapshot:()=>snapshot,transcriptCacheStats:()=>stats,drafts:{live:k=>k==='d'?{}:null}}
 const sample=async()=>({...quietPrecheck(store,sent),...summarize(sessions,['w'],Object.values(sent),canonicalBytes)})
 return {sent,sessions,snapshot,stats,store,sample}
}
const step=(f,barrier=async()=>{},c=counts())=>quiescenceStep(true,async()=>quietPrecheck(f.store,f.sent),f.sample,barrier,c)
test('actual renderer precheck survives function serialization',()=>{const f=fixture(),fn=Function(`return (${quietPrecheck.toString()})`)();assert.deepEqual(fn(f.store,f.sent),quietPrecheck(f.store,f.sent))})
test('busy precheck skips bytes; then quiet uses both original samples',async()=>{const f=fixture(),c=counts();f.stats.pressureRunning=true;assert.equal(await step(f,undefined,c),false);assert.deepEqual(c,{prechecks:1,busyPrechecks:1,fullSamples:0});f.stats.pressureRunning=false;assert.deepEqual(await step(f,undefined,c),await f.sample());assert.deepEqual(c,{prechecks:2,busyPrechecks:1,fullSamples:2})})
test('quiet precheck cannot authorize busy first sample or a busy second sample',async()=>{const f=fixture(),c=counts();assert.equal(await quiescenceStep(true,async()=>{f.stats.pressureRunning=true;return {enabled:true,pressureRunning:false,pressureDirty:false}},f.sample,async()=>{},c),false);f.stats.pressureRunning=false;assert.equal(await step(f,async()=>{f.stats.pressureDirty=true}),false)})
test('a byte-changing in-place mutation across the original barrier is rejected',async()=>{const f=fixture();assert.equal(await step(f,async()=>{f.sessions.get('w').turns[0].items[0].text+=' more'}),false)})
test('equal-length in-place mutation retains original scalar-comparison limit',async()=>{const f=fixture();assert.notEqual(await step(f,async()=>{f.sessions.get('w').turns[0].items[0].text='world'}),false)})
test('busy precheck detects unloaded and unprotected sentinels',async()=>{const f=fixture();f.stats.pressureRunning=true;f.sessions.get('p').itemsLoaded=false;await assert.rejects(step(f),/sentinel not loaded/);f.sessions.get('p').itemsLoaded=true;f.snapshot.approvals=[];await assert.rejects(step(f),/sentinel protection missing/)})
test('malformed busy workload defers the original serialization failure',async()=>{const f=fixture(),cycle=[];cycle.push(cycle);f.sessions.get('w').turns=cycle;f.stats.pressureRunning=true;await assert.rejects(f.sample(),TypeError);assert.equal(await step(f),false);f.stats.pressureRunning=false;await assert.rejects(step(f),TypeError)})
test('report counts reject unexpected, negative and oversized values',()=>{assert.deepEqual(sanitizeProbeCounts({prechecks:2,busyPrechecks:1,fullSamples:2,private:'no'}),{prechecks:2,busyPrechecks:1,fullSamples:2});for(const bad of [{prechecks:-1,busyPrechecks:0,fullSamples:0},{prechecks:1,busyPrechecks:2,fullSamples:0},{prechecks:10001,busyPrechecks:0,fullSamples:0},{prechecks:NaN,busyPrechecks:0,fullSamples:0}])assert.equal(sanitizeProbeCounts(bad),null)})
test('non-400 path performs original full samples without precheck',async()=>{const f=fixture(),c=counts();let called=false;const out=await quiescenceStep(false,()=>{called=true;throw Error('unexpected')},f.sample,async()=>{},c);assert.equal(called,false);assert.deepEqual(out,await f.sample());assert.deepEqual(c,counts())})
