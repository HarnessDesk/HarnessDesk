import { stageRecord } from './profile-stage.mjs'

const METRICS=['ScriptDuration','TaskDuration','LayoutDuration','RecalcStyleDuration']
const finite=(value,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max
/** Report only bounded, monotonic deltas for the four named renderer counters. */
export const captureMetricDeltas=(start,end)=>{
 const find=(input,name)=>input?.metrics?.find(one=>one?.name===name)?.value
 const out={}
 for(const name of METRICS){const a=find(start,name),b=find(end,name);if(finite(a,1e9)&&finite(b,1e9)&&finite(b-a,86400))out[name]=b-a}
 return out
}
const protectedState=s=>s.visibleMounted===true&&s.visibleLoaded===true&&s.draftPresent===true&&s.draftLoaded===true&&s.pendingPresent===true&&s.pendingLoaded===true&&s.pendingActive===true&&s.pendingMounted===false&&s.pendingCloseSent===0&&s.pendingCloseResolved===0&&s.pendingCloseRejected===0&&s.knownMissing===0
const quiet=s=>s.enabled===true&&s.pressureRunning===false&&s.pressureDirty===false
/** Supplemental observation only; accepts no result/checkpoint object and cannot turn a failure into a pass. */
export async function observeLateFailure({read,collect,heap,now,sleep}) {
 const start=now(),deadline=start+60000
 let samples=0,previous=null,lastProtected=null
 const result=(outcome,extra={})=>({outcome,elapsedMs:Math.min(60000,Math.max(0,Math.round(now()-start))),samples,quiescent:outcome==='quiescent',protection:lastProtected,...extra})
 while(now()<deadline) {
  let state
  try {state=stageRecord('quiescence',await read(Math.min(2000,Math.max(1,deadline-now())))).state}
  catch {return result('unavailable')}
  samples++
  lastProtected=protectedState(state)
  if(!lastProtected)return result('protection-lost')
  if(quiet(state)&&previous!==null&&JSON.stringify(previous)===JSON.stringify(state)) {
   if(now()>=deadline)return result('timeout')
   try {
    await collect(Math.min(2000,Math.max(1,deadline-now())))
    if(now()>=deadline)return result('quiescent',{heapUnavailable:true})
    const value=await heap(Math.min(2000,Math.max(1,deadline-now())))
    if(!finite(value?.usedSize,Number.MAX_SAFE_INTEGER))return result('quiescent',{heapUnavailable:true})
    return result('quiescent',{heap:{usedBytes:value.usedSize,backingBytes:finite(value.backingStorageSize,Number.MAX_SAFE_INTEGER)?value.backingStorageSize:null}})
   } catch {return result('quiescent',{heapUnavailable:true})}
  }
  previous=state
  const remaining=deadline-now();if(remaining>0)await sleep(Math.min(1000,remaining))
 }
 return result('timeout')
}

/** Attach only supplemental results after the original failure and its snapshot are recorded. */
export async function recordLateFailure(result,options) {
 if(result.phase!=='checkpoint-400'||result.errorCode!=='quiescence-deadline')return
 try {result.lateObservation=await observeLateFailure(options)}
 catch {result.lateObservation={outcome:'unavailable'}}
}
