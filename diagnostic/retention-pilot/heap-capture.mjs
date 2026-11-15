import { stableProtected } from './heap-observation.mjs'
// This helper has no reference to the original acceptance result.
export async function captureLateHeap({read,drain,collect,snapshot,analyze}) {
 try {
  await drain();const first=await read();await drain()
  await collect();const after=await read();await drain()
  if(!stableProtected(first,after))return {status:'state-changed'}
  const before=await read();await drain()
  if(!stableProtected(after,before))return {status:'state-changed'}
  await snapshot();const end=await read();await drain()
  if(!stableProtected(before,end))return {status:'state-changed'}
  return await analyze()
 }catch{return {status:'unavailable'}}
}
