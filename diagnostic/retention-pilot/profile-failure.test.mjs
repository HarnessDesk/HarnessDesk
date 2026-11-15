import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureFailure } from './profile-failure.mjs'

test('checkpoint 200 deadline captures sanitized end state and proof metrics', async () => {
 const rpc={cacheSnapshot:{started:12,completed:8,active:4},prepareEviction:{started:9,completed:9,active:0}}
 const value=await captureFailure('checkpoint-200',async()=>({loaded:140,pressureRunning:true,body:'private'}),async()=>rpc)
 assert.deepEqual(value,{checkpoint:200,endState:{loaded:140,pressureRunning:true},rpcEnd:rpc})
 assert.doesNotMatch(JSON.stringify(value),/private/)
})
test('400 and non-checkpoint failures retain rpc data with safe fallbacks', async () => {
 const broken=async()=>{throw Error('private')}
 assert.deepEqual(await captureFailure('checkpoint-400',broken,broken),{checkpoint:400,endState:{stateUnavailable:true},rpcEndUnavailable:true})
 assert.deepEqual(await captureFailure('workload-200',broken,async()=>({cacheSnapshot:{active:1}})),{checkpoint:null,rpcEnd:{cacheSnapshot:{active:1}}})
})
test('a real caught 200 deadline records its code without exposing errors', async () => {
 const {classifyProfileError}=await import('./profile-rpc-observer.mjs')
 const result={phase:'checkpoint-200',diagnostic:{stage:'prior'}}
 try {throw new Error('quiescent pressure: readiness deadline')}
 catch(error) {
  result.errorCode=classifyProfileError(error)
  Object.assign(result,await captureFailure(result.phase,async()=>({pressureRunning:true,secret:'hidden'}),async()=>({cacheSnapshot:{active:1,oldestAgeMs:30000,sessionId:'hidden'}})))
 }
 assert.deepEqual(result,{phase:'checkpoint-200',diagnostic:{stage:'prior'},errorCode:'quiescence-deadline',checkpoint:200,endState:{pressureRunning:true},rpcEnd:{cacheSnapshot:{active:1,oldestAgeMs:30000}}})
 assert.doesNotMatch(JSON.stringify(result),/hidden/)
})
