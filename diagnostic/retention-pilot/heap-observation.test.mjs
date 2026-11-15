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
