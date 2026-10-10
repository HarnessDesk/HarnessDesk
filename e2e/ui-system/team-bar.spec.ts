import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
import { FRAME } from '../../packages/ui/src/design/frame'
import { selectTeamPage, teamBar } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
 test(`a disabled Run explains why it is unavailable in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:1440,height:900})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=no-run&right-panel&theme=${theme}`)
  if(theme==='dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
  const frame=page.locator('[data-frame-id="team-frame"]')
  const header=teamBar(frame)
  const run=header.locator('[data-team-page="run"]')
  await expect(run).toHaveAttribute('aria-disabled','true')
  expect(await run.evaluate(el=>getComputedStyle(el).pointerEvents)).not.toBe('none')
  await expect(run).toHaveAccessibleDescription('This Team has no Run yet')
  await run.hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('Run — This Team has no Run yet')
  const directory=process.env.TEAM_BAR_SHOTS_DIR
  if(directory){
   await page.evaluate(()=>document.fonts.ready)
   const seen=await page.evaluate(collect=>new Function(`return ${collect}`)(),COLLECT)
   expect(textReasons(seen,{user:USER})).toEqual([])
   mkdirSync(directory,{recursive:true})
   await page.screenshot({path:`${directory}/after-no-run-tooltip-${theme}.png`})
  }
  await run.click({force:true})
  await expect(run).not.toHaveAttribute('data-active','')
  await expect(header.locator('[data-team-page="room"]')).toHaveAttribute('data-active','')
  await header.locator('[data-team-page="overview"]').focus()
  await page.keyboard.press('ArrowRight')
  await expect(run).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(run).not.toHaveAttribute('data-active','')
  await expect(header.locator('[data-team-page="room"]')).toHaveAttribute('data-active','')
  await page.keyboard.press('ArrowRight')
  await expect(header.locator('[data-team-page="board"]')).toBeFocused()
  await expect(header.locator('[data-team-page="board"]')).toContainText('0')
 })
 test(`one measured Team bar, counts and keyboard destinations in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:1440,height:900})
  await page.emulateMedia({colorScheme:theme})
  const shot=async(name:string)=>{
   const directory=process.env.TEAM_BAR_SHOTS_DIR
   if(!directory)return
   await page.evaluate(()=>document.fonts.ready)
   mkdirSync(directory,{recursive:true})
   await page.screenshot({path:`${directory}/after-${name}-${theme}.png`})
  }
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const frame=page.locator('[data-frame-id="team-frame"]')
  const team=frame.locator('[data-slot="team-room"]')
  const header=teamBar(frame)
  await expect(header.getByRole('tab')).toHaveCount(5)
  await expect(header.locator('[data-slot="tabs-list"]')).toHaveAttribute('data-variant','line')
  expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  const title=header.locator('[data-topbar-title]')
  await expect.poll(async()=>(await title.boundingBox())?.width??0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  await shot('wide')
  await selectTeamPage(frame,'room')
  await header.getByRole('button',{name:'View',exact:true}).click()
  await page.getByRole('menuitemradio',{name:'Side by side',exact:true}).click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(header.locator('[data-team-page="side-by-side"]')).toHaveCount(0)
  await shot('side-by-side')

  await page.goto(`/preview.html?team-frame=running&right-panel&theme=${theme}`)
  await expect(page.getByRole('textbox',{name:'Address',exact:true})).toBeVisible()
  expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  await expect.poll(async()=>(await title.boundingBox())?.width??0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  await shot('right-panel')
  await selectTeamPage(frame,'board')
  const board=header.locator('[data-team-page="board"]')
  await expect(board).toContainText('2')
  await board.focus()
  await page.keyboard.press('ArrowRight')
  await expect(header.locator('[data-team-page="room"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(header.locator('[data-team-page="room"]')).toHaveAttribute('data-active','')
  for(const width of [2100,720,1440]) {
   await page.setViewportSize({width,height:900})
   // Wait for the measured destination state after resize, not the previous
   // viewport's already-wide title before ResizeObserver resets its fold.
   await expect(header).toHaveAttribute('data-fold',width===720?'2':'0')
   await expect.poll(async()=>(await title.boundingBox())?.width??0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
   const folded=await header.getAttribute('data-fold')==='2'
   if(folded) await header.getByTitle('Destination views',{exact:true}).click()
   const listed=folded?page.locator('[role="menu"] [data-team-page]:visible'):header.locator('[data-team-page]')
   await expect(listed).toHaveCount(5)
   await expect(listed.filter({hasText:/^Board/})).toContainText('2')
   if(folded)await page.keyboard.press('Escape')
   expect(await header.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
   const bar=(await header.locator('..').boundingBox())!
   const more=(await header.getByRole('button',{name:'More',exact:true}).boundingBox())!
   expect(bar.x+bar.width-more.x-more.width).toBe(FRAME.bar.pad)
  }
 })
}
