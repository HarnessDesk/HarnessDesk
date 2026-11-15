// Per-promise state is bounded; overflow is counted, and oldest is unknown
// while any untracked request is in flight. No request params are retained.
export const createRpcObserver = (original, now = () => performance.now(), locate = () => undefined) => {
 const limit=512
 const fresh=()=>({started:0,completed:0,nulls:0,rejected:0,active:0,maxDurationMs:0,sumDurationMs:0,tracked:new Set(),overflow:0})
 const buckets={cacheSnapshot:fresh(),prepareEviction:fresh()}
 const request=function(method,params,...rest){
  const bucket=method==='session/cache-snapshot'?buckets.cacheSnapshot:method==='session/prepare-eviction'?buckets.prepareEviction:null
  if(!bucket)return Reflect.apply(original,this,[method,params,...rest])
  const start=now();let ref;try{ref=locate(params)}catch{}const entry={start,ref};bucket.started++;bucket.active++
  const tracked=bucket.tracked.size<limit
  if(tracked)bucket.tracked.add(entry);else bucket.overflow++
  let finished=false
  const finish=(kind,value)=>{if(finished)return;finished=true;bucket.active--;if(tracked)bucket.tracked.delete(entry);else bucket.overflow--;const duration=Math.max(0,now()-start);bucket.maxDurationMs=Math.max(bucket.maxDurationMs,duration);bucket.sumDurationMs=Math.min(Number.MAX_SAFE_INTEGER,bucket.sumDurationMs+duration);if(kind==='reject')bucket.rejected++;else{bucket.completed++;if(value===null)bucket.nulls++}}
  try{const answer=Reflect.apply(original,this,[method,params,...rest]);Promise.resolve(answer).then(value=>finish('complete',value),()=>finish('reject'));return answer}
  catch(error){finish('reject');throw error}
 }
 const snapshot=(ordinalOf=()=>-1)=>{
  const read=bucket=>{
   let oldest
   for(const entry of bucket.tracked)if(!oldest||entry.start<oldest.start)oldest=entry
   let ordinal=-1;if(!bucket.overflow&&oldest){try{const value=ordinalOf(oldest.ref);if(Number.isSafeInteger(value)&&value>0)ordinal=value}catch{}}
   return {started:bucket.started,completed:bucket.completed,nulls:bucket.nulls,rejected:bucket.rejected,active:bucket.active,maxDurationMs:bucket.maxDurationMs,sumDurationMs:bucket.sumDurationMs,oldestAgeMs:bucket.overflow||!oldest?null:Math.max(0,now()-oldest.start),oldestOrdinal:ordinal,trackingOverflow:bucket.overflow>0}
  }
  return {cacheSnapshot:read(buckets.cacheSnapshot),prepareEviction:read(buckets.prepareEviction)}
 }
 return {request,snapshot}
}

export const classifyProfileError = error => {
 if(!(error instanceof Error))return 'unclassified'
 const known={
  'quiescent pressure: readiness deadline':'quiescence-deadline',
  'automatic release after restore: readiness deadline':'automatic-release-deadline',
  'pending sentinel did not survive navigation':'pending-sentinel',
  'Error: sentinel protection missing':'sentinel-protection',
  'Error: sentinel not loaded':'sentinel-unloaded',
  'Error: visible sentinel lost':'visible-sentinel',
  'persistent sentinel protection lost':'persistent-sentinel',
  'unresolved recovery record':'recovery-record',
  'representative receipt mismatch':'receipt-mismatch',
  'restore did not preserve mounted sentinel':'restore-mismatch',
  'post-restore not quiescent':'post-restore-unstable',
 }
 const first=error.message.split('\n',1)[0]
 return Object.hasOwn(known,first)?known[first]:'unclassified'
}
