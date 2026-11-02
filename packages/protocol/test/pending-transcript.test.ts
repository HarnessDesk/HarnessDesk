import assert from 'node:assert/strict'
import {test} from 'node:test'
import {applyDelta as applyDeltaTyped,reduceSession as reduceSessionTyped} from '../src/reduce.js'
import {PendingTranscript} from '../src/pending-transcript.js'
// These synthetic wire fixtures deliberately use plain strings before branding;
// the real implementations are used, with a permissive test-only wire facade.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const module = { PendingTranscript: PendingTranscript as unknown as new (...args: any[]) => any }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyDelta = applyDeltaTyped as (...args: any[]) => any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reduceSession = reduceSessionTyped as (...args: any[]) => any
test('an unseen-turn delta remains owned until a matching full snapshot covers it',()=>{
  assert.equal(typeof module.PendingTranscript,'function','pending capture is unavailable')
  const owner={}, held=new module.PendingTranscript({runtime:'r',sessionId:'s',owner})
  const event={type:'item/delta',sessionId:'s',turnId:'t',itemId:'i',delta:{kind:'assistantText',text:'new'}}
  held.observe(event,{epoch:'e',generation:'g',revision:3,sequence:3},owner)
  event.delta.text='changed'
  assert.equal(held.inspect().turns[0].items[0].delta.assistantText,'new')
  assert.equal(held.retire(null,owner,true),false)
  assert.equal(held.retire({epoch:'e',generation:'g',revision:3,sequence:3,full:true,identityValid:true},owner,true),true)
  assert.equal(held.inspect().turns.length,0)
})

const fence=(sequence: number, extra: object={})=>({epoch:'e',generation:'g',revision:sequence,sequence,...extra})
const delta=(turn: string,item: string,text: string)=>({type:'item/delta',sessionId:'s',turnId:turn,itemId:item,delta:{kind:'assistantText',text}})
const make=()=>{const owner={};return {owner,pending:new module.PendingTranscript({runtime:'r',sessionId:'s',owner})}}
const snapshot=(sequence: number,extra: object={})=>({...fence(sequence),full:true,identityValid:true,...extra})
test('identical deltas at different cursors append; interleaved IDs stay distinct and compact',()=>{
  const {owner,pending}=make()
  pending.observe(delta('t','a','x'),fence(1),owner)
  pending.observe(delta('other','b','z'),fence(2),owner)
  for(let i=3;i<1003;i++)pending.observe(delta('t','a','x'),fence(i),owner)
  const state=pending.inspect()
  assert.equal(state.turns.length,2)
  assert.equal(state.turns[0].items[0].delta.assistantText,'x'.repeat(1001))
  assert.equal(state.turns[1].items[0].delta.assistantText,'z')
  assert.equal(state.quarantine.turns.length,0)
})
test('same cursor duplicate is ignored but conflicting content is protected',()=>{
  const {owner,pending}=make(),event=delta('t','i','a')
  assert.equal(pending.observe(event,fence(1),owner),'accepted')
  assert.equal(pending.observe(event,fence(1),owner),'duplicate')
  assert.equal(pending.observe(delta('t','i','b'),fence(1),owner),'unresolved')
  assert.equal(pending.retire(snapshot(3),owner,true),false)
  assert.equal(pending.inspect().quarantine.turns[0].items[0].deltaCandidates[0].text,'b')
})
test('invalid owner, absent fence and changed incarnation keep actual data quarantined',()=>{
  for(const [ownerFor,f] of [[{},fence(1)],[null,undefined],[null,fence(2,{epoch:'other'})]]){
    const {owner,pending}=make();pending.observe(delta('t','i','first'),fence(1),owner)
    assert.equal(pending.observe(delta('t','i','second'),f,ownerFor??owner),'unresolved')
    assert.equal(pending.retire(snapshot(10),owner,true),false)
    const retained=pending.inspect().quarantine.turns[0].items[0]
    assert.equal(f === undefined ? retained.delta.assistantText : retained.deltaCandidates[0].text,'second')
  }
})
test('only the same owner and a full validated covering snapshot can retire',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','x'),fence(3),owner)
  for(const [s,o,handled] of [[snapshot(3),{},true],[snapshot(2),owner,true],[snapshot(3,{generation:'new'}),owner,true],[snapshot(3,{identityValid:false}),owner,true],[snapshot(3,{full:false}),owner,true],[snapshot(3),owner,false]])assert.equal(pending.retire(s,o,handled),false)
  assert.equal(pending.retire(snapshot(3),owner,true),true)
})
test('a full item completion supersedes previous deltas and later deltas append',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','old'),fence(1),owner)
  const completed={type:'item/completed',sessionId:'s',turnId:'t',item:{id:'i',type:'assistantMessage',text:'full'}}
  assert.equal(pending.observe(completed,fence(2),owner),'accepted')
  pending.observe(delta('t','i','!'),fence(3),owner)
  const item=pending.inspect().turns[0].items[0]
  assert.deepEqual(item.replacement,completed.item);assert.equal(item.delta.assistantText,'!')
  assert.equal(applyDelta(item.replacement,{kind:'assistantText',text:item.delta.assistantText}).text,'full!')
})
test('a retired cursor cannot accept a late delta as a new incarnation',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','old'),fence(3),owner)
  assert.equal(pending.retire(snapshot(3),owner,true),true)
  assert.equal(pending.observe(delta('t','i','late'),fence(2),owner),'unresolved')
  assert.equal(pending.retire(snapshot(10),owner,true),false)
  assert.equal(pending.inspect().quarantine.turns[0].items[0].deltaCandidates[0].text,'late')
})
test('a missing start followed by an observed start keeps earlier delta until coverage',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','orphan'),fence(1),owner)
  const start={type:'item/started',sessionId:'s',turnId:'t',item:{id:'i',type:'assistantMessage',text:''}}
  assert.equal(pending.observe(start,fence(2),owner),'accepted')
  assert.equal(pending.inspect().turns[0].items[0].delta.assistantText,'orphan')
  assert.deepEqual(pending.inspect().turns[0].items[0].replacement,start.item)
  assert.equal(pending.retire(snapshot(2),owner,true),true)
})
test('a repeated notice identity retains one semantic notice',()=>{
  const {owner,pending}=make(), event={type:'notice',sessionId:'s',id:'n',level:'warning',message:'a'}
  for(let i=1;i<=1000;i++)pending.observe(event,fence(i),owner)
  assert.equal(pending.inspect().notices.length,1)
})
test('indexed reasoning, command, plan and file deltas keep their reducer operations compactly',()=>{
  const {owner,pending}=make(), input=[
    {kind:'reasoningSummaryPart',index:2}, {kind:'reasoningSummary',index:2,text:'a'}, {kind:'reasoningSummary',index:2,text:'b'},
    {kind:'reasoningText',index:0,text:'r'}, {kind:'commandOutput',stream:'stdout',chunk:'a'}, {kind:'commandOutput',stream:'stderr',chunk:'b'},
    {kind:'planText',text:'plan'}, {kind:'fileChangePatch',changes:[{path:'a',kind:{type:'add'},diff:'old'},{path:'b',kind:{type:'add'},diff:'b'}]},
    {kind:'fileChangePatch',changes:[{path:'a',kind:{type:'add'},diff:'new'}]}, {kind:'toolProgress',message:'transient'}]
  for(const [i,d] of input.entries()) assert.equal(pending.observe({type:'item/delta',sessionId:'s',turnId:'t',itemId:'i',delta:d},fence(i+1),owner),'accepted')
  const d=pending.inspect().turns[0].items[0].delta
  assert.deepEqual(d.reasoningSummary,{'2':'ab'});assert.deepEqual(d.reasoningSummaryParts,[2]);assert.deepEqual(d.reasoningText,{'0':'r'})
  assert.equal(d.commandOutput,'ab');assert.equal(d.planText,'plan');assert.deepEqual(d.fileChanges.map((x: any)=>[x.path,x.diff]),[['a','new'],['b','b']])
  const reason={id:'i',type:'reasoning',summary:[],content:[]}
  const expected=input.reduce((item: any,x: any)=>applyDelta(item,x),reason)
  const actual=applyDelta(applyDelta(applyDelta(reason,{kind:'reasoningSummaryPart',index:2}),{kind:'reasoningSummary',index:2,text:d.reasoningSummary['2']}),{kind:'reasoningText',index:0,text:d.reasoningText['0']})
  assert.deepEqual(actual,expected)
})
test('an observed item start keeps preceding orphan data protected',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','orphan'),fence(1),owner)
  const start={type:'item/started',sessionId:'s',turnId:'t',item:{id:'i',type:'assistantMessage',text:'start'}}
  assert.equal(pending.observe(start,fence(2),owner),'accepted')
  assert.equal(pending.inspect().turns[0].items[0].delta.assistantText,'orphan')
  assert.deepEqual(pending.inspect().turns[0].items[0].replacement,start.item)
})

test('turn, session, notice and error families retain typed material without an event journal',()=>{
  const {owner,pending}=make()
  const start={type:'turn/started',sessionId:'s',turn:{id:'t',status:'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'hello',deskContext:{prefixLength:2}}]}]}}
  const notice={type:'notice',sessionId:'s',id:'n',level:'warning',message:'warning'}
  const error={type:'error',sessionId:'s',error:{code:'unknown',message:'broken'}}
  const completion={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',items:[{id:'a',type:'assistantMessage',text:'answer'}]}}
  const started={type:'session/started',session:{id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}}
  for(const [i,event] of [start,notice,error,completion,started].entries())assert.equal(pending.observe(event,fence(i+1),owner),'accepted')
  const state=pending.inspect()
  assert.equal(state.turns[0].metadata.status,'completed')
  assert.equal(state.turns[0].items.find((x: any)=>x.id==='u').replacement.content[0].deskContext.prefixLength,2)
  assert.equal(state.turns[0].items.find((x: any)=>x.id==='a').candidates[0].text,'answer')
  assert.equal(state.notices[0].message,'warning');assert.equal(state.errors[0].message,'broken')
  assert.equal(state.session.cwd,'/');assert.equal(state.unresolved,false)
  assert.equal(pending.retire(snapshot(5),owner,true),true)
})
test('a cursor conflict stores conflicting material in semantic quarantine and blocks coverage',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','good'),fence(1),owner)
  assert.equal(pending.observe(delta('t','i','bad'),fence(1),owner),'unresolved')
  const state=pending.inspect();assert.equal(state.turns[0].items[0].delta.assistantText,'good')
  assert.equal(state.quarantine.turns[0].items[0].deltaCandidates[0].text,'bad')
  assert.equal(pending.retire(snapshot(100),owner,true),false)
})

test('conflicting typed replacements retain alternatives by semantic field, not by event',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','ok'),fence(1),owner)
  const events=[
    {type:'session/title',sessionId:'s',title:'first'}, {type:'session/title',sessionId:'s',title:'second'},
    {type:'turn/diff',sessionId:'s',turnId:'t',diff:'old'}, {type:'turn/diff',sessionId:'s',turnId:'t',diff:'new'},
    {type:'item/delta',sessionId:'s',turnId:'t',itemId:'i',delta:{kind:'fileChangePatch',changes:[{path:'p',kind:{type:'add'},diff:'old'}]}},
    {type:'item/delta',sessionId:'s',turnId:'t',itemId:'i',delta:{kind:'fileChangePatch',changes:[{path:'p',kind:{type:'add'},diff:'new'}]}}]
  for(const event of events)assert.equal(pending.observe(event,fence(1),owner),'unresolved')
  const q=pending.inspect().quarantine
  assert.deepEqual(q.sessionFieldCandidates.title,['first','second'])
  assert.deepEqual(q.turns[0].diffCandidates,['old','new'])
  assert.deepEqual(q.turns[0].items[0].deltaCandidates.flatMap((d: any)=>d.changes).map((c: any)=>c.diff),['old','new'])
  assert.equal(pending.retire(snapshot(10),owner,true),false)
})

test('equal-size completions retain distinct unknown-base alternatives',()=>{
  const {owner,pending}=make()
  for(let i=1;i<=1000;i++){
    const event={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',items:[{id:'i',type:'assistantMessage',text:`version-${i}`}]}}
    pending.observe(event,fence(i),owner)
  }
  const turn=pending.inspect().turns[0]
  assert.equal(turn.items[0].candidates.length,1000)
  assert.equal(turn.items[0].candidates[0].text,'version-1')
})

test('later replacements cannot overwrite either side of an unresolved cursor conflict',()=>{
  const {owner,pending}=make(), item=(text: any)=>({type:'item/completed',sessionId:'s',turnId:'t',item:{id:'i',type:'assistantMessage',text}})
  pending.observe(item('first'),fence(1),owner)
  pending.observe(item('conflict'),fence(1),owner)
  pending.observe(item('later'),fence(2),owner)
  const state=pending.inspect()
  assert.equal(state.turns[0].items[0].replacement.text,'first')
  assert.deepEqual(state.quarantine.turns[0].items[0].candidates.map((x: any)=>x.text),['conflict']);assert.equal(state.quarantine.turns[0].items[0].replacement.text,'later')
  assert.equal(pending.retire(snapshot(2),owner,true),false)
})

test('a second turn start updates metadata but does not overwrite previously observed items',()=>{
  const {owner,pending}=make()
  const start=(text: any)=>({type:'turn/started',sessionId:'s',turn:{id:'t',status:'inProgress',items:[{id:'i',type:'assistantMessage',text}]}})
  pending.observe(start('first'),fence(1),owner);pending.observe(start('ignored'),fence(2),owner)
  assert.equal(pending.inspect().turns[0].items[0].replacement.text,'first')
})

test('repeated notice occurrences with one content key compact to a count and latest identity',()=>{
  const {owner,pending}=make()
  for(let i=1;i<=1000;i++)pending.observe({type:'notice',sessionId:'s',id:`n${i}`,level:'warning',contentKey:'same',message:'warning'},fence(i),owner)
  const notices=pending.inspect().notices
  assert.equal(notices.length,1);assert.equal(notices[0].count,1000);assert.equal(notices[0].id,'n1');assert.equal(notices[0].lastEventId,'n1000')
})

test('notice coalescing follows the canonical reducer for a known empty session',()=>{
  const {owner,pending}=make()
  const base={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}
  const events=Array.from({length:40},(_,i)=>({type:'notice',sessionId:'s',id:`n${i}`,level:'warning',contentKey:'same',message:'warning',at:i}))
  let current: any=base
  for(const [i,event] of events.entries()){current=reduceSession(current,event);pending.observe(event,fence(i+1),owner)}
  const actual=pending.inspect().notices[0], expected=current.turns[0].items[0]
  assert.equal(actual.count,expected.count);assert.equal(actual.id,expected.id);assert.equal(actual.lastEventId,expected.lastEventId);assert.equal(actual.completedAt,expected.completedAt)
})

test('ordered completions after a conflict replace each other but preserve the conflicting alternative',()=>{
  const {owner,pending}=make(), item=(text: any)=>({type:'item/completed',sessionId:'s',turnId:'t',item:{id:'i',type:'assistantMessage',text,startedAt:1}})
  pending.observe(item('first'),fence(1),owner);pending.observe(item('conflict'),fence(1),owner)
  for(let i=2;i<1002;i++)pending.observe(item(`later-${i}`),fence(i),owner)
  const q=pending.inspect().quarantine.turns[0].items[0]
  assert.equal(q.candidates.length,1);assert.equal(q.candidates[0].text,'conflict');assert.equal(q.replacement.text,'later-1001')
  assert.equal(pending.retire(snapshot(1001),owner,true),false)
})

test('repeated errors with one message do not retain unrelated error-event history',()=>{
  const {owner,pending}=make()
  for(let i=1;i<=1000;i++)pending.observe({type:'error',sessionId:'s',error:{code:'unknown',message:'same',details:`detail-${i}`}},fence(i),owner)
  assert.equal(pending.inspect().errors.length,1)
})
test('ordered file patches after a conflict compact by path while preserving the conflict',()=>{
  const {owner,pending}=make(), patch=(diff: any)=>({type:'item/delta',sessionId:'s',turnId:'t',itemId:'i',delta:{kind:'fileChangePatch',changes:[{path:'p',kind:{type:'add'},diff}]}})
  pending.observe(patch('first'),fence(1),owner);pending.observe(patch('conflict'),fence(1),owner)
  for(let i=2;i<1002;i++)pending.observe(patch(`later-${i}`),fence(i),owner)
  const item=pending.inspect().quarantine.turns[0].items[0], d=item.delta
  assert.equal(item.deltaCandidates.length,1);assert.equal(item.deltaCandidates[0].changes[0].diff,'conflict')
  assert.equal(d.fileChanges.length,1);assert.equal(d.fileChanges[0].diff,'later-1001')
})

test('error-filtered completion alternatives stay protected until snapshot coverage',()=>{
  const {owner,pending}=make(), base={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'inProgress',items:[]}]}
  let current: any=base
  for(let i=1;i<=1000;i++){
    const event={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',error:{message:'broken'},items:[{id:'a',type:'assistantMessage',text:`v${i}`},{id:'e',type:'error',message:'broken'}]}}
    current=reduceSession(current,event);pending.observe(event,fence(i),owner)
  }
  assert.equal(current.turns[0].items[0].text,'v1000')
  assert.equal(pending.inspect().turns[0].items.find((x: any)=>x.id==='a').candidates.length,1000)
})

test('repeated error completions preserve whichever assistant candidate the reducer selects across varied bases',()=>{
  for(let extra=0;extra<8;extra++)for(const notice of [false,true])for(const oldError of [false,true]){
    const {owner,pending}=make(), items=[...Array.from({length:extra},(_,i)=>({id:`base${i}`,type:'assistantMessage',text:'base'})),...(notice?[{id:'notice',type:'notice',kind:'runtime',text:'notice'}]:[]),...(oldError?[{id:'old-error',type:'error',message:'broken'}]:[])]
    let actual: any={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'inProgress',items}]}
    for(let i=1;i<=5;i++){
      const event={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',error:{message:'broken'},items:[{id:'a',type:'assistantMessage',text:`v${i}`},{id:'e',type:'error',message:'broken'}]}}
      actual=reduceSession(actual,event);pending.observe(event,fence(i),owner)
    }
    const selected=actual.turns[0].items.find((x: any)=>x.id==='a')
    if(selected)assert.ok(pending.inspect().turns[0].items.find((x: any)=>x.id==='a').candidates.some((x: any)=>x.text===selected.text),`selected ${selected.text} missing`)
  }
})

test('error-filtered completions retain distinct user material',()=>{
  const {owner,pending}=make()
  for(let i=1;i<=1000;i++)pending.observe({type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',error:{message:'broken'},items:[{id:'u',type:'userMessage',content:[{type:'text',text:`v${i}`}]},{id:'e',type:'error',message:'broken'}]}},fence(i),owner)
  assert.equal(pending.inspect().turns[0].items.find((x: any)=>x.id==='u').candidates.length,1000)
})

test('error-filtered completions retain distinct tool material',()=>{
  const {owner,pending}=make()
  for(let i=1;i<=1000;i++)pending.observe({type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',error:{message:'broken'},items:[{id:'tool',type:'toolCall',tool:'x',source:{kind:'builtin'},status:'completed',args:{value:i}},{id:'e',type:'error',message:'broken'}]}},fence(i),owner)
  assert.equal(pending.inspect().turns[0].items.find((x: any)=>x.id==='tool').candidates.length,1000)
})

test('detachment retains idle state and interrupts known in-progress turns',()=>{
  const {owner,pending}=make()
  pending.observe({type:'turn/started',sessionId:'s',turn:{id:'t',status:'inProgress',items:[]}},fence(1),owner)
  pending.observe({type:'session/detached',sessionId:'s'},fence(2),owner)
  const state=pending.inspect();assert.deepEqual(state.sessionFields.status,{type:'idle'});assert.equal(state.turns[0].metadata.status,'interrupted')
})
test('session-level typed changes and non-transcript events remain with their proper owners',()=>{
  const {owner,pending}=make()
  const events=[{type:'session/title',sessionId:'s',title:'new'},{type:'session/memory',sessionId:'s',enabled:true},{type:'turn/diff',sessionId:'s',turnId:'t',diff:'diff'},{type:'turn/plan',sessionId:'s',turnId:'t',steps:[]},{type:'session/queue',sessionId:'s',queue:{messages:[]}}]
  for(const [i,e] of events.entries())assert.equal(pending.observe(e,fence(i+1),owner),'accepted')
  const state=pending.inspect();assert.equal(state.sessionFields.title,'new');assert.equal(state.sessionFields.memory,true);assert.equal(state.turns[0].diff,'diff');assert.deepEqual(state.turns[0].plan,[]);assert.equal('queue' in state.sessionFields,false)
})

test('interleaved session status retains distinct ambiguous completion material',()=>{
  const {owner,pending}=make()
  for(let i=0;i<1000;i++){
    pending.observe({type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',error:{message:'broken'},items:[{id:'a',type:'assistantMessage',text:`v${i}`},{id:'e',type:'error',message:'broken'}]}},fence(i*2+1),owner)
    pending.observe({type:'session/status',sessionId:'s',status:{type:'idle'}},fence(i*2+2),owner)
  }
  assert.equal(pending.inspect().turns[0].items.find((x: any)=>x.id==='a').candidates.length,1000)
})

test('several contradictory deltas at one cursor retain distinct alternatives',()=>{
  const {owner,pending}=make();pending.observe(delta('t','i','known'),fence(1),owner)
  pending.observe(delta('t','i','a'),fence(1),owner);pending.observe(delta('t','i','bc'),fence(1),owner)
  const alternatives=pending.inspect().quarantine.turns[0].items[0].deltaCandidates
  assert.deepEqual(alternatives.map((x: any)=>x.text),['a','bc'])
})

test('JSON object key order does not create a contradictory same-cursor event',()=>{
  const {owner,pending}=make()
  const item=(args: any)=>({type:'item/completed',sessionId:'s',turnId:'t',item:{id:'tool',type:'toolCall',tool:'x',source:{kind:'builtin'},status:'completed',args}})
  assert.equal(pending.observe(item({a:1,b:2}),fence(1),owner),'accepted')
  assert.equal(pending.observe(item({b:2,a:1}),fence(1),owner),'duplicate')
})

test('repeated identical ambiguous completion values do not allocate per delivery',()=>{
  const {owner,pending}=make(), event={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',error:{message:'broken'},items:[{id:'a',type:'assistantMessage',text:'same'},{id:'e',type:'error',message:'broken'}]}}
  for(let i=1;i<=5000;i++)pending.observe(event,fence(i),owner)
  assert.equal(pending.inspect().turns[0].items.find((x: any)=>x.id==='a').candidates.length,1)
})

test('unknown turns do not cause different notice payloads with one key to be lost',()=>{
  const {owner,pending}=make()
  pending.observe({type:'notice',sessionId:'s',id:'n1',level:'warning',contentKey:'k',message:'first'},fence(1),owner)
  pending.observe({type:'turn/completed',sessionId:'s',turn:{id:'unseen',status:'completed',items:[]}},fence(3),owner)
  pending.observe({type:'notice',sessionId:'s',id:'n2',level:'warning',contentKey:'k',message:'second'},fence(4),owner)
  assert.deepEqual(pending.inspect().notices.map((x: any)=>x.message),['first','second'])
})

test('a session replacement cannot hide distinct notice material with a reused identity',()=>{
  const {owner,pending}=make()
  pending.observe({type:'notice',sessionId:'s',id:'n',level:'warning',contentKey:'k',message:'first'},fence(1),owner)
  pending.observe({type:'session/started',session:{id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}},fence(2),owner)
  pending.observe({type:'notice',sessionId:'s',id:'n',level:'warning',contentKey:'k',message:'second'},fence(3),owner)
  assert.deepEqual(pending.inspect().notices.map((x: any)=>x.message),['first','second'])
})

test('a later gap preserves smaller completions when a missing turn may have started',()=>{
  const {owner,pending}=make(), base={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}
  const first={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',items:[{id:'a',type:'assistantMessage',text:'old-a'},{id:'b',type:'assistantMessage',text:'old-b'},{id:'c',type:'assistantMessage',text:'old-c'}]}}
  const missed={type:'turn/started',sessionId:'s',turn:{id:'t',status:'inProgress',items:[]}}
  const later={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',items:[{id:'x',type:'assistantMessage',text:'new-x'},{id:'y',type:'assistantMessage',text:'new-y'}]}}
  let host=reduceSession(reduceSession(reduceSession(base,first),missed),later)
  pending.observe(first,fence(1),owner);pending.observe(later,fence(3),owner)
  assert.equal(host.turns[0].items[0].text,'new-x')
  assert.equal(pending.inspect().turns[0].items.find((item: any)=>item.id==='x')?.candidates[0].text,'new-x')
})

test('item completion cannot discard a possible desk-context carrier from a turn completion',()=>{
  const {owner,pending}=make(),base={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'inProgress',items:[]}]}
  const a={type:'turn/completed',sessionId:'s',turn:{id:'t',status:'completed',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'hello',deskContext:{prefixLength:2}}]}]}}
  const b={type:'item/completed',sessionId:'s',turnId:'t',item:{id:'u',type:'userMessage',content:[{type:'text',text:'hello'}]}}
  const host=reduceSession(reduceSession(base,a),b);assert.deepEqual(host.turns[0].items[0].content[0].deskContext,{prefixLength:2})
  pending.observe(a,fence(1),owner);pending.observe(b,fence(2),owner)
  const item=pending.inspect().turns[0].items[0]
  assert.ok(item.replacement?.content?.[0]?.deskContext || item.candidates.some((x: any)=>x.content?.[0]?.deskContext))
})

test('retainLocal owns the body without inventing a cursor and rejects numeric retirement',()=>{
  const {owner,pending}=make()
  assert.equal(typeof pending.retainLocal,'function','local capture is unavailable')
  const body={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:1,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'completed',items:[{id:'i',type:'assistantMessage',text:'local text'}]}]}
  assert.equal(pending.retainLocal(body,owner),true)
  body.turns[0]!.items[0]!.text='mutated'
  const state=pending.inspect()
  assert.equal(state.watermark,null);assert.equal(state.local.turns[0].items[0].candidates[0].text,'local text')
  assert.equal(pending.retire(snapshot(100),owner,true),false)
})
test('retainLocal deduplicates equal bodies while retaining distinct values for one item',()=>{
  const {owner,pending}=make()
  const makeBody=(text: string,updatedAt: number)=>({id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'completed',items:[{id:'i',type:'assistantMessage',text}]}]})
  for(let i=0;i<1000;i++)assert.equal(pending.retainLocal(makeBody('first',i),owner),true)
  assert.equal(pending.retainLocal(makeBody('second',1000),owner),true)
  const state=pending.inspect()
  assert.deepEqual(state.local.turns[0].items[0].candidates.map((x: any)=>x.text),['first','second'])
  assert.equal(state.local.turns.length,1);assert.equal(state.local.turns[0].items.length,1)
  assert.deepEqual(state.local.sessionFieldCandidates.updatedAt,[0,1000])
})
test('retainLocal refuses wrong owner or wrong session without discarding existing material',()=>{
  const {owner,pending}=make()
  const body={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:1,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'completed',items:[{id:'i',type:'assistantMessage',text:'keep'}]}]}
  assert.equal(pending.retainLocal(body,owner),true)
  assert.equal(pending.retainLocal({...body,id:'other'},owner),false)
  assert.equal(pending.retainLocal({...body,runtime:'other'},owner),false)
  assert.equal(pending.retainLocal(body,{}),false)
  assert.equal(pending.inspect().local.turns[0].items[0].candidates[0].text,'keep')
})
test('local retained material blocks numeric retirement even alongside covered wire events',()=>{
  const {owner,pending}=make()
  const body={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:1,status:{type:'idle'},itemsLoaded:true,turns:[]}
  assert.equal(pending.retainLocal(body,owner),true)
  assert.equal(pending.observe(delta('t','i','wire'),fence(1),owner),'accepted')
  assert.equal(pending.retire(snapshot(1),owner,true),false)
  assert.equal(pending.inspect().turns[0].items[0].delta.assistantText,'wire')
})

test('local updatedAt extremes do not assume bodies arrive in timestamp order',()=>{
  const {owner,pending}=make()
  const body=(updatedAt: number)=>({id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt,status:{type:'idle'},itemsLoaded:true,turns:[]})
  for(const time of [50,10,40,25])assert.equal(pending.retainLocal(body(time),owner),true)
  assert.deepEqual(pending.inspect().local.sessionFieldCandidates.updatedAt,[10,50])
})

test('local capture preserves turn order and duplicate-item value order without body copies',()=>{
  const {owner,pending}=make()
  const a={id:'same',type:'assistantMessage',text:'A'}, b={id:'same',type:'assistantMessage',text:'B'}
  const body={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:1,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t2',status:'completed',items:[a,b,a]},{id:'t1',status:'completed',items:[]}]}
  assert.equal(pending.retainLocal(body,owner),true)
  assert.equal(pending.retainLocal({...body,updatedAt:2},owner),true)
  const state=pending.inspect(), layouts=state.localLayouts
  assert.equal(layouts.length,1)
  assert.deepEqual(layouts[0].turns.map((x: any)=>x.id),['t2','t1'])
  const refs=layouts[0].turns[0].items
  assert.deepEqual(refs.map((x: any)=>x.id),['same','same','same'])
  assert.equal(refs[0].valueKey,refs[2].valueKey);assert.notEqual(refs[0].valueKey,refs[1].valueKey)
  const candidates=state.local.turns[0].items[0].candidates
  assert.deepEqual(candidates.map((x: any)=>x.text),['A','B'])
})

test('local capture preserves actual field-to-layout association without inventing combinations',()=>{
  const {owner,pending}=make(),turns=[{id:'t',status:'completed',items:[]}]
  const body=(title: string,status: string)=>({id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:1,title,status:{type:status},itemsLoaded:true,turns})
  pending.retainLocal(body('A','idle'),owner);pending.retainLocal(body('B','active'),owner)
  const layouts=pending.inspect().localLayouts
  assert.equal(layouts.length,2)
  assert.notEqual(layouts[0].fields.title,layouts[1].fields.title)
  assert.notEqual(layouts[0].fields.status,layouts[1].fields.status)
})

test('local capture distinguishes an explicit undefined field from null',()=>{
  const {owner,pending}=make(),base={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:1,status:{type:'idle'},itemsLoaded:true,turns:[]}
  pending.retainLocal({...base,title:undefined},owner);pending.retainLocal({...base,title:null},owner)
  assert.deepEqual(pending.inspect().local.sessionFieldCandidates.title,[undefined,null])
})

test('ordered local callbacks preserve identical delta occurrences and block numeric retirement',()=>{
  const {owner,pending}=make()
  assert.equal(typeof pending.observeLocal,'function','ordered local capture is unavailable')
  assert.equal(pending.observeLocal(delta('t','i','repeat'),owner),'accepted')
  assert.equal(pending.observeLocal(delta('t','i','repeat'),owner),'accepted')
  assert.equal(pending.inspect().local.turns[0].items[0].delta.assistantText,'repeatrepeat')
  assert.equal(pending.inspect().watermark,null)
  pending.observe(delta('t','i','wire'),fence(5),owner)
  assert.equal(pending.retire(snapshot(5),owner,true),false)
})
test('ordered local capture rejects wrong owner and session, keeping interleaved items distinct',()=>{
  const {owner,pending}=make()
  assert.equal(pending.observeLocal(delta('t','a','1'),owner),'accepted')
  assert.equal(pending.observeLocal(delta('other','b','2'),owner),'accepted')
  assert.equal(pending.observeLocal(delta('t','a','3'),owner),'accepted')
  assert.equal(pending.observeLocal(delta('t','a','bad'),{}),'refused')
  assert.equal(pending.observeLocal({...delta('t','a','bad'),sessionId:'other'},owner),'refused')
  const state=pending.inspect()
  assert.equal(state.local.turns[0].items[0].delta.assistantText,'13');assert.equal(state.local.turns[1].items[0].delta.assistantText,'2')
})
test('local completion barriers preserve earlier deltas and distinct replacements',()=>{
  const {owner,pending}=make(), item=(text: string)=>({type:'item/completed',sessionId:'s',turnId:'t',item:{id:'i',type:'assistantMessage',text}})
  pending.observeLocal(delta('t','i','before'),owner);pending.observeLocal(item('first'),owner)
  pending.observeLocal(delta('t','i','after'),owner);pending.observeLocal(item('second'),owner)
  const itemState=pending.inspect().local.turns[0].items[0]
  assert.equal(itemState.delta.assistantText,'beforeafter')
  assert.ok([itemState.replacement,...itemState.candidates].some((x: any)=>x.text==='first'))
  assert.ok([itemState.replacement,...itemState.candidates].some((x: any)=>x.text==='second'))
})
test('unfenced wire observations do not collapse identical append occurrences',()=>{
  const {owner,pending}=make()
  pending.observe(delta('t','i','x'),undefined,owner);pending.observe(delta('t','i','x'),undefined,owner)
  assert.equal(pending.inspect().quarantine.turns[0].items[0].delta.assistantText,'xx')
  assert.equal(pending.retire(snapshot(5),owner,true),false)
})
test('local session replay preserves its exact turn and repeated-item layout',()=>{
  const {owner,pending}=make(),a={id:'same',type:'assistantMessage',text:'A'},b={id:'same',type:'assistantMessage',text:'B'}
  const replay={type:'session/started',session:{id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[{id:'t',status:'completed',items:[a,b,a]}]}}
  assert.equal(pending.observeLocal(replay,owner),'accepted')
  const refs=pending.inspect().localLayouts[0].turns[0].items
  assert.equal(refs.length,3);assert.equal(refs[0].valueKey,refs[2].valueKey);assert.notEqual(refs[0].valueKey,refs[1].valueKey)
})

test('ordered local errors retain the non-retrying status effect for the same message',()=>{
  const {owner,pending}=make(),base={id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}
  const retry={type:'error',sessionId:'s',error:{code:'network',message:'same',retrying:true}}
  const final={type:'error',sessionId:'s',error:{code:'network',message:'same',retrying:false}}
  const reduced=reduceSession(reduceSession(base,retry),final);assert.equal(reduced.status.type,'error')
  assert.equal(pending.observeLocal(retry,owner),'accepted');assert.equal(pending.observeLocal(final,owner),'accepted')
  const errors=pending.inspect().local.errors
  assert.ok(errors.some((e: any)=>e.retrying===true));assert.ok(errors.some((e: any)=>e.retrying===false))
})

test('a local session replay resets turn-start assumptions without losing earlier material',()=>{
  const {owner,pending}=make(), start=(text: string)=>({type:'turn/started',sessionId:'s',turn:{id:'t',status:'inProgress',items:[{id:'i',type:'assistantMessage',text}]}})
  assert.equal(pending.observeLocal(start('before'),owner),'accepted')
  assert.equal(pending.observeLocal({type:'session/started',session:{id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}},owner),'accepted')
  assert.equal(pending.observeLocal(start('after'),owner),'accepted')
  const item=pending.inspect().local.turns[0].items[0]
  assert.equal(item.replacement.text,'before');assert.ok(item.candidates.some((x: any)=>x.text==='after'))
})

test('an unfenced session replay also resets local turn-start assumptions',()=>{
  const {owner,pending}=make(), start=(text: string)=>({type:'turn/started',sessionId:'s',turn:{id:'t',status:'inProgress',items:[{id:'i',type:'assistantMessage',text}]}})
  pending.observeLocal(start('before'),owner)
  pending.observe({type:'session/started',session:{id:'s',runtime:'r',cwd:'/',createdAt:0,updatedAt:0,status:{type:'idle'},itemsLoaded:true,turns:[]}},undefined,owner)
  pending.observeLocal(start('after'),owner)
  assert.ok(pending.inspect().local.turns[0].items[0].candidates.some((x: any)=>x.text==='after'))
})
