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
