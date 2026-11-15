import test from 'node:test'
import assert from 'node:assert/strict'
import { runGuarded } from './run-guarded.mjs'

test('source failure keeps fixed reason, always cleans and never leaks raw errors',async()=>{
 const result={phase:'preflight'},calls=[]
 const ok=await runGuarded(result,async()=>{calls.push('body');throw Error('source base mismatch')},async()=>{calls.push('cleanup')})
 assert.equal(ok,false);assert.deepEqual(calls,['body','cleanup']);assert.deepEqual(result,{phase:'failed',failurePhase:'preflight',reason:'source_mismatch',passed:false})
 const other={phase:'launch'};await runGuarded(other,async()=>{throw Error('secret sentinel path')},async()=>{})
 assert.equal(other.reason,'other');assert.equal(JSON.stringify(other).includes('secret sentinel'),false)
})
test('cleanup failure cannot become a passing result and preserves prior failure',async()=>{
 const good={phase:'prepared'};assert.equal(await runGuarded(good,async()=>{good.phase='passed'},async()=>{}),true);assert.deepEqual(good,{phase:'passed',passed:true})
 const cleanup={phase:'passed'};assert.equal(await runGuarded(cleanup,async()=>{},async()=>{throw Error('untrusted')}),false);assert.equal(cleanup.cleanupError,true);assert.equal(cleanup.passed,false)
 const both={phase:'review'};await runGuarded(both,async()=>{throw Error('unexpected review effect')},async()=>{throw Error('untrusted')});assert.equal(both.failurePhase,'review');assert.equal(both.reason,'effect_observed');assert.equal(both.cleanupError,true)
})
