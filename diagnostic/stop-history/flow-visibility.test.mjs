import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from '../../packages/ui/node_modules/jsdom/lib/api.js'
import { flowVisibility,closeHistoryDialog } from './flow-visibility.mjs'
import { locateTarget } from './click-target.mjs'

test('the footer Close is unique and the Team visibility observation contains bounded counts only',()=>{
 const dom=new JSDOM('<div aria-hidden="true"><div data-region="team-row"><button aria-label="Actions for secret-sentinel">Actions</button></div></div><div role="dialog"><button aria-label="Close">×</button><div data-slot="dialog-footer"><button>Close</button></div></div>')
 try {
  const d=dom.window.document,target=d.querySelector('[data-slot="dialog-footer"] button'),action=d.querySelector('[data-region="team-row"] button')
  target.getBoundingClientRect=()=>({left:10,top:20,width:100,height:40});target.scrollIntoView=()=>{}
  action.getBoundingClientRect=()=>({left:0,top:0,width:0,height:0});d.elementFromPoint=()=>target
  const hit=locateTarget(d,'[role="dialog"] [data-slot="dialog-footer"] button','Close')
  assert.equal(hit.matches,1);assert.equal(hit.eligible,1);assert.equal(hit.hits,1)
  assert.deepEqual(flowVisibility(d),{dialogs:1,teamRows:1,actionButtons:1,zeroRect:1,hiddenStyle:0,inert:0,ariaHidden:1})
  assert.equal(JSON.stringify(flowVisibility(d)).includes('secret-sentinel'),false)
 } finally {dom.window.close()}
})
test('history closes before success and a failed close cannot proceed',async()=>{
 for(const closes of [true,false]) {
  let open=true,clicked=false
  const value=()=>({dialogs:Number(open),teamRows:1,actionButtons:1,zeroRect:0,hiddenStyle:0,inert:0,ariaHidden:0})
  const cdp={json:async()=>value(),eval:async()=>true},result={checks:{}}
  const click=async()=>{clicked=true;if(closes)open=false}
  const waitFor=async label=>{if(label==='Triggers closed' && open)throw Error('not closed')}
  if(closes){await closeHistoryDialog({cdp,click,waitFor,result});assert.equal(result.checks.flowHistoryClosed,true);assert.equal(result.visibility.afterClose.dialogs,0)}
  else {await assert.rejects(closeHistoryDialog({cdp,click,waitFor,result}),/not closed/);assert.equal(result.checks.flowHistoryClosed,undefined)}
  assert.equal(clicked,true)
 }
})
