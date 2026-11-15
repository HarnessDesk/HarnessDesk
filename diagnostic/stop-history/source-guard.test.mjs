import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSource } from './source-guard.mjs'
const base='a'.repeat(40),expected={'example/file':'b'.repeat(64)}
const check=(over={})=>assertSource({base,expected,sha:()=>expected['example/file'],git:(...args)=>args[0]==='merge-base'?base:'',...over})
test('source guard requires exact ancestor, clean production diff and matching fingerprints',()=>{
 assert.doesNotThrow(()=>check())
 assert.throws(()=>check({base:'bad'}),/final source pin missing/)
 assert.throws(()=>check({git:(...a)=>a[0]==='merge-base'?'c'.repeat(40):''}),/source base mismatch/)
 assert.throws(()=>check({git:(...a)=>a[0]==='merge-base'?base:'changed'}),/production source or checkout changed/)
 assert.throws(()=>check({sha:()=> 'bad'}),/source fingerprint mismatch/)
})
