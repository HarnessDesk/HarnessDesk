import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const captureFrame = async (page: import('@playwright/test').Page, name: string) => {
 const directory = process.env.TEAM_FRAME_SHOTS_DIR
 if (!directory) return
 mkdirSync(directory, {recursive:true})
 await page.screenshot({path:`${directory}/${name}.png`})
}

for (const theme of ['light','dark'] as const) {
 test(`Team frame: one sidebar, section tabs and a reversible layout toggle in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:1440,height:900})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
  const team=page.locator('[data-slot="team-room"]')
  await expect(team.getByRole('tab')).toHaveCount(5)
  await expect(team.locator('aside')).toHaveCount(0)
  await expect(page.locator('[data-slot="workbench-rail"]')).toHaveCount(1)
  const header=team.locator('header').first()
  await expect(header.locator('[data-slot="avatar-stack"]')).toHaveCount(1)
  await expect(header.locator('[data-slot="avatar"][data-shape="round"]')).toHaveCount(2)
  await expect(header.getByRole('button',{name:'Wrap',exact:true})).toHaveCount(0)
  await expect(header.getByRole('button',{name:'Pull request #7',exact:true})).toBeVisible()
  const aligned = await team.evaluate(el => {
   const title = el.querySelector('header [data-role="subject"]')!.getBoundingClientRect()
   const tab = el.querySelector('[data-team-page="overview"]')!
   const range = document.createRange(); range.selectNodeContents(tab.firstChild!)
   return Math.abs(title.left - range.getBoundingClientRect().left)
  })
  expect(aligned).toBeLessThan(2)
  await page.evaluate(async () => { await document.fonts.ready })
  await captureFrame(page, `after-frame-1440-${theme}`)
  await team.getByRole('tab',{name:/^Board/}).click()
  const toggle=header.getByRole('button',{name:'Side by side',exact:true})
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed','true')
  await expect(team.getByRole('tab',{name:/^Board/})).toHaveAttribute('aria-selected','true')
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed','false')
  await expect(team.locator('[data-slot="board"]')).toBeVisible()
  await header.getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('menuitem',{name:'Fill the window',exact:true})).toBeVisible()
 })
 test(`Team frame: folded tools and scrolling tabs stay reachable in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:320,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame&theme=${theme}`)
  const team=page.locator('[data-slot="team-room"]')
  const header=team.locator('header').first()
  await expect(header.getByRole('button',{name:'Side by side',exact:true})).toBeHidden()
  await header.getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('switch',{name:'Side by side',exact:true})).toBeVisible()
  await expect(page.getByRole('switch',{name:'Hold messages at the board',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Pull request #7',exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(header.getByRole('button',{name:'More',exact:true})).toBeFocused()
  const overview=team.getByRole('tab',{name:/^Overview/})
  await overview.focus()
  await page.keyboard.press('End')
  const findings=team.getByRole('tab',{name:/^Findings/})
  await expect(findings).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(findings).toHaveAttribute('aria-selected','true')
  expect(await team.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  expect(await header.getByRole('button',{name:'More',exact:true}).evaluate(el=>{
   const box=el.getBoundingClientRect(); const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)
   return hit===el || el.contains(hit)
  })).toBe(true)
 })
 test(`Team frame: folded layout toggle reports its state in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:320,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const team=page.locator('[data-slot="team-room"]')
  const more=team.locator('header').first().getByRole('button',{name:'More',exact:true})
  await more.click()
  const toggle=page.getByRole('switch',{name:'Side by side',exact:true})
  await expect(toggle).toHaveAttribute('aria-checked','false')
  await toggle.click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await expect(more).toHaveAttribute('aria-expanded','false')
  await more.click()
  await expect(toggle).toHaveAttribute('aria-checked','true')
  await toggle.click()
  await expect(team.locator('[data-slot="team-overview"]')).toBeVisible()
 })
 test(`Team frame: More menu labels share one left edge in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:320,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
  const team=page.locator('[data-slot="team-room"]')
  await team.locator('header').first().getByRole('button',{name:'More',exact:true}).click()
  const labelLeft = (role: 'switch' | 'menuitem', label: string) =>
   page.getByRole(role,{name:label,exact:true}).evaluate((row, label) => {
    const text = [...row.querySelectorAll('span')].find(span => span.textContent?.trim() === label)
    return text!.getBoundingClientRect().left
   }, label)
  const edges = await Promise.all([
   labelLeft('switch','Side by side'),
   labelLeft('switch','Hold messages at the board'),
   labelLeft('menuitem','Pull request #7'),
   labelLeft('menuitem','Wrap…'),
   labelLeft('menuitem','Fill the window'),
  ])
  expect(Math.max(...edges)-Math.min(...edges)).toBeLessThanOrEqual(1)
  await captureFrame(page, `after-controls-${theme}`)
 })
 test(`Team frame: Wrap is primary only on a ready Overview in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=ready&theme=${theme}`)
  const team=page.locator('[data-slot="team-room"]')
  await expect(team.locator('[data-slot="team-overview"]').getByRole('button',{name:'Wrap',exact:true})).toBeVisible()
  await expect(team.locator('header').first().getByRole('button',{name:'Wrap',exact:true})).toHaveCount(0)
 })
}
