import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeHeap, stableProtected } from './heap-observation.mjs'

const graph=(bodyNames, extra=[])=>({snapshot:{meta:{node_fields:['type','name','id','self_size','edge_count'],node_types:[['synthetic','object','string','concatenated string']],edge_fields:['type','name_or_index','to_node'],edge_types:[['internal','property']]}},strings:['root','AppStore',...bodyNames,...extra],nodes:[0,0,1,0,1,1,1,2,16,bodyNames.length,...bodyNames.flatMap((_,i)=>[2,2+i,3+i,32784,0])],edges:[1,0,5,...bodyNames.flatMap((_,i)=>[1,0,10+i*5])]})
test('detects known loaded and released bodies and reports a bounded safe path category',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body'])
 const value=analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false},{needle:'cccc',loaded:false}])
 assert.equal(value.status,'ok');assert.equal(value.loadedDetected,1);assert.equal(value.releasedDetected,1);assert.equal(value.releasedUnknown,1)
 assert.equal(value.pathCategories.appStore,1);assert.doesNotMatch(JSON.stringify(value),/aaaa|bbbb|cccc/)
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

test('released ordinal buckets and strong paths reveal only allowed vocabulary',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body','cccc-body'])
 snapshot.strings.push('memoizedState','private-url-unique-sentinel','(GC roots)')
 snapshot.nodes[1]=snapshot.strings.indexOf('(GC roots)')
 // Root -> AppStore (private property); AppStore -> loaded and released outputs.
 snapshot.edges[1]=snapshot.strings.indexOf('private-url-unique-sentinel')
 snapshot.edges[7]=snapshot.strings.indexOf('memoizedState')
 const expected=Array.from({length:400},(_,i)=>({needle:'not-found-'+i,loaded:true}))
 expected[0]={needle:'aaaa',loaded:true};expected[72]={needle:'bbbb',loaded:false};expected[200]={needle:'cccc',loaded:false}
 const out=analyzeHeap(snapshot,expected)
 assert.deepEqual(out.releasedMatchedOrdinalBuckets,{zeroTo71:0,seventyTwoTo199:1,twoHundredTo271:1,twoSeventyTwoTo399:0})
 assert.equal(out.strongPaths.length,2);assert.equal(out.strongPaths[0].status,'rooted')
 assert.equal(out.strongPaths[0].rootKind,'gcRoots')
 assert.equal(out.strongPaths[0].steps.some(s=>s.edgeLabel==='memoizedState'),true)
 assert.equal(out.strongPaths[0].steps.some(s=>s.edgeLabel==='other'),true)
 assert.doesNotMatch(JSON.stringify(out),/private-url-unique-sentinel|aaaa|bbbb|cccc/)
})
test('weak-only path produces a fixed unavailable path',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body']);snapshot.snapshot.meta.edge_types[0].push('weak');snapshot.edges[0]=2
 const out=analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false}])
 assert.deepEqual(out.strongPaths,[{status:'unavailable'}])
})

test('minified object shapes and known listener names are fixed hints without private names',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body'])
 const extra=['sessions','runtimes','layout','workbench','approvals','runtime','id','turns','itemsLoaded','EventListener','onShortcut','private-shape-sentinel']
 snapshot.strings.push(...extra)
 const name=x=>snapshot.strings.indexOf(x)
 // Existing object is anonymous/minified and has the fixed own-property shape;
 // synthetic self-edges are sufficient to model object own properties.
 snapshot.strings[1]='private-shape-sentinel'
 const properties=['sessions','runtimes','layout','workbench','approvals']
 snapshot.nodes[9]+=properties.length
 const insertAt=3+2*3
 snapshot.edges.splice(insertAt,0,...properties.flatMap(x=>[1,name(x),5]))
 const result=analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false}])
 assert.equal(result.strongPaths[0].steps.some(step=>step.shapeHint==='AppSnapshotShape'),true)
 assert.equal(result.strongPaths[0].shapeHits.appSnapshot,1)
 assert.doesNotMatch(JSON.stringify(result),/private-shape-sentinel|aaaa|bbbb/)
})

test('session shape and listener names remain hints for minified paths',()=>{
 const snapshot=graph(['aaaa-body','bbbb-body'])
 snapshot.strings.push('runtime','id','turns','itemsLoaded','onShortcut','private-shape-sentinel')
 snapshot.strings[1]='onShortcut'
 snapshot.nodes[9]+=4
 snapshot.edges.splice(9,0,...['runtime','id','turns','itemsLoaded'].flatMap(x=>[1,snapshot.strings.indexOf(x),5]))
 const out=analyzeHeap(snapshot,[{needle:'aaaa',loaded:true},{needle:'bbbb',loaded:false}])
 assert.equal(out.strongPaths[0].steps.some(s=>s.shapeHint==='SessionShape'&&s.nodeLabel==='onShortcut'),true)
 assert.equal(out.strongPaths[0].shapeHits.session,1)
 assert.doesNotMatch(JSON.stringify(out),/private-shape-sentinel|aaaa|bbbb/)
})
