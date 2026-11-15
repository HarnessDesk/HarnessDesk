import { stableProtected } from './heap-observation.mjs'
// This helper has no reference to the original acceptance result.
export async function captureLateHeap({read,drain,collect,snapshot,analyze,verifyAfterAnalysis=false}) {
 try {
  await drain();const first=await read();await drain()
  await collect();const after=await read();await drain()
  if(!stableProtected(first,after))return {status:'state-changed'}
  const before=await read();await drain()
  if(!stableProtected(after,before))return {status:'state-changed'}
  await snapshot();const end=await read();await drain()
  if(!stableProtected(before,end))return {status:'state-changed'}
  const result=await analyze()
  if(verifyAfterAnalysis){const post=await read();await drain();if(!stableProtected(end,post))return {status:'state-changed'}}
  return result
 }catch{return {status:'unavailable'}}
}

// Track only releases emitted by this diagnostic's Cdp instance. The product
// helper remains untouched; the diagnostic waits before snapshotting.
export const installHeldTracker = (client,timeoutMs=2000) => {
 const original=client.send.bind(client), pendingGroups=new Set();let failed=false
 client.send=(method,params,timeout)=>{
  const call=original(method,params,timeout)
  if(method==='Runtime.releaseObjectGroup'){
   pendingGroups.add(call);call.then(()=>pendingGroups.delete(call),()=>{pendingGroups.delete(call);failed=true})
  }
  return call
 }
 return async()=>{
  let timer
  try {await Promise.race([Promise.all([...pendingGroups]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('release timeout')),timeoutMs)})])}
  finally {clearTimeout(timer)}
  if(failed||pendingGroups.size)throw new Error('release unavailable')
 }
}

export const writeSnapshotChunk=(chunk,write)=>{
 try {return write(chunk)===Buffer.byteLength(chunk)}catch{return false}
}
