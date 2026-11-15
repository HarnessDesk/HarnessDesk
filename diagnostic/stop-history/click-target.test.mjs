import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from '../../packages/ui/node_modules/jsdom/lib/api.js'
import { locateTarget } from './click-target.mjs'

test('a unique off-screen Issue #101 review button is scrolled into view and hit-tested',()=>{
 const dom=new JSDOM('<div data-slot="list-row">Issue #102<button>Mark reviewed</button></div><div data-slot="list-row">Issue #101<button>Mark reviewed</button></div>')
 try {
  const doc=dom.window.document,buttons=doc.querySelectorAll('button'),target=buttons[1]
  let y=900,scrolls=0
  target.getBoundingClientRect=()=>({left:100,top:y,width:100,height:40})
  target.scrollIntoView=()=>{scrolls++;y=400}
  doc.elementFromPoint=(_x,py)=>py<768?target:null
  const result=locateTarget(doc,'button','Mark reviewed','#101')
  assert.deepEqual(result.point,{x:150,y:420});assert.equal(result.scrolled,true);assert.equal(scrolls,1)
 } finally {dom.window.close()}
})

test('ambiguous enabled rows are refused without scrolling',()=>{
 const dom=new JSDOM('<div data-slot="list-row">Issue #101<button>Mark reviewed</button><button>Mark reviewed</button></div>')
 try {
  const d=dom.window.document;let scrolls=0
  for(const button of d.querySelectorAll('button')){button.getBoundingClientRect=()=>({left:0,top:900,width:100,height:40});button.scrollIntoView=()=>scrolls++}
  const result=locateTarget(d,'button','Mark reviewed','#101')
  assert.equal(result.matches,2);assert.equal(result.eligible,2);assert.equal(result.point,null);assert.equal(scrolls,0)
 } finally {dom.window.close()}
})

test('blocked and disabled targets fail closed; icon-only History uses its accessible label',()=>{
 const dom=new JSDOM('<div data-slot="list-row">Issue #101<button disabled>Mark reviewed</button></div><button aria-label="History"></button>')
 try {
  const d=dom.window.document,buttons=d.querySelectorAll('button');for(const button of buttons){button.getBoundingClientRect=()=>({left:10,top:20,width:100,height:40});button.scrollIntoView=()=>{}}
  d.elementFromPoint=()=>d.body
  const disabled=locateTarget(d,'button','Mark reviewed','#101');assert.equal(disabled.matches,1);assert.equal(disabled.eligible,0);assert.equal(disabled.point,null)
  const blocked=locateTarget(d,'button','History');assert.equal(blocked.matches,1);assert.equal(blocked.eligible,1);assert.equal(blocked.inViewport,1);assert.equal(blocked.hits,0);assert.equal(blocked.point,null)
 } finally {dom.window.close()}
})
