import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const phases=new Set(['preflight','setup','launch','recovery','review','restart','frames','passed','failed'])
const reasons=new Set(['not_authorized','pin_invalid','environment_refused','source_mismatch','ambient_refused','privacy_refused','frame_invalid','ledger_invalid','effect_observed','transport_unavailable','readiness_timeout','frame_unavailable','other'])
export function sanitizeReport(text, exit) {
  let record
  try { record=JSON.parse(text.trim().split('\n').at(-1)) } catch { return { outcome:'unavailable' } }
  const phase=phases.has(record?.phase)?record.phase:'failed'
  const failurePhase=phases.has(record?.failurePhase)?record.failurePhase:undefined
  const reason=reasons.has(record?.reason)?record.reason:undefined
  const passed=exit===0 && record?.passed===true && phase==='passed' && !record.cleanupError
  const checks={}
  for(const key of ['recovery','review','persisted','noObservedEffects'])if(record?.checks?.[key]===true)checks[key]=true
  return {outcome:passed?'passed':'failed',phase,...(Object.keys(checks).length?{checks}:{}),...(failurePhase?{failurePhase}:{}),...(reason?{reason}:{}),...(record?.cleanupError===true?{cleanupError:true}:{})}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const [file,rawExit]=process.argv.slice(2);let report={outcome:'unavailable'}
 try { if(statSync(file).size<=65536)report=sanitizeReport(readFileSync(file,'utf8'),Number(rawExit)) } catch {}
 process.stdout.write(JSON.stringify(report)+'\n')
 if(report.outcome!=='passed')process.exitCode=1
}
