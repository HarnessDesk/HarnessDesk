import { stageRecord } from './profile-stage.mjs'

const rpcFields=['started','completed','nulls','rejected','active','maxDurationMs','sumDurationMs','oldestAgeMs','oldestOrdinal','trackingOverflow']
const sanitizeRpc = value => {
 const out={}
 for(const name of ['cacheSnapshot','prepareEviction']) {
  const bucket=value?.[name];if(!bucket||typeof bucket!=='object')continue
  const clean={}
  for(const key of rpcFields){const item=bucket[key];if(typeof item==='boolean'||(typeof item==='number'&&Number.isFinite(item))||(key==='oldestAgeMs'&&item===null))clean[key]=item}
  out[name]=clean
 }
 return out
}
export const captureFailure = async (phase,readState,readRpc) => {
 const match=/^checkpoint-(0|128|200|400)$/.exec(phase)
 const result={checkpoint:match?Number(match[1]):null}
 if(match){try{result.endState=stageRecord('quiescence',await readState()).state}catch{result.endState={stateUnavailable:true}}}
 try{result.rpcEnd=sanitizeRpc(await readRpc())}catch{result.rpcEndUnavailable=true}
 return result
}
