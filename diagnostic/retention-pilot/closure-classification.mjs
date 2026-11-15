import { writeFileSync, lstatSync } from 'node:fs'

const validIds=ids=>Array.isArray(ids)&&ids.length<=16&&ids.every(id=>typeof id==='string'&&/^[1-9][0-9]{0,19}$/.test(id))&&new Set(ids).size===ids.length
export function writeClosureIds(path,ids) {
 const unique=[...new Set(ids)]
 if(!validIds(unique))throw Error('invalid closure IDs')
 writeFileSync(path,JSON.stringify(unique),{flag:'wx',mode:0o600})
 if(lstatSync(path).nlink!==1)throw Error('unexpected hard links')
}
// Evaluated inside the renderer: only fixed booleans cross the CDP boundary.
export function closureRoleFlags() {
 try {
  if(typeof this!=='function')return null
  const source=Function.prototype.toString.call(this)
  if(source.length>65536||new TextEncoder().encode(source).byteLength>65536)return null
  const has=x=>source.includes(x)
  return {shortcut:['new-team','nav-back','close-pane','new-session'].every(has),settings:has('settingsFor')&&has('askSettings'),seatFix:has('seatFix')&&has('askSeatFix'),navigation:has('navigation')&&has('current'),preserveDraft:has('preserveDraft')}
 }catch{return null}
}
export async function classifyClosures(cdp,ids) {
 if(!validIds(ids))return {status:'unavailable'}
 const roles={shortcut:0,settings:0,seatFix:0,navigation:0,preserveDraft:0,other:0}
 let unavailable=0,failedRelease=false
 const group='hd1545-closures'
 try {
  for(const id of ids){
   try {
    const remote=await cdp.send('HeapProfiler.getObjectByHeapObjectId',{objectId:id,objectGroup:group},2000)
    if(remote?.result?.type!=='function'||typeof remote.result.objectId!=='string')throw Error()
    const classified=await cdp.send('Runtime.callFunctionOn',{objectId:remote.result.objectId,functionDeclaration:closureRoleFlags.toString(),returnByValue:true,silent:true},2000)
    const flags=classified?.result?.value, names=['shortcut','settings','seatFix','navigation','preserveDraft']
    if(classified?.exceptionDetails||!flags||names.some(name=>typeof flags[name]!=='boolean'))throw Error()
    let any=false;for(const name of names)if(flags[name]){roles[name]++;any=true}if(!any)roles.other++
   }catch{unavailable++}
  }
 }finally {try{await cdp.send('Runtime.releaseObjectGroup',{objectGroup:group},2000)}catch{failedRelease=true}}
 return failedRelease?{status:'unavailable'}:{status:'ok',uniqueClosureCount:ids.length,unavailable,roles}
}
