import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureSafely, exerciseProtectedFlow } from './flow-proof.mjs'

const fixture = ({ cancelEffect = false, retainMarker = false } = {}) => {
  let count=0, marked=true, frames=0
  const calls=[]
  const cdp={
    json: async () => ({ stopped:true, canStop:marked, absent:!marked }),
    eval: async expression => expression === 'window.__hdFlowStopCount' ? count : true,
  }
  const click=async (selector,label) => {
    calls.push(label)
    if(label==='Close' && cancelEffect) count++
    if(label==='Stop run') { count++; if(!retainMarker)marked=false }
  }
  const flow={ run:'synthetic', read:()=>({id:'synthetic',state:'stopped',version:2,...(marked?{mentionStopOnce:'u-'+ '1'.repeat(64)}:{})}) }
  const waitFor=async (_label,fn)=>{if(!(await fn()))throw Error('control readiness failure')}
  const result={phase:'',checks:{}}
  return { args:{cdp,click,waitFor,result,flow,frame:async()=>{frames++;return {}}}, calls, result, frames:()=>frames }
}

test('manual cleanup is reached only after cancel is effect-free', async()=>{
  const f=fixture();await exerciseProtectedFlow(f.args)
  assert.deepEqual(f.result.checks,{flowCancel:true,flowManualCleanup:true})
  assert.equal(f.frames(),3)
  assert.ok(f.calls.indexOf('Close')<f.calls.indexOf('Stop run'))
})
test('a stop observed on cancel aborts before manual cleanup',async()=>{
  const f=fixture({cancelEffect:true});await assert.rejects(exerciseProtectedFlow(f.args),/cancel had an effect/)
  assert.equal(f.calls.includes('Stop run'),false)
  assert.equal(f.result.checks.flowManualCleanup,undefined)
})
test('an uncleared durable marker cannot pass the cleanup check',async()=>{
  const f=fixture({retainMarker:true});await assert.rejects(exerciseProtectedFlow(f.args),/control readiness failure/)
  assert.equal(f.result.checks.flowManualCleanup,undefined)
})

test('a privacy failure is classified without suppressing subsequent Flow control evidence',async()=>{
  const f=fixture(), capture=async()=>{throw Error('privacy audit failed')}
  f.args.frame=()=>captureSafely(capture,f.result)
  const frames=await exerciseProtectedFlow(f.args)
  assert.deepEqual(f.result.frameReasons,['privacy_refused','privacy_refused','privacy_refused'])
  assert.equal(f.result.checks.flowManualCleanup,true)
  assert.deepEqual(frames,{menuFrame:null,confirmFrame:null,stoppedFrame:null})
  assert.equal(JSON.stringify(f.result).includes('privacy audit failed'),false)
})
