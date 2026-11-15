import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchPointer } from './pointer.mjs'

test('trusted right pointer sends move, right press, and right release with correct button masks',async()=>{
 const events=[],cdp={send:async(method,params)=>events.push({method,...params})}
 await dispatchPointer(cdp,{x:7,y:9},'right')
 assert.deepEqual(events,[
  {method:'Input.dispatchMouseEvent',type:'mouseMoved',x:7,y:9},
  {method:'Input.dispatchMouseEvent',type:'mousePressed',x:7,y:9,button:'right',buttons:2,clickCount:1},
  {method:'Input.dispatchMouseEvent',type:'mouseReleased',x:7,y:9,button:'right',buttons:0,clickCount:1},
 ])
})
test('default pointer is left and unknown buttons refuse without events',async()=>{
 const events=[],cdp={send:async(method,params)=>events.push({method,...params})}
 await dispatchPointer(cdp,{x:1,y:2})
 assert.equal(events[1].button,'left');assert.equal(events[1].buttons,1);assert.equal(events[2].buttons,0)
 const before=events.length;await assert.rejects(dispatchPointer(cdp,{x:1,y:2},'middle'),/unsupported/);assert.equal(events.length,before)
})
