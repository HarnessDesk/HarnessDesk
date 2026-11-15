import { readFileSync, statSync } from 'node:fs'
import { analyzeHeap } from './heap-observation.mjs'
import { writeClosureIds } from './closure-classification.mjs'
try {
 const [snapshotPath,keysPath,closurePath]=process.argv.slice(2)
 if(statSync(snapshotPath).size>256*1024*1024||statSync(keysPath).size>128*1024)throw Error()
 const expected=JSON.parse(readFileSync(keysPath,'utf8'))
 if(!Array.isArray(expected)||expected.length!==400||expected.some(x=>typeof x.needle!=='string'||!/^[a-f0-9]{256}$/.test(x.needle)||typeof x.loaded!=='boolean')||new Set(expected.map(x=>x.needle)).size!==expected.length)throw Error()
 const ids=new Set()
 const result=analyzeHeap(JSON.parse(readFileSync(snapshotPath,'utf8')),expected,id=>{if(ids.size<16)ids.add(id)})
 if(result.status!=='ok')throw Error()
 writeClosureIds(closurePath,[...ids])
 const {strongPaths,...safeResult}=result
 console.log(JSON.stringify(safeResult))
}catch{console.log('{"status":"unavailable"}')}
