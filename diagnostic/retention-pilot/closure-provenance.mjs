import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const maxAssets=128, maxAssetBytes=16*1024*1024, maxEvents=4096, maxMetadata=512*1024
const validIds=ids=>Array.isArray(ids)&&ids.length<=16&&ids.every(id=>typeof id==='string'&&/^[1-9][0-9]{0,19}$/.test(id))&&new Set(ids).size===ids.length

/** Inputs are only controller-selected public renderer assets, never CDP paths. */
export function assetIndex(sources) {
 if(!Array.isArray(sources)||sources.length===0||sources.length>maxAssets)throw Error('assets unavailable')
 if(sources.some(source=>typeof source!=='string')||sources.reduce((total,source)=>total+Buffer.byteLength(source),0)>32*1024*1024)throw Error('assets unavailable')
 return sources.map(source=>{
  if(typeof source!=='string'||Buffer.byteLength(source)>maxAssetBytes)throw Error('asset unavailable')
  return {sha256:createHash('sha256').update(source,'utf8').digest('hex'),length:source.length,lines:source.split('\n').map(line=>line.length)}
 })
}

/** Read only regular JS files directly under the built renderer's assets directory. */
export function readAssetIndex(directory) {
 if(!lstatSync(directory).isDirectory())throw Error('assets unavailable')
 const names=readdirSync(directory).filter(name=>name.endsWith('.js')).sort()
 if(!names.length||names.length>maxAssets)throw Error('assets unavailable')
 let total=0
 const sources=names.map(name=>{
  const path=join(directory,name),stat=lstatSync(path)
  if(!stat.isFile()||stat.size>maxAssetBytes||(total+=stat.size)>32*1024*1024)throw Error('asset unavailable')
  const bytes=readFileSync(path),source=bytes.toString('utf8')
  if(!Buffer.from(source,'utf8').equals(bytes))throw Error('asset unavailable')
  return source
 })
 return assetIndex(sources)
}

/** Only hash-matched public-asset coordinates leave this helper. */
export async function provenanceOf(cdp,ids,assets) {
 if(!validIds(ids)||!Array.isArray(assets)||!assets.length||assets.length>maxAssets)return {status:'unavailable'}
 const scripts=new Map();let events=0,bytes=0,overflow=false,unsubscribe=()=>{},failure=false
 const results=[];const group='hd1545-provenance'
 try {
  unsubscribe=cdp.on('Debugger.scriptParsed',event=>{
   if(overflow)return
   if(++events>maxEvents){overflow=true;scripts.clear();return}
   const {scriptId,hash,length,startLine,startColumn}=event??{}
   if(startLine!==0||startColumn!==0)return
   if(typeof scriptId!=='string'||scriptId.length>64||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(length)||length<0)return
   bytes+=scriptId.length+hash.length+16
   if(bytes>maxMetadata){overflow=true;scripts.clear();return}
   const prior=scripts.get(scriptId)
   if(prior && (prior.hash!==hash || prior.length!==length)){overflow=true;scripts.clear();return}
   scripts.set(scriptId,{hash,length})
  })
  await cdp.send('Debugger.enable',{},2000)
  for(const id of ids){
   let result={kind:'unknown'}
   try {
    const remote=await cdp.send('HeapProfiler.getObjectByHeapObjectId',{objectId:id,objectGroup:group},2000)
    // Refuse proxy and all unusual subtypes before any property inspection.
    if(remote?.result?.type!=='function'||remote.result.subtype||typeof remote.result.objectId!=='string')throw Error()
    const reply=await cdp.send('Runtime.getProperties',{objectId:remote.result.objectId,ownProperties:true,generatePreview:false},2000)
    if(reply?.exceptionDetails||!Array.isArray(reply?.internalProperties)||reply.internalProperties.length>64)throw Error()
    const matches=reply.internalProperties.filter(entry=>entry?.name==='[[FunctionLocation]]')
    if(matches.length!==1)throw Error()
    const location=matches[0]?.value?.value
    if(!location||typeof location!=='object'||Array.isArray(location)||Object.keys(location).length!==3||typeof location.scriptId!=='string'||location.scriptId.length>64||!Number.isSafeInteger(location.lineNumber)||location.lineNumber<0||!Number.isSafeInteger(location.columnNumber)||location.columnNumber<0)throw Error()
    if(Buffer.byteLength(JSON.stringify({scriptId:location.scriptId,lineNumber:location.lineNumber,columnNumber:location.columnNumber}))>512)throw Error()
    const script=scripts.get(location.scriptId)
    const candidates=assets.filter(asset=>asset.sha256===script?.hash&&asset.length===script.length)
    if(overflow||candidates.length!==1)throw Error()
    const asset=candidates[0], line=location.lineNumber, column=location.columnNumber
    if(line>=asset.lines.length||column>asset.lines[line])throw Error()
    result={kind:'rendererAsset',sha256:asset.sha256,line,column}
   }catch{ /* A refusal is unknown, never a guessed origin. */ }
   results.push(result)
  }
 }catch{failure=true}
 finally {
  try{await cdp.send('Runtime.releaseObjectGroup',{objectGroup:group},2000)}catch{failure=true}
  try{await cdp.send('Debugger.disable',{},2000)}catch{failure=true}
  try{unsubscribe()}catch{failure=true}
 }
 return failure||overflow?{status:'unavailable'}:{status:'ok',locations:results}
}
