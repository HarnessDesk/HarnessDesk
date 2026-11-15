// Observed wire floors only: these are not the AppStore's private cursor.
// No identifiers, watermarks or bodies are returned by end().
export const createNotificationObserver = (known, limit=1024) => {
 const floors=new Map();let revision=0, overflow=false, counts=null
 const valid=f=>!!f&&typeof f==='object'&&typeof f.epoch==='string'&&!!f.epoch&&typeof f.generation==='string'&&!!f.generation&&Number.isSafeInteger(f.revision)&&f.revision>=0&&Number.isSafeInteger(f.sequence)&&f.sequence>=0
 const key=p=>typeof p?.runtime==='string'&&!!p.runtime&&typeof p?.sessionId==='string'&&!!p.sessionId?JSON.stringify([p.runtime,p.sessionId]):null
 const version=()=>revision
 const reset=()=>{revision++;floors.clear();overflow=false}
 const snapshotResult=(params,result,at=revision)=>{
  const k=key(params),f=result?.watermark
  if(!k)return
  if(at!==revision||!valid(f)||result?.session?.runtime!==params.runtime||result?.session?.id!==params.sessionId){floors.delete(k);return}
  const old=floors.get(k)
  if(old&&(old.epoch!==f.epoch||old.generation!==f.generation||f.sequence<old.sequence||f.revision<old.revision||(f.sequence===old.sequence&&f.revision!==old.revision))){floors.delete(k);return}
  if(!old&&floors.size>=limit){overflow=true;return}
  floors.set(k,{epoch:f.epoch,generation:f.generation,revision:f.revision,sequence:f.sequence})
 }
 const notification=n=>{
  if(n?.method!=='session/cache-invalidated')return
  revision++;const params=n.params,k=key(params),f=params?.watermark
  let isKnown=false;try{isKnown=!!k&&known(params.runtime,params.sessionId)}catch{}
  const old=k?floors.get(k):null
  let classification
  if(!k||!valid(f))classification='malformed'
  else if(!old)classification='noFloor'
  else if(f.epoch===old.epoch&&f.generation===old.generation&&f.sequence===old.sequence+1&&f.revision>=old.revision)classification='contiguous'
  else classification='ambiguous'
  if(k&&old){if(classification==='contiguous')floors.set(k,{epoch:f.epoch,generation:f.generation,revision:f.revision,sequence:f.sequence});else floors.delete(k)}
  if(counts){counts.total++;counts[isKnown?'known':'unknown']++;counts[classification]++;if(classification==='contiguous')counts[isKnown?'knownContiguous':'unknownContiguous']++;if(overflow)counts.overflow=1}
 }
 const begin=()=>{counts={total:0,known:0,unknown:0,contiguous:0,knownContiguous:0,unknownContiguous:0,ambiguous:0,noFloor:0,malformed:0,overflow:overflow?1:0}}
 const end=()=>{const result=counts;counts=null;return result}
 return {version,reset,snapshotResult,notification,begin,end}
}

// This diagnostic only observes calls; it returns the original promise and
// forwards each handler exactly once, even if the observer cannot classify it.
export const installNotificationObserver = (transport, observer) => {
 const handlers=transport.handlers, originalNotification=handlers.onNotification, originalStatus=handlers.onStatus, originalEvent=handlers.onEvent, originalRequest=transport.request
 handlers.onNotification=function(message){try{if(message?.method==='sync'||message?.method==='session/removed'||message?.method==='runtime/removed')observer.reset();else observer.notification(message)}catch{}return Reflect.apply(originalNotification,this,[message])}
 handlers.onStatus=function(status){try{if(status!=='open')observer.reset()}catch{}return Reflect.apply(originalStatus,this,[status])}
 if(typeof originalEvent==='function')handlers.onEvent=function(...args){try{observer.reset()}catch{}return Reflect.apply(originalEvent,this,args)}
 transport.request=function(method,params,...rest){
  let version;try{if(method==='session/cache-snapshot')version=observer.version()}catch{}
  const answer=Reflect.apply(originalRequest,this,[method,params,...rest])
  if(method==='session/cache-snapshot'&&version!==undefined)Promise.resolve(answer).then(result=>{try{observer.snapshotResult(params,result,version)}catch{}},()=>{try{observer.snapshotResult(params,null,version)}catch{}})
  return answer
 }
}

export const sanitizeWaitObservation = value => {
 const result={},notificationFields=['total','known','unknown','contiguous','knownContiguous','unknownContiguous','ambiguous','noFloor','malformed','overflow'],rpcFields=['started','completed','nulls','rejected','activeAtStart','activeAtEnd']
 const pick=(input,keys)=>Object.fromEntries(keys.flatMap(key=>Number.isSafeInteger(input?.[key])&&input[key]>=0?[[key,input[key]]]:[]))
 if(value?.notifications&&typeof value.notifications==='object')result.notifications=pick(value.notifications,notificationFields)
 if(value?.rpc&&typeof value.rpc==='object')result.rpc=Object.fromEntries(['cacheSnapshot','prepareEviction'].filter(key=>value.rpc[key]&&typeof value.rpc[key]==='object').map(key=>[key,pick(value.rpc[key],rpcFields)]))
 return result
}
