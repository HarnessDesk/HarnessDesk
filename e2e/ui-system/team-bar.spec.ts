import { expectTitleRoom } from './title-contract'
import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { COLLECT, textReasons, USER } from '../../script/shots/audit.mjs'
import { FRAME } from '../../packages/ui/src/design/frame'
import { selectTeamPage, teamBar } from './team-frame-actions'

for (const theme of ['light', 'dark'] as const) {
 test(`Work remains available without a recorded Run in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:1440,height:900})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=no-run&right-panel&theme=${theme}`)
  if(theme==='dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
  const frame=page.locator('[data-frame-id="team-frame"]')
  await selectTeamPage(frame, 'overview')
  const work=frame.locator('[data-team-page="overview"]')
  await expect(work).toHaveAccessibleName('Work')
  await expect(work).toHaveAttribute('aria-selected','true')
  await expect(work).not.toHaveAttribute('aria-disabled','true')
  await expect(frame.locator('[data-team-page="run"]')).toHaveCount(0)
  await expect(frame.locator('[data-slot="team-overview"]')).toBeVisible()
  const directory=process.env.TEAM_BAR_SHOTS_DIR
  if(directory){
   await page.evaluate(()=>document.fonts.ready)
   const seen=await page.evaluate(collect=>new Function(`return ${collect}`)(),COLLECT)
   expect(textReasons(seen,{user:USER})).toEqual([])
   mkdirSync(directory,{recursive:true})
   await page.screenshot({path:`${directory}/after-no-run-work-${theme}.png`})
  }
  await work.focus()
  await page.keyboard.press('ArrowRight')
  const tasks=frame.locator('[data-team-page="board"]')
  await expect(tasks).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(tasks).toHaveAttribute('aria-selected','true')
  await expect(tasks).toHaveAccessibleName('Tasks')
  await expect(frame.locator('[data-slot="task-navigation"]').getByRole('button',{name:/^Findings(?:\s|$)/})).toHaveAttribute('aria-pressed','false')
  await page.keyboard.press('ArrowRight')
  await expect(frame.locator('[data-team-page="room"]')).toBeFocused()
 })
 test(`one measured Team bar and counted keyboard destinations in the body in ${theme}`, async ({page}) => {
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
  await expect(header.getByRole('tab')).toHaveCount(0)
  await expect(frame.getByRole('tablist', { name: 'Team views', exact: true }).getByRole('tab')).toHaveCount(3)
  expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  const title=header.locator('[data-topbar-title]')
  await expectTitleRoom(title)
  await shot('wide')
  await selectTeamPage(frame,'room')
  await frame.locator('[data-slot="workbench-main"]').getByRole('button',{name:/^(Chat|Split)$/}).click()
  await page.getByRole('menuitemradio',{name:'Split',exact:true}).click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(header.locator('[data-team-page="side-by-side"]')).toHaveCount(0)
  await shot('side-by-side')

  await page.goto(`/preview.html?team-frame=running&right-panel&theme=${theme}`)
  await selectTeamPage(frame,'room')
  await expect(page.getByRole('textbox',{name:'Address',exact:true})).toBeVisible()
  expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  await expectTitleRoom(title)
  await shot('right-panel')
  await selectTeamPage(frame,'board')
  const board=frame.locator('[data-team-page="board"]')
  await expect(board).toContainText('2')
  await board.focus()
  await page.keyboard.press('ArrowRight')
  await expect(frame.locator('[data-team-page="room"]')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(frame.locator('[data-team-page="room"]')).toHaveAttribute('data-active','')
  for(const width of [2100,720,1440]) {
   await page.setViewportSize({width,height:900})
   if (width < FRAME.fold.panelFloats) {
    const shell = frame.locator('[data-slot="fixed-shell"]')
    await expect(shell).toHaveAttribute('data-panel-floats', 'true')
    await expect(frame.locator('[data-frame-region="top"]')).toBeHidden()
    await expect(frame.locator('[data-frame-region="main"]')).toBeHidden()
    await expect(page.getByRole('textbox', { name: 'Address', exact: true })).toBeVisible()
    const pane = frame.locator('[data-frame-region="right"]')
    const bounds = (await pane.boundingBox())!
    expect(bounds.x).toBe(0)
    expect(bounds.y).toBe(0)
    expect(bounds.width).toBe(width)
    expect(bounds.height).toBe(900)
    await pane.getByRole('button', { name: 'Return to main', exact: true }).click()
    await expect(shell).toHaveAttribute('data-right-open', 'false')
    await expect(frame.locator('[data-frame-region="main"]')).toBeVisible()
   }
   // D1 restores the same bar and counted body destinations after the pane returns.
   await expect(header).toHaveAttribute('data-fold','0')
   await expectTitleRoom(title)
   const listed=frame.locator('[data-team-page]')
   await expect(listed).toHaveCount(3)
   await expect(listed.filter({hasText:/^Tasks/})).toContainText('2')
   expect(await header.locator('..').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
   const bar=(await header.locator('..').boundingBox())!
   const more=(await header.getByRole('button',{name:'More',exact:true}).boundingBox())!
   expect(bar.x+bar.width-more.x-more.width).toBe(FRAME.bar.pad)
  }
 })
}
