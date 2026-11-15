import test from 'node:test'
import assert from 'node:assert/strict'
import { provenanceOf, assetIndex } from './closure-provenance.mjs'

const source='const a = () => 42;\nconst b = () => 7;\n'
const assets=assetIndex([source])
const hash=assets[0].sha256
const rig=(over={})=>{
 let listener, releases=0, disables=0, properties=0
 const cdp={on:(event,fn)=>{assert.equal(event,'Debugger.scriptParsed');listener=fn;return ()=>{listener=null}},send:async(method,params,timeout)=>{
  assert.equal(timeout,2000)
  if(method==='Debugger.enable'){listener({scriptId:'7',hash,length:source.length,startLine:0,startColumn:0,url:'SECRET'});return {}}
  if(method==='Debugger.disable'){disables++;if(over.disableFails)throw Error('SECRET');return {}}
  if(method==='HeapProfiler.getObjectByHeapObjectId')return {result:{type:'function',objectId:'PRIVATE',...(over.proxy?{subtype:'proxy'}:{})}}
  if(method==='Runtime.getProperties'){
   properties++;assert.deepEqual(params,{objectId:'PRIVATE',ownProperties:true,generatePreview:false})
   if(over.getterFails)throw Error('SECRET')
   return { result:[{name:'SECRET',value:{value:'SECRET'}}], internalProperties:[{name:'[[FunctionLocation]]',value:{value:{scriptId:'7',lineNumber:0,columnNumber:10}}}] }
  }
  if(method==='Runtime.releaseObjectGroup'){releases++;if(over.releaseFails)throw Error('SECRET');return {}}
  throw Error('unexpected')
 }}
 return {cdp,counts:()=>({releases,disables,properties})}
}

test('matches bounded public-asset hash and location without exposing source or IDs',async()=>{
 const r=rig(),out=await provenanceOf(r.cdp,['19'],assets)
 assert.deepEqual(out,{status:'ok',locations:[{kind:'rendererAsset',sha256:hash,line:0,column:10}]})
 assert.deepEqual(r.counts(),{releases:1,disables:1,properties:1});assert.doesNotMatch(JSON.stringify(out),/SECRET|PRIVATE|\"19\"|const a/)
})
test('proxy is refused before reading properties and resources still release',async()=>{
 const r=rig({proxy:true}),out=await provenanceOf(r.cdp,['19'],assets)
 assert.deepEqual(out,{status:'ok',locations:[{kind:'unknown'}]});assert.deepEqual(r.counts(),{releases:1,disables:1,properties:0})
})
test('lookup and cleanup failures produce fixed non-sensitive results',async()=>{
 let r=rig({getterFails:true}),out=await provenanceOf(r.cdp,['19'],assets);assert.deepEqual(out,{status:'ok',locations:[{kind:'unknown'}]})
 r=rig({releaseFails:true});assert.deepEqual(await provenanceOf(r.cdp,['19'],assets),{status:'unavailable'})
 r=rig({disableFails:true});assert.deepEqual(await provenanceOf(r.cdp,['19'],assets),{status:'unavailable'})
 assert.deepEqual(await provenanceOf(r.cdp,Array.from({length:17},(_,i)=>String(i+1)),assets),{status:'unavailable'})
})

test('unmatched hash, malformed location, ambiguous asset and out-of-range coordinates are unknown',async()=>{
 const base=rig();const send=base.cdp.send
 for(const location of [null,{scriptId:'7',lineNumber:-1,columnNumber:0},{scriptId:'7',lineNumber:0,columnNumber:999999},{scriptId:'missing',lineNumber:0,columnNumber:1},{scriptId:'7',lineNumber:0,columnNumber:1,private:'x'.repeat(600)}]){
  base.cdp.send=async(method,params,timeout)=>method==='Runtime.getProperties'?{internalProperties:[{name:'[[FunctionLocation]]',value:{value:location}}]}:send(method,params,timeout)
  assert.deepEqual((await provenanceOf(base.cdp,['19'],assets)).locations,[{kind:'unknown'}])
 }
 base.cdp.send=send
 assert.deepEqual((await provenanceOf(base.cdp,['19'],assetIndex([source,source]))).locations,[{kind:'unknown'}])
 assert.deepEqual((await provenanceOf(base.cdp,['19'],assetIndex(['different']))).locations,[{kind:'unknown'}])
})
test('metadata overflow fails closed and does not expose raw event fields',async()=>{
 let listener
 const cdp={on:(_event,fn)=>{listener=fn;return()=>{}},send:async(method)=>{
  if(method==='Debugger.enable'){for(let i=0;i<4100;i++)listener({scriptId:String(i),hash,length:source.length,startLine:0,startColumn:0,url:'SECRET'});return {}}
  if(method==='Runtime.releaseObjectGroup'||method==='Debugger.disable')return {}
  throw Error('SECRET')
 }}
 const result=await provenanceOf(cdp,['19'],assets)
 assert.deepEqual(result,{status:'unavailable'});assert.doesNotMatch(JSON.stringify(result),/SECRET/)
})

test('only bounded regular public JS assets are indexed without exposing their paths',async()=>{
 const {readAssetIndex}=await import('./closure-provenance.mjs')
 const {mkdtempSync,writeFileSync,symlinkSync,rmSync}=await import('node:fs')
 const {join}=await import('node:path'), {tmpdir}=await import('node:os')
 const dir=mkdtempSync(join(tmpdir(),'hd-assets-'))
 try {writeFileSync(join(dir,'public.js'),source);writeFileSync(join(dir,'ignore.txt'),'SECRET');assert.deepEqual(readAssetIndex(dir),assets);symlinkSync(join(dir,'public.js'),join(dir,'bad.js'));assert.throws(()=>readAssetIndex(dir))}finally{rmSync(dir,{recursive:true,force:true})}
})

test('script offsets must describe the same complete standalone asset',async()=>{
 let listener,disabled=0,released=0
 const cdp={on:(_name,fn)=>{listener=fn;return()=>{}},send:async(method)=>{
  if(method==='Debugger.enable'){listener({scriptId:'7',hash,length:source.length,startLine:1,startColumn:0});return {}}
  if(method==='Debugger.disable'){disabled++;return {}}
  if(method==='Runtime.releaseObjectGroup'){released++;return {}}
  if(method==='HeapProfiler.getObjectByHeapObjectId')return {result:{type:'function',objectId:'private'}}
  if(method==='Runtime.getProperties')return {internalProperties:[{name:'[[FunctionLocation]]',value:{value:{scriptId:'7',lineNumber:0,columnNumber:0}}}]}
 }}
 assert.deepEqual(await provenanceOf(cdp,['19'],assets),{status:'ok',locations:[{kind:'unknown'}]})
 assert.equal(disabled,1);assert.equal(released,1)
})
test('object-group cleanup is awaited before provenance is returned',async()=>{
 const base=rig(),send=base.cdp.send;let release,done=false
 base.cdp.send=(method,params,timeout)=>method==='Runtime.releaseObjectGroup'?new Promise(resolve=>{release=resolve}):send(method,params,timeout)
 const pending=provenanceOf(base.cdp,['19'],assets).then(value=>{done=true;return value})
 await new Promise(resolve=>setTimeout(resolve,1));assert.equal(done,false);release();assert.equal((await pending).status,'ok')
})

test('debugger enable failure still awaits both cleanup operations',async()=>{
 const calls=[]
 const cdp={on:()=>()=>{},send:async method=>{calls.push(method);if(method==='Debugger.enable')throw Error('private');return {}}}
 assert.deepEqual(await provenanceOf(cdp,['19'],assets),{status:'unavailable'})
 assert.deepEqual(calls,['Debugger.enable','Runtime.releaseObjectGroup','Debugger.disable'])
})

test('irrelevant scopes and private descriptors are never traversed or returned',async()=>{
 const r=rig(),send=r.cdp.send
 r.cdp.send=async(method,params,timeout)=>method==='Runtime.getProperties'?{result:[{name:'secret-value',value:{value:'PRIVATE-CANARY'}}],internalProperties:[{name:'[[Scopes]]',value:{objectId:'NEVER-READ'}},{name:'[[FunctionLocation]]',value:{value:{scriptId:'7',lineNumber:0,columnNumber:10}}}]}:send(method,params,timeout)
 const out=await provenanceOf(r.cdp,['19'],assets)
 assert.equal(out.locations[0].kind,'rendererAsset')
 assert.doesNotMatch(JSON.stringify(out),/PRIVATE-CANARY|NEVER-READ|secret-value/)
})
test('asset offsets use zero-based UTF-16 code-unit bounds',()=>{
 const [asset]=assetIndex(['🙂x\nlast'])
 assert.deepEqual(asset.lines,[3,4])
})
