import { checkListeners } from './listener-guard.mjs'

/** Retry only an evidenced vanished-PID lsof race; partial output never authorizes a pass. */
export function probeListeners({scan,lsof,phonePort,appPort,diagnostic}) {
  const getOwned=()=>{
    let snapshot
    try {snapshot=scan()} catch(error){diagnostic.failure='ps_failed';diagnostic.exit=Number.isInteger(error.status)?error.status:null;throw error}
    diagnostic.ownedProcesses=snapshot.owned.size
    if(!snapshot.owned.size){diagnostic.failure='no_owned_processes';throw Error('ownership')}
    return snapshot
  }
  const codes=['foreign_owner','unexpected_nonloopback','no_listeners','phone_listener_count','app_listener_missing','wrong_phone_owner']
  const validate=(raw,owned)=>{
    try {return checkListeners(raw,owned,phonePort,appPort)}
    catch(error){diagnostic.failure=codes.includes(error.code)?error.code:'guard_failed';if(error.counts)diagnostic.counts=error.counts;throw error}
  }
  let snapshot=getOwned(), owned=snapshot.owned, raw
  diagnostic.attempts=1
  try {raw=lsof(owned);diagnostic.exit=0}
  catch(error){
    diagnostic.failure='lsof_failed';diagnostic.exit=Number.isInteger(error.status)?error.status:null;diagnostic.signaled=!!error.signal
    diagnostic.firstExit=diagnostic.exit;diagnostic.firstSignaled=diagnostic.signaled
    let valid=false
    if(typeof error.stdout==='string' && error.stdout) {
      try {checkListeners(error.stdout,owned,phonePort,appPort);valid=true}
      catch(partial){if(partial.counts)diagnostic.counts=partial.counts}
    }
    diagnostic.partialValid=valid
    if(error.status!==1||error.signal||!valid)throw error
    const fresh=getOwned()
    const departed=[...owned].filter(pid=>!fresh.live.has(pid)).length
    diagnostic.departedProcesses=departed
    if(!departed){diagnostic.failure='lsof_failed_no_departure';throw error}
    owned=fresh.owned;diagnostic.attempts=2
    try {raw=lsof(owned);diagnostic.exit=0}
    catch(second){diagnostic.failure='lsof_retry_failed';diagnostic.exit=Number.isInteger(second.status)?second.status:null;diagnostic.signaled=!!second.signal;throw second}
  }
  const result=validate(raw,owned);diagnostic.failure=null;return result
}
