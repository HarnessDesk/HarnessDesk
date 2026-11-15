import { readFileSync, statSync } from 'node:fs'
import { analyzeHeap } from './heap-observation.mjs'
try {
 const [snapshotPath,keysPath]=process.argv.slice(2)
 if(statSync(snapshotPath).size>256*1024*1024||statSync(keysPath).size>128*1024)throw Error()
 const expected=JSON.parse(readFileSync(keysPath,'utf8'))
 if(!Array.isArray(expected)||expected.length!==400||expected.some(x=>typeof x.needle!=='string'||!/^[a-f0-9]{64}$/.test(x.needle)||typeof x.loaded!=='boolean')||new Set(expected.map(x=>x.needle)).size!==expected.length)throw Error()
 const result=analyzeHeap(JSON.parse(readFileSync(snapshotPath,'utf8')),expected)
 console.log(JSON.stringify(result))
}catch{console.log('{"status":"unavailable"}')}
