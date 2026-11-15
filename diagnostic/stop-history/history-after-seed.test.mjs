import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLedger } from './seed.mjs'
import { seedThenInstallHistory } from './history-after-seed.mjs'

test('the Host seeder sees no ledger and the in-flight fixture is installed only after it returns',async()=>{
 const root=mkdtempSync(join(tmpdir(),'hd-history-order-')),path=join(root,'ledger.json'),ledger=makeLedger(root)
 try {
  let completed=false
  const result=await seedThenInstallHistory({path,ledger,seed:async()=>{assert.equal(existsSync(path),false);completed=true;return 'flow'}})
  assert.equal(completed,true);assert.equal(result,'flow');assert.equal(JSON.parse(readFileSync(path,'utf8')).stopIntents[0].state,'inFlight')
 } finally {rmSync(root,{recursive:true,force:true})}
})
test('an existing or seeder-created ledger is never overwritten',async()=>{
 for(const initial of [true,false]) {
  const root=mkdtempSync(join(tmpdir(),'hd-history-order-')),path=join(root,'ledger.json'),ledger=makeLedger(root)
  try {
   if(initial)writeFileSync(path,'kept')
   let called=false
   await assert.rejects(seedThenInstallHistory({path,ledger,seed:async()=>{called=true;if(!initial)writeFileSync(path,'kept');return 'flow'}}),/history already exists/)
   assert.equal(readFileSync(path,'utf8'),'kept');assert.equal(called,!initial)
  } finally {rmSync(root,{recursive:true,force:true})}
 }
})
