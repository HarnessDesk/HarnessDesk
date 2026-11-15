import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectFrame } from './frame-policy.mjs'
function fakePng() {
  const b=Buffer.alloc(45); Buffer.from('89504e470d0a1a0a','hex').copy(b); b.writeUInt32BE(13,8);b.write('IHDR',12);b.writeUInt32BE(800,16);b.writeUInt32BE(600,20);Buffer.from('0000000049454e44ae426082','hex').copy(b,33);return b
}
test('frame gate fails closed on privacy, malformed, oversized or wrong dimensions',()=>{
  const png=fakePng();assert.equal(inspectFrame(png,[]).width,800)
  assert.throws(()=>inspectFrame(png,['blocked']));assert.throws(()=>inspectFrame(png,null));assert.throws(()=>inspectFrame(png.subarray(0,24),[]));assert.throws(()=>inspectFrame(Buffer.alloc(2000001),[]));const bad=Buffer.from(png);bad.writeUInt32BE(1,16);assert.throws(()=>inspectFrame(bad,[]))
})
