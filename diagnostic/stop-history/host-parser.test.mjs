import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { makeLedger } from './seed.mjs'

const modulePath=process.env.HD_2065_PINNED_MENTIONS
if (!modulePath) throw new Error('pinned compiled Host mentions module required')
const { MentionTriage }=await import(pathToFileURL(modulePath).href)

test('pinned Host strict parser accepts fixture, recovers, reviews and persists without work effects', async()=>{
 const home=await mkdtemp(join(tmpdir(),'hd2065-parser-'))
 try {
  const file=join(home,'triggers-mentions.json'),project=join(home,'project'),seed=makeLedger(project),changes=[]
  await writeFile(file,JSON.stringify(seed))
  const mention=new MentionTriage({home,pendingFirings:()=>[],changed: p=>changes.push(p)})
  const before=await mention.retainedStops(project,[])
  assert.equal(mention.problem,null);assert.equal(before.retainedStopTriggers.length,1)
  assert.deepEqual(before.retainedStopTriggers[0].unconfirmedStops.map(x=>x.state).sort(),['reviewed','unconfirmed','unconfirmed'])
  const recovered=JSON.parse(await readFile(file,'utf8'));assert.equal(recovered.stopIntents[0].state,'unconfirmed');assert.deepEqual(changes,[project])
  const reviewed=await mention.reviewStop(project,'fixture-trigger',seed.stopIntents[0].id);assert.equal(reviewed.state,'reviewed')
  const disk=JSON.parse(await readFile(file,'utf8'));assert.equal(disk.stopIntents[0].state,'reviewed')
  const reopened=new MentionTriage({home,pendingFirings:()=>[],changed:()=>{throw Error('unexpected change on read')}})
  const rows=(await reopened.retainedStops(project,[])).retainedStopTriggers[0].unconfirmedStops
  assert.equal(rows.find(x=>x.id===seed.stopIntents[0].id).state,'reviewed')
 } finally {await rm(home,{recursive:true,force:true})}
})

test('pinned Host rejects malformed protected identities and preserves original bytes',async()=>{
 const cases=[
  seed=>{seed.stopIntents[0].bodyDigest='invalid'},
  seed=>{seed.stopIntents[0].unexpected=true},
  seed=>{seed.stopIntents[0].key.unexpected=true},
  seed=>{seed.stopIntents[0].id='u-'+ '0'.repeat(64)},
  seed=>{seed.stopIntents[0].createdAt=-1},
  seed=>{seed.stopIntents[0].thread.number=0},
  seed=>{seed.stopIntents[0].thread.kind='discussion'},
  seed=>{seed.stopIntents[0].state='invalid'},
  seed=>{seed.stopIntents[0].url='https://example.invalid/fixture/issues/101#issuecomment-999'},
  seed=>{seed.stopIntents[0].key.repository='Example.Invalid/fixture'},
  seed=>{seed.version=1},
  seed=>{seed.stopIntents.push(seed.stopIntents[0])},
 ]
 for(const mutate of cases) {
  const home=await mkdtemp(join(tmpdir(),'hd2065-parser-'))
  try {
   const file=join(home,'triggers-mentions.json'),project=join(home,'project'),seed=makeLedger(project)
   mutate(seed);const input=JSON.stringify(seed);await writeFile(file,input)
   const mention=new MentionTriage({home,changed:()=>{throw Error('unexpected change')}})
   await assert.rejects(()=>mention.retainedStops(project,[]));assert.equal(await readFile(file,'utf8'),input)
  } finally {await rm(home,{recursive:true,force:true})}
 }
})
