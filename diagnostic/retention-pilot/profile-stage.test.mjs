import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageRecord } from './profile-stage.mjs'
test('400-stage diagnostics retain only allowlisted scalar fields', () => {
 const record=stageRecord('restore-immediate',{loaded:131,pressureRunning:false,visibleMounted:true,body:'secret',sessionId:'secret',bad:{x:1}})
 assert.deepEqual(record,{stage:'restore-immediate',state:{loaded:131,pressureRunning:false,visibleMounted:true}})
 assert.throws(()=>stageRecord('raw secret',{}),/stage/)
 assert.deepEqual(stageRecord('heap',{loaded:Infinity,visibleMounted:'secret'}),{stage:'heap',state:{}})
})
