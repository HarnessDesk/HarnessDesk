import { expect, it } from 'vitest'
import { doingLine, teamOverview } from './team-overview'
import { doingLine as sharedDoingLine, teamOverview as sharedOverview } from '@harnessdesk/client/views'

it('keeps the window on the shared overview functions', () => {
  expect(teamOverview).toBe(sharedOverview)
  expect(doingLine).toBe(sharedDoingLine)
})

it('a paused Seat queue has a visible attention row leading to its conversation', async () => {
 const {overviewInput}=await import('../preview/team-overview-fixture')
 const {overviewAttention}=await import('./overview-attention')
 const input=overviewInput('idle')
 const model=teamOverview({...input,seats:input.seats.slice(0,1).map(seat=>({...seat,paused:true}))})
 expect(model.seats[0]).toMatchObject({state:'needs-you',reason:'Queued work is paused'})
 expect(overviewAttention(model)).toMatchObject([{kind:'seat',seat:model.seats[0]!.seat,reason:'Queued work is paused'}])
})
