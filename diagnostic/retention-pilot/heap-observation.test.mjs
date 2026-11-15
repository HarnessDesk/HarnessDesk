import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHeap, stableProtected } from './heap-observation.mjs'

const graph=(bodyNames, extra=[])=>({snapshot:{meta:{node_fields:['type','name','id','self_size','edge_count'],node_types:[['synthetic','object','string','concatenated string']],edge_fields:['type','name_or_index','to_node'],edge_types:[['internal','property']]}},strings:['root','AppStore',...bodyNames,...extra],nodes:[0,0,1,0,1,1,1,2,16,bodyNames.length,...bodyNames.flatMap((_,i)=>[2,2+i,3+i,32784,0])],edges:[1,0,5,...bodyNames.flatMap((_,i)=>[1,0,10+i*5])]})
test('detects known loaded and released bodies and reports a bounded safe path category',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body'])
 const value=analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false},{needle:'cccc',loaded:false}])
 assert.equal(value.status,'ok');assert.equal(value.loadedDetected,1);assert.equal(value.releasedDetected,1);assert.equal(value.releasedUnknown,1)
 assert.equal(value.pathCategories.appStore,1);assert.doesNotMatch(JSON.stringify(value),/aaaa|bbbb|cccc|AppStore/)
})
test('missing loaded control is unavailable, including truncated or cons representations',()=>{
 const snapshot=graph(['aaa'])
 snapshot.nodes[10]=3
 assert.equal(analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false}]).status,'unavailable')
})
test('late capture requires matching protected quiet states before and after collection',()=>{
 const state={enabled:true,pressureRunning:false,pressureDirty:false,recovery:0,eligibilityKnown:false,visibleMounted:true,visibleLoaded:true,draftPresent:true,draftLoaded:true,pendingPresent:true,pendingLoaded:true,pendingActive:true,pendingMounted:false,pendingCloseSent:0,pendingCloseResolved:0,pendingCloseRejected:0,knownMissing:0}
 assert.equal(stableProtected(state,{...state}),true)
 assert.equal(stableProtected(state,{...state,pressureDirty:true}),false)
 assert.equal(stableProtected(state,{...state,loaded:1}),false)
})

test('capture refuses changed protected state without emitting heap data',async()=>{
 const {captureLateHeap}=await import('./heap-capture.mjs')
 const state={enabled:true,pressureRunning:false,pressureDirty:false,recovery:0,eligibilityKnown:false,visibleMounted:true,visibleLoaded:true,draftPresent:true,draftLoaded:true,pendingPresent:true,pendingLoaded:true,pendingActive:true,pendingMounted:false,pendingCloseSent:0,pendingCloseResolved:0,pendingCloseRejected:0,knownMissing:0}
 let reads=0,captures=0
 const result=await captureLateHeap({read:async()=>({...state,pressureDirty:++reads===2}),drain:async()=>{},collect:async()=>{},snapshot:async()=>{captures++},analyze:async()=>({status:'ok'})})
 assert.deepEqual(result,{status:'state-changed'});assert.equal(captures,0)
})
test('capture requires unchanged post-snapshot state and converts failures to fixed labels',async()=>{
 const {captureLateHeap}=await import('./heap-capture.mjs')
 const state={enabled:true,pressureRunning:false,pressureDirty:false,recovery:0,eligibilityKnown:false,visibleMounted:true,visibleLoaded:true,draftPresent:true,draftLoaded:true,pendingPresent:true,pendingLoaded:true,pendingActive:true,pendingMounted:false,pendingCloseSent:0,pendingCloseResolved:0,pendingCloseRejected:0,knownMissing:0}
 let reads=0
 const opts={read:async()=>({...state,loaded:++reads===4?3:2}),drain:async()=>{},collect:async()=>{},snapshot:async()=>{},analyze:async()=>({status:'ok'})}
 assert.deepEqual(await captureLateHeap(opts),{status:'state-changed'})
 assert.deepEqual(await captureLateHeap({...opts,drain:async()=>{throw Error('secret')}}),{status:'unavailable'})
})

test('weak-only incoming paths never establish a strong root category',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body'])
 snapshot.snapshot.meta.edge_types[0].push('weak')
 snapshot.edges[0]=2
 const out=analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false}])
 assert.equal(out.pathCategories.unknown,1);assert.equal(out.pathCategories.appStore,0)
})
test('short hash prefix is unknown and matched string sizes are lower bounds',()=>{
 const snapshot=graph(['a'.repeat(256)+'body','b'.repeat(64)])
 const out=analyzeHeap(snapshot,[{needle:'a'.repeat(256),loaded:true},{needle:'b'.repeat(256),loaded:false}])
 assert.equal(out.loadedDetected,1);assert.equal(out.releasedDetected,0);assert.equal(out.releasedUnknown,1)
 assert.equal(out.loadedMatchedStringSelfBytesLowerBound,32784);assert.equal(out.releasedMatchedStringSelfBytesLowerBound,0)
})
test('Cdp.eval release is awaited and failed or timed out releases fail closed',async()=>{
 const {Cdp}=await import('../../script/lib/desk.mjs')
 const {installHeldTracker}=await import('./heap-capture.mjs')
 let release, rejectRelease
 const cdp=new Cdp()
 cdp.send=(method)=>method==='Runtime.evaluate'?Promise.resolve({result:{objectId:'one',subtype:'promise'}}):method==='Runtime.awaitPromise'?Promise.resolve({result:{value:1}}):new Promise((resolve,reject)=>{release=resolve;rejectRelease=reject})
 const drain=installHeldTracker(cdp,20)
 assert.equal(await cdp.eval('Promise.resolve(1)'),1)
 let done=false;const wait=drain().then(()=>{done=true})
 await new Promise(resolve=>setTimeout(resolve,1));assert.equal(done,false);release();await wait;assert.equal(done,true)
 await cdp.eval('Promise.resolve(1)');rejectRelease(new Error('private'));await assert.rejects(drain())
 const other=new Cdp();other.send=(method)=>method==='Runtime.evaluate'?Promise.resolve({result:{objectId:'one',subtype:'promise'}}):method==='Runtime.awaitPromise'?Promise.resolve({result:{value:1}}):new Promise(resolve=>{release=resolve})
 const timeoutDrain=installHeldTracker(other,5);await other.eval('Promise.resolve(1)');await assert.rejects(timeoutDrain());release()
})

test('a partial snapshot chunk write fails closed',async()=>{
 const {writeSnapshotChunk}=await import('./heap-capture.mjs')
 assert.equal(writeSnapshotChunk('abcd',()=>4),true)
 assert.equal(writeSnapshotChunk('abcd',()=>3),false)
 assert.equal(writeSnapshotChunk('é',()=>2),true)
 assert.equal(writeSnapshotChunk('é',()=>1),false)
 assert.equal(writeSnapshotChunk('abcd',()=>{throw Error('private')}),false)
})
