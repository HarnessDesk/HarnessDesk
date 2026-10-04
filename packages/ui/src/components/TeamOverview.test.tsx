import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { TeamOverview } from './TeamOverview'
import type { SeatRow } from '../lib/team-overview'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const box=document.createElement('div');document.body.append(box);const root=createRoot(box)
afterEach(()=>act(()=>root.render(null)))
const row=(name:string,patch:Partial<SeatRow>={}):SeatRow=>({seat:name,name,role:'writer',card:null,round:null,state:'idle',done:false,reason:null,doing:null,since:null,cost:null,...patch})
const render=(seats:SeatRow[])=>act(()=>root.render(<TeamOverview model={{run:null,needsYou:[],seats}} metered={new Map(seats.map(one => [one.seat, false]))} />))
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
