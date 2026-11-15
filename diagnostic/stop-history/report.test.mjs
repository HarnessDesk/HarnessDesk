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
