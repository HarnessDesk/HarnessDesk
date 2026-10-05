import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { overviewModel } from '../preview/team-overview-fixture'
import { TeamOverview } from './TeamOverview'
import { runTimeline } from '../lib/run-timeline'
import { runFixture } from '../preview/run-view-fixture'
import type { SeatRow } from '../lib/team-overview'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const box=document.createElement('div');document.body.append(box);const root=createRoot(box)
afterEach(()=>{ act(()=>root.render(null)); vi.useRealTimers() })
const row=(name:string,patch:Partial<SeatRow>={}):SeatRow=>({seat:name,name,role:'writer',card:null,round:null,state:'idle',done:false,reason:null,doing:null,since:null,durationMs:null,cost:null,...patch})
const render=(seats:SeatRow[])=>act(()=>root.render(<TeamOverview model={{run:null,needsYou:[],seats}} metered={new Map(seats.map(one => [one.seat, false]))} />))
it.each([600,1000])('keeps an unlinked Seat’s reason visible without a conversation action at %spx',width=>{
 const previous=globalThis.ResizeObserver
 globalThis.ResizeObserver=class {
  constructor(private callback:ResizeObserverCallback){}
  observe(){this.callback([{contentRect:{width}} as ResizeObserverEntry],this as unknown as ResizeObserver)}
  unobserve(){}
  disconnect(){}
 } as unknown as typeof ResizeObserver
 try {
  const onOpen=vi.fn()
  act(()=>root.render(<TeamOverview model={{run:null,needsYou:[],seats:[row('Gamma',{role:null,reason:'Conversation not kept'})]}} unavailable={new Set(['Gamma'])} onOpen={onOpen}/>))
  const seat=box.querySelector('[data-seat="Gamma"]')!
  expect(seat.textContent).toContain('Conversation not kept')
  expect(box.querySelectorAll('th')).toHaveLength(width<800?0:6)
  expect(seat.querySelector('button')).toBeNull()
  expect(seat.hasAttribute('tabindex')).toBe(false)
  act(()=>{(seat as HTMLElement).click();seat.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})
  expect(onOpen).not.toHaveBeenCalled()
  act(()=>root.render(<TeamOverview model={{run:null,needsYou:[],seats:[row('Gamma',{role:null,reason:'Conversation not kept'}),row('Alpha',{state:'working',doing:'Reading a file'})]}} unavailable={new Set(['Gamma'])} onOpen={onOpen}/>))
  expect(box.querySelector('[data-seat="Gamma"]')!.textContent!.split('Conversation not kept')).toHaveLength(2)
 } finally {globalThis.ResizeObserver=previous}
})
it('uses the ended Run card state and fixed time for the current step and its Seat',()=>{
 const fixture=runFixture('running')
 const timeline=runTimeline({...fixture,execution:{...fixture.execution,state:'stopped',endedAt:fixture.cards[3]!.claim!.at+60_000,currentEndedAt:fixture.cards[3]!.claim!.at+60_000}})
 const summary=overviewModel('running')
 const seat=row('Alpha',{seat:'seat-0',card:{id:4,title:'Answer the review'},state:'working',since:fixture.cards[3]!.claim!.at,doing:'Editing the retry'})
 act(()=>root.render(<TeamOverview model={{...summary,needsYou:[],seats:[seat],run:{...summary.run!,state:'stopped',round:4}}} timeline={timeline} />))
 expect(box.querySelector('[data-slot="run-current-step"]')?.textContent).toContain('Stopped')
 expect(box.querySelector('[data-slot="run-current-step"]')?.textContent).toContain('1m')
 expect(box.querySelector('[data-seat="seat-0"]')?.textContent).toContain('Stopped')
 expect(box.textContent).not.toMatch(/Working|so far|Editing the retry/)
 expect(box.querySelector('[data-slot="seat-state"] [data-slot="chip"]')).toBeNull()
})
it.each(['start','end'] as const)('keeps a stopped duration unknown when its %s is missing as time advances',missing=>{
 vi.useFakeTimers();vi.setSystemTime(Date.UTC(2026,9,4))
 const fixture=runFixture('running')
 const execution={...fixture.execution,state:'stopped' as const,currentEndedAt:missing==='end'?null:Date.now()-10_000}
 const cards=fixture.cards.map(card=>card.id===4&&missing==='start'?{...card,claim:null}:card)
 const timeline=runTimeline({...fixture,execution,cards,signals:[]})
 const summary=overviewModel('running')
 const seat=row('Alpha',{card:{id:4,title:'Answer the review'},state:'working',since:Date.now()-60_000})
 act(()=>root.render(<TeamOverview model={{...summary,needsYou:[],seats:[seat],run:{...summary.run!,state:'stopped',round:4}}} timeline={timeline}/>))
 const time=()=>[...box.querySelectorAll('[data-seat="Alpha"] td[data-align="end"]')].at(-1)?.textContent
 expect(time()).toBe('—')
 act(()=>vi.advanceTimersByTime(120_000))
 expect(time()).toBe('—')
})
it('offers Stop run… in the running Overview strip and withdraws it when the Run ends',()=>{
 const onStop=vi.fn()
 act(()=>root.render(<TeamOverview model={overviewModel('running')} onStop={onStop} />))
 const stop=[...box.querySelectorAll<HTMLButtonElement>('[aria-label="Run"] button')].find(one=>one.textContent==='Stop run…')
 expect(stop).toBeDefined()
 act(()=>stop!.click())
 expect(onStop).toHaveBeenCalledOnce()
 act(()=>root.render(<TeamOverview model={overviewModel('done')} onStop={onStop} />))
 expect(box.textContent).not.toContain('Stop run…')
})
it('shows precedence order, empty cards and the unit explanation',()=>{
 render([row('Wait',{state:'needs-you'}),row('News',{state:'unread'}),row('Work',{state:'working',cost:{unit:'turns',value:4,estimated:false}}),row('Idle')])
 expect([...box.querySelectorAll('[data-seat]')].map(e=>e.getAttribute('data-seat'))).toEqual(['Wait','News','Work','Idle'])
 expect(box.textContent).toContain('4 turns')
 expect(box.querySelector('[data-slot="seat-cost"][title*="not metered"]')).not.toBeNull()
 expect(box.querySelector('[data-slot="seat-card"]')?.textContent).toBe('—')
})
it('folds three done Seats and keeps an Idle Seat visible',()=>{
 render([row('Idle'),...['A','B','C'].map(name=>row(name,{done:true}))])
 expect(box.textContent).toContain('3 done')
 const disclosure=box.querySelector('button[aria-expanded]') as HTMLButtonElement
 expect(box.querySelectorAll('[data-seat]')).toHaveLength(1)
 act(()=>disclosure.click())
 expect(box.querySelectorAll('[data-seat]')).toHaveLength(4)
 expect(box.querySelectorAll('[data-slot="seat-state"][data-resting]')).toHaveLength(4)
})
it('keeps the done disclosure in the inset section header with its shared action style',()=>{
 render([row('Done',{done:true})])
 const section=box.querySelector('[aria-label="Seats"]')!
 const action=section.querySelector('[data-slot="section-head"] [data-slot="section-action"] button')!
 expect(action?.getAttribute('data-variant')).toBe('outline')
 expect(action?.getAttribute('aria-expanded')).toBe('false')
})
it('renders agent text without executable markup',()=>{
 render([row('<img src=x onerror="alert(1)">')])
 expect(box.querySelector('img')).toBeNull()
})
it('uses the wrapping sentence slot for attention text',()=>{
 const summary='Choose whether the checkout retry should keep the original payment method before this review can continue.'
 act(()=>root.render(<TeamOverview model={{run:null,seats:[],needsYou:[{kind:'question',seat:null,card:null,summary,since:1}]}} />))
 const sentence=box.querySelector('[aria-label="Needs you"] [data-slot="list-row-subtitle"]')
 expect(sentence?.textContent).toBe(summary)
 expect(sentence?.hasAttribute('data-wrap-subtitle')).toBe(true)
})
it.each([
 {runReason:'This review is waiting to be posted.',copies:1,statusLine:undefined},
 {runReason:'The Run ended without a next step.',copies:1,statusLine:undefined},
 {runReason:'This review is waiting to be posted.',copies:1,statusLine:()=> <span>Agents are idle</span>},
])('keeps publication reason once alongside $runReason',({runReason,copies,statusLine})=>{
 const publicationReason='This review is waiting to be posted.'
 const findingRun={run:'run',goal:'team',publication:'local',reason:publicationReason,boundPr:{repo:'acme/widgets',pr:7},
  rounds:[{round:3,state:'local',reason:publicationReason,pr:7,cards:[3]}]} as unknown as import('@harnessdesk/protocol').FindingRunView
 act(()=>root.render(<TeamOverview runReason={runReason} statusLine={statusLine} model={{seats:[],needsYou:[],run:{run:'run',state:'settled',round:3,role:'reviewer',startedAt:null,reviewRounds:null,total:{money:null,turns:null},findingRun,publicationOn:true,needsYou:true}}}/>))
 expect(box.textContent?.split(publicationReason).length).toBe(copies+1)
 expect(box.textContent).toContain(runReason)
})

it('omits empty Now and Cost, keeps the name flexible, and aligns figures to the end',()=>{
 render([row('Alpha',{round:1})])
 expect([...box.querySelectorAll('th')].map(one=>one.textContent)).toEqual(['Agent','Card','Round','State','Time','Open conversation'])
 expect(box.querySelector('th')?.className).not.toContain('w-36')
 expect([...box.querySelectorAll('th[data-align="end"]')].map(one=>one.textContent)).toEqual(['Round','Time'])
 expect(box.querySelectorAll('td[data-align="end"]')).toHaveLength(2)
})
it('keeps completed time fixed when the clock advances and opens the whole row',()=>{
 const onOpen=vi.fn()
 vi.useFakeTimers();vi.setSystemTime(100_000)
 const model={run:null,needsYou:[],seats:[row('Alpha',{done:true,durationMs:60_000,since:1})]}
 act(()=>root.render(<TeamOverview model={model} defaultExpanded onOpen={onOpen}/>))
 const seat=box.querySelector('[data-seat="Alpha"]')!
 expect(seat.textContent).toContain('1m')
 act(()=>vi.advanceTimersByTime(120_000))
 expect(seat.textContent).toContain('1m')
 act(()=>seat.dispatchEvent(new MouseEvent('click',{bubbles:true})))
 expect(onOpen).toHaveBeenCalledWith('Alpha')
 expect(seat.querySelector('button')).toBeNull()
 vi.useRealTimers()
})
it('shows an evidence wait once with a Findings action and no engine id',()=>{
 const summary=overviewModel('idle');const onFindings=vi.fn()
 act(()=>root.render(<TeamOverview model={{...summary,run:{...summary.run!,needsYou:true,waitingEvidence:true,waitingFindings:true}}} runReason="Rule to-referee: Waiting for 3 open blocking findings to be confirmed resolved." onFindings={onFindings}/>))
 expect(box.textContent).not.toContain('to-referee')
 expect(box.querySelector('[aria-label="Needs you"]')?.textContent).not.toContain('You or the reviewer')
 const action=[...box.querySelectorAll<HTMLButtonElement>('button')].find(one=>one.textContent==='Open findings')!
 expect(action.title).toBe('You or the reviewer can resolve this wait in Findings.')
 act(()=>action.click());expect(onFindings).toHaveBeenCalledOnce()
 expect(box.querySelector('[aria-label="Run"]')?.textContent).toContain('Needs you')
})
it('does not repeat a waiting approval sentence in the activity cell',()=>{
 const model=overviewModel('needs-you')
 act(()=>root.render(<TeamOverview model={model}/>))
 const waiting=box.querySelector('[data-seat="seat-1"]')!
 expect(waiting.querySelector('[data-slot="seat-doing"]')).toBeNull()
 expect(box.querySelector('[aria-label="Needs you"]')?.textContent).toContain('choose whether to keep the original payment method')
})

it('keeps the no-agent sentence inline on the section content edge',()=>{
 render([])
 const empty=box.querySelector('[aria-label="Seats"] [data-slot="empty-state"]')!
 expect(empty?.getAttribute('data-variant')).toBe('inline')
 expect(empty?.className).toContain('text-left')
 expect(empty?.querySelector('h3,svg')).toBeNull()
})

it('does not invent an evidence wait for an ordinary running Run',()=>{
 act(()=>root.render(<TeamOverview model={overviewModel('idle')}/>))
 expect(box.textContent).not.toContain('waiting for its evidence')
})
it('puts a publication wait only in its actionable Findings row',()=>{
 const reason='This review is waiting to be posted.'
 const summary=overviewModel('idle')
 const findingRun={run:summary.run!.run,goal:'overview-team',publication:'local',reason,boundPr:{repo:'acme/widgets',pr:7},rounds:[{round:3,state:'local',reason,pr:7,cards:[3]}]} as unknown as import('@harnessdesk/protocol').FindingRunView
 act(()=>root.render(<TeamOverview model={{...summary,run:{...summary.run!,needsYou:true,findingRun}}} statusLine={()=> <span>Agents are idle</span>} onFindings={()=>{}}/>))
 expect(box.textContent?.split(reason)).toHaveLength(2)
 expect(box.querySelector('[aria-label="Needs you"]')?.textContent).toContain(reason)
})
it('keeps distinct execution and posting reasons with the Findings action',()=>{
 const reason='This review is waiting to be posted.'
 const runReason='The Run ended without a next step.'
 const summary=overviewModel('done')
 const findingRun={run:summary.run!.run,goal:'overview-team',publication:'local',reason,boundPr:{repo:'acme/widgets',pr:7},rounds:[{round:3,state:'local',reason,pr:7,cards:[3]}]} as unknown as import('@harnessdesk/protocol').FindingRunView
 act(()=>root.render(<TeamOverview model={{...summary,run:{...summary.run!,needsYou:true,findingRun}}} runReason={runReason} onFindings={()=>{}}/>))
 for(const sentence of [reason,runReason])expect(box.textContent?.split(sentence)).toHaveLength(2)
 expect(box.querySelector('[aria-label="Needs you"]')?.textContent).toContain(reason)
})
it('preserves the supplied live line and its actions during a findings wait',()=>{
 const statusLine=vi.fn(()=> <span>Waiting for a Seat to finish before releasing its checkout.<button>Open trigger</button></span>)
 act(()=>root.render(<TeamOverview model={overviewModel('comparison')} runReason="Rule after-review: Waiting for 3 open blocking findings to be confirmed resolved." statusLine={statusLine} onFindings={()=>{}}/>))
 expect(box.textContent).toContain('Waiting for a Seat to finish before releasing its checkout.')
 expect([...box.querySelectorAll('button')].some(one=>one.textContent==='Open trigger')).toBe(true)
 expect(statusLine).toHaveBeenCalled()
 const findings=[...box.querySelectorAll('button')].find(one=>one.textContent==='Open findings')!
 expect(findings.getAttribute('title')).toBe('You or the reviewer can resolve this wait in Findings.')
 expect(box.textContent).not.toContain('You or the reviewer can resolve this wait in Findings.')
})
it.each(['Waiting for its evidence.','Waiting for a passing check at this revision.','Waiting for CI to go green at this revision.','Waiting for a structured review at this revision.','Waiting for the pull request to reach that state.','Waiting for an observed diff at this revision.','Waiting for card #7: findings-check has not passed.'])('keeps the evidence wait %s neutral with its reason in Run',reason=>{
 const summary=overviewModel('idle');const onRun=vi.fn();const onFindings=vi.fn()
 act(()=>root.render(<TeamOverview model={{...summary,run:{...summary.run!,needsYou:false,waitingEvidence:true}}} runReason={`Rule after-review: ${reason}`} onRun={onRun} onFindings={onFindings}/>))
 expect(box.querySelector('[aria-label="Needs you"]')).toBeNull()
 const strip=box.querySelector('[aria-label="Run"]')!
 expect(strip.textContent).toContain(reason)
 expect([...strip.querySelectorAll('[data-slot="chip"]')].map(one=>[one.textContent,one.getAttribute('data-tone')])).toContainEqual(['Waiting','neutral'])
 expect(box.textContent?.split(reason)).toHaveLength(2)
 expect(box.textContent).not.toContain('Open findings')
})
it('does not infer a live evidence wait from an ended Run’s older rule reason',()=>{
 const summary=overviewModel('done')
 act(()=>root.render(<TeamOverview model={summary} runReason="Rule after-review: Waiting for its evidence." onFindings={()=>{}}/>))
 expect(box.querySelector('[aria-label="Needs you"]')).toBeNull()
})

it('keeps a blocked Seat’s reason in Now when nobody is working',()=>{
 render([row('Alpha',{state:'needs-you',reason:'Choose a target',card:{id:1,title:'Build the change'}})])
 expect([...box.querySelectorAll('th')].map(one=>one.textContent)).toContain('Now')
 expect(box.querySelector('[data-seat="Alpha"] [data-slot="seat-doing"]')?.textContent).toBe('Choose a target')
})

it('keeps neutral Waiting beside a supplied live line and delegates its reason once',()=>{
 const summary=overviewModel('idle')
 const statusLine=vi.fn((_now:number,includeReason?:boolean)=><span>Agents are idle{includeReason && ' · Waiting for CI to go green at this revision.'}</span>)
 act(()=>root.render(<TeamOverview model={{...summary,run:{...summary.run!,waitingEvidence:true}}} runReason="Rule after-review: Waiting for CI to go green at this revision." statusLine={statusLine}/>))
 expect(box.querySelector('[aria-label="Run"] [data-slot="chip"]')?.textContent).toBe('Waiting')
 expect(box.textContent?.split('Waiting for CI to go green at this revision.')).toHaveLength(2)
 expect(statusLine).toHaveBeenLastCalledWith(expect.any(Number),true)
})
