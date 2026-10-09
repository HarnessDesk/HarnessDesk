import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

for (const theme of ['light', 'dark'] as const) {
 test(`one measured Team bar, count tooltips and keyboard tabs in ${theme}`, async ({page}) => {
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
  const team=page.locator('[data-slot="team-room"]')
  const header=team.locator('header').first()
  const tabs=header.getByRole('tab')
  await expect(tabs).toHaveCount(6)
  await expect(header.locator('[data-slot="tabs-list"]')).toHaveAttribute('data-variant','default')
  await expect(header.locator('[data-icon-only="false"]')).toHaveCount(6)
  expect((await header.boundingBox())!.height).toBe(48)
  const title=header.locator('[data-team-title]')
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(96)
  await shot('wide')
  await header.getByRole('tab',{name:'Side by side',exact:true}).click()
  await expect(header.getByRole('tab',{name:'Side by side',exact:true})).toHaveAttribute('aria-selected','true')
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await shot('side-by-side')

  await page.goto(`/preview.html?team-frame=running&right-panel&theme=${theme}`)
  await expect(header.locator('[data-icon-only="true"]')).toHaveCount(6)
  await expect(page.getByRole('textbox',{name:'Address',exact:true})).toBeVisible()
  expect((await header.boundingBox())!.height).toBe(48)
  expect((await title.boundingBox())!.width).toBeGreaterThanOrEqual(96)
  await shot('right-panel')
  const board=header.getByRole('tab',{name:'Board · 2',exact:true})
  await expect(board.locator('[data-slot="tabs-count"]')).toHaveText('2')
  await board.hover()
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText('Board · 2')
  await shot('tooltip')
  await page.mouse.move(900,800)
  await board.focus()
  await page.keyboard.press('ArrowRight')
  await expect(header.getByRole('tab',{name:'Chat',exact:true})).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(header.getByRole('tab',{name:'Chat',exact:true})).toHaveAttribute('aria-selected','true')
  await page.setViewportSize({width:2100,height:900})
  await expect(header.locator('[data-icon-only="false"]')).toHaveCount(6)
  await page.setViewportSize({width:1440,height:900})
  await expect(header.locator('[data-icon-only="true"]')).toHaveCount(6)
  await expect(board).toHaveAttribute('aria-label','Board · 2')
  expect(await header.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
 })
}
