import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const phases=new Set(['preflight','setup','launch','recovery','review','review_target','review_durable','restart','restart_launch','restart_listeners','restart_store','restart_workspace','restart_history_open','restart_history_wait','restart_ledger','restart_history_show','restart_verify','restart_effects','restart_final_listeners','flow_close_history','flow_team_menu','flow_run_view','flow_durable','frames','passed','failed'])
const reasons=new Set(['not_authorized','pin_invalid','environment_refused','source_mismatch','ambient_refused','privacy_refused','frame_invalid','ledger_invalid','effect_observed','transport_unavailable','readiness_timeout','frame_unavailable','other'])
export function sanitizeReport(text, exit) {
  let record
  try { record=JSON.parse(text.trim().split('\n').at(-1)) } catch { return { outcome:'unavailable' } }
  const phase=phases.has(record?.phase)?record.phase:'failed'
  const failurePhase=phases.has(record?.failurePhase)?record.failurePhase:undefined
  const reason=reasons.has(record?.reason)?record.reason:undefined
  const passed=exit===0 && record?.passed===true && phase==='passed' && !record.cleanupError
  const readiness={}
  const fields=['attempts','matches','eligible','inViewport','hits','scrolls']
  for(const checkpoint of ['review_target','flow_close_history','flow_team_menu','flow_team_stop','flow_cancel','flow_open_team','flow_open_run','flow_run_stop','flow_confirm']) {
    const item=record?.readiness?.[checkpoint]
    if(item && fields.every(key=>Number.isInteger(item[key]) && item[key]>=0 && item[key]<=1000))readiness[checkpoint]=Object.fromEntries(fields.map(key=>[key,item[key]]))
  }
  const checks={}
  for(const key of ['recovery','review','persisted','noObservedEffects','flowHistoryClosed','flowCancel','flowManualCleanup'])if(record?.checks?.[key]===true)checks[key]=true
  const visibility={}
  const visibilityFields=['dialogs','teamRows','actionButtons','zeroRect','hiddenStyle','inert','ariaHidden']
  for(const stage of ['beforeClose','afterClose']) { const v=record?.visibility?.[stage]; if(v && visibilityFields.every(key=>Number.isInteger(v[key]) && v[key]>=0 && v[key]<=100))visibility[stage]=Object.fromEntries(visibilityFields.map(key=>[key,v[key]])) }
  const frameReasons=Array.isArray(record?.frameReasons) ? record.frameReasons.slice(0,5).filter(one=>['privacy_refused','frame_invalid','frame_unavailable'].includes(one)) : []
  return {outcome:passed?'passed':'failed',phase,...(Object.keys(visibility).length?{visibility}:{}),...(frameReasons.length?{frameReasons}:{}),...(Object.keys(checks).length?{checks}:{}),...(Object.keys(readiness).length?{readiness}:{}),...(failurePhase?{failurePhase}:{}),...(reason?{reason}:{}),...(record?.cleanupError===true?{cleanupError:true}:{})}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const [file,rawExit]=process.argv.slice(2);let report={outcome:'unavailable'}
 try { if(statSync(file).size<=65536)report=sanitizeReport(readFileSync(file,'utf8'),Number(rawExit)) } catch {}
 process.stdout.write(JSON.stringify(report)+'\n')
 if(report.outcome!=='passed')process.exitCode=1
}
