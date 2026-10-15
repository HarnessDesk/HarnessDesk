import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

for (const theme of ['light','dark'] as const) {
 for (const width of [1440,720]) test(`wrapping and quiet Teams keep truthful placement and summaries ${width} ${theme}`,async({page})=>{
  // Supply lifecycle and unread facts through the existing placeholder rig.
  await page.route('**/src/preview/teams-page-fixture.ts*',async route=>{
   const response=await route.fetch(), source=await response.text()
   const anchor='return new Proxy(base, {'
   expect(source).toContain(anchor)
   await route.fulfill({response,body:source.replace(anchor,`
    const wrapping=state.goals.get('team-2');
    state.goals.set('team-2',{...wrapping,goal:{...wrapping.goal,state:'wrapping'}});
    const stopped=state.flowExecutions.get('team-2-run');
    state.flowExecutions.set(stopped.id,{...stopped,state:'stopped'});
    state.inbox=wrapping.members.map((member,index)=>({id:'unread-'+index,read:false,at:Date.now(),from:member.session}));
    const quiet=state.teams.get('team-4');
    state.teams.set(quiet.id,{...quiet,intents:quiet.intents.map((card,index)=>index===0?{...card,state:'open',claim:null}:card)});
    const ended=state.flowExecutions.get('team-4-run');
    state.flowExecutions.set(ended.id,{...ended,reason:null});
    ${anchor}`)})
  })
  await openFrame(page,'frame-wall=teams',theme,width)
  const wrapping=page.locator('[data-team-row="team-2"]')
  const quiet=page.locator('[data-team-row="team-4"] [data-slot="team-detail"]')
  if(process.env.TEAMS_REPAIR_FRAMES)await page.screenshot({path:`${process.env.TEAMS_REPAIR_FRAMES}/${process.env.TEAMS_REPAIR_PREFIX ?? 'after'}-${width}-${theme}.png`})
  await expect(page.locator('[aria-label="Working"] [data-team-row="team-2"]')).toHaveCount(1)
  await expect(wrapping.locator('[data-slot="team-detail"]')).toHaveText('Wrapping')
  const summary=await quiet.textContent() ?? ''
  expect(summary.match(/round 2/gi)).toHaveLength(1)
  expect(summary.match(/reviewer/gi)).toHaveLength(1)
 })
}
