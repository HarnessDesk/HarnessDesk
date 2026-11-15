import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeReport } from './report.mjs'
test('result reporter emits only allowlisted fields and requires successful exit',()=>{
 assert.deepEqual(sanitizeReport('{"phase":"passed","passed":true,"secret":"x"}',0),{outcome:'passed',phase:'passed'})
 assert.equal(sanitizeReport('{"phase":"passed","passed":true}',1).outcome,'failed')
 assert.deepEqual(sanitizeReport('{"phase":"failed","checks":{"review":true,"private":"secret"}}',1),{outcome:'failed',phase:'failed',checks:{review:true}})
 const unsafe=sanitizeReport('{"phase":"../../secret","reason":"secret","failurePhase":"secret"}',1)
 assert.deepEqual(unsafe,{outcome:'failed',phase:'failed'});assert.equal(JSON.stringify(unsafe).includes('secret'),false)
 assert.deepEqual(sanitizeReport('stack containing secret',1),{outcome:'unavailable'})
})
test('readiness report preserves only bounded numeric fields for fixed checkpoints',()=>{
 const input=JSON.stringify({phase:'failed',failurePhase:'review_target',reason:'readiness_timeout',readiness:{review_target:{attempts:5,matches:1,eligible:1,inViewport:0,hits:0,scrolls:5,point:{x:12,y:34},secret:'sentinel'},unknown:{matches:1}}})
 assert.deepEqual(sanitizeReport(input,1),{outcome:'failed',phase:'failed',failurePhase:'review_target',reason:'readiness_timeout',readiness:{review_target:{attempts:5,matches:1,eligible:1,inViewport:0,hits:0,scrolls:5}}})
 const bad=JSON.stringify({phase:'failed',readiness:{review_target:{attempts:-1,matches:1001,eligible:'1',inViewport:0,hits:0,scrolls:0}}})
 assert.equal(JSON.stringify(sanitizeReport(bad,1)).includes('readiness'),false)
})
test('frame reports expose only bounded fixed failure categories',()=>{
 const raw=JSON.stringify({phase:'failed',frameReasons:['privacy_refused','secret-sentinel','frame_invalid','frame_unavailable','privacy_refused','privacy_refused'],checks:{flowCancel:true,flowManualCleanup:true}})
 const result=sanitizeReport(raw,1)
 assert.deepEqual(result.frameReasons,['privacy_refused','frame_invalid','frame_unavailable','privacy_refused'])
 assert.deepEqual(result.checks,{flowCancel:true,flowManualCleanup:true})
 assert.equal(JSON.stringify(result).includes('secret-sentinel'),false)
})
test('visibility reporting permits only bounded numeric counts and fixed checkpoints',()=>{
 const fields={dialogs:1,teamRows:1,actionButtons:1,zeroRect:1,hiddenStyle:0,inert:0,ariaHidden:1,secret:'never-output'}
 const out=sanitizeReport(JSON.stringify({phase:'failed',failurePhase:'flow_close_history',checks:{flowHistoryClosed:true},visibility:{beforeClose:fields,afterClose:{...fields,dialogs:0},unapproved:fields}}),1)
 assert.deepEqual(out.visibility.beforeClose,{dialogs:1,teamRows:1,actionButtons:1,zeroRect:1,hiddenStyle:0,inert:0,ariaHidden:1})
 assert.equal(out.visibility.afterClose.dialogs,0)
 assert.equal(out.checks.flowHistoryClosed,true)
 assert.equal(JSON.stringify(out).includes('never-output'),false)
 const bad=sanitizeReport(JSON.stringify({phase:'failed',visibility:{beforeClose:{...fields,dialogs:101}}}),1)
 assert.equal('visibility' in bad,false)
})
test('restart phases are reported without exposing untrusted details',()=>{
 const phases=['restart_launch','restart_listeners','restart_store','restart_workspace','restart_history_open','restart_history_wait','restart_ledger','restart_history_show','restart_verify','restart_effects','restart_final_listeners']
 for(const phase of phases) {
  const out=sanitizeReport(JSON.stringify({phase:'failed',failurePhase:phase,reason:'other',error:'private-sentinel'}),1)
  assert.deepEqual(out,{outcome:'failed',phase:'failed',failurePhase:phase,reason:'other'})
 }
 assert.deepEqual(sanitizeReport(JSON.stringify({phase:'failed',failurePhase:'restart_private-sentinel'}),1),{outcome:'failed',phase:'failed'})
})
test('guarded restart failures retain the current phase through cleanup and sanitization', async()=>{
 const {runGuarded}=await import('./run-guarded.mjs')
 for(const phase of ['restart_launch','restart_listeners','restart_store','restart_workspace','restart_history_open','restart_history_wait','restart_ledger','restart_history_show','restart_verify','restart_effects','restart_final_listeners']) {
  const result={phase};let cleaned=false
  await runGuarded(result,async()=>{throw new Error('private-sentinel')},async()=>{cleaned=true})
  assert.equal(cleaned,true)
  assert.deepEqual(sanitizeReport(JSON.stringify(result),1),{outcome:'failed',phase:'failed',failurePhase:phase,reason:'other'})
 }
})
