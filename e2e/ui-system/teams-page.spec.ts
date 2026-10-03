import { expect, test, type Page } from '@playwright/test'

const openTeams=async(page:Page,theme:'light'|'dark')=>{
 await page.goto('/preview.html?teams-page')
 await page.locator('label').filter({hasText:/^theme/}).locator('select').first().selectOption(theme)
 await expect(page.locator('html')).toHaveCSS('color-scheme',theme)
}

for(const theme of ['light','dark'] as const) {
 test(`Teams page: precedence, folding, Hide, face geometry and complete reasons in ${theme}`,async({page})=>{
  await openTeams(page,theme)
  const frame=page.locator('#teams-page-active')
  await expect(frame.locator('[data-team-row]')).toHaveCount(3)
  expect(await frame.locator('[data-team-row]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-team-row')))).toEqual(['team-0','team-1','team-2'])
  const dot=await frame.locator('[data-team-row="team-0"] [data-slot="dot"]').boundingBox()
  expect(dot?.width).toBe(6);expect(dot?.height).toBe(6)
  await expect(frame.getByRole('button',{name:'Active',exact:true})).toHaveAttribute('aria-current','page')
  const fold=frame.getByRole('button',{name:'Ready to wrap · 2'})
  await expect(fold).toHaveAttribute('aria-expanded','false');await fold.click()
  await expect(frame.locator('[data-team-row]')).toHaveCount(5)
  const ready=frame.locator('[data-team-row="team-3"]')
  await ready.getByRole('button',{name:'Hide',exact:true}).click()
  await expect(frame.locator('[data-team-row]')).toHaveCount(4)
  await frame.getByRole('button',{name:'Settled',exact:true}).click()
  await expect(frame.locator('[data-team-row]')).toHaveCount(2)
  await expect(frame.getByRole('button',{name:'Show in Active'})).toBeVisible()
  await page.evaluate(()=>document.fonts.ready)
  for(const row of await frame.locator('[data-team-row]').all()) {
   await expect(row.locator('[data-shape="face"]')).toHaveCount(2)
   expect(await row.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true)
  }
  const attention=page.locator('#teams-page-needs-you [data-team-row="team-0"] [data-slot="list-row-subtitle"]')
  expect(await attention.evaluate(e=>({fits:e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight,whiteSpace:getComputedStyle(e).whiteSpace}))).toEqual({fits:true,whiteSpace:'normal'})
 })
 test(`Teams page: 375px and 720px keep navigation and all readings inside the page in ${theme}`,async({page})=>{
  for(const width of [375,720]) {
   await page.setViewportSize({width,height:900})
   await openTeams(page,theme)
   const frame=page.locator('#teams-page-active')
   await expect(frame.locator('[data-slot="teams-page"]')).toBeVisible()
   for(const item of await frame.locator('[data-slot="app-window"], [data-slot="app-window-page"], [data-team-row]').all()) {
    expect(await item.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
   }
   await expect(frame.getByRole('button',{name:'Needs you',exact:true})).toBeVisible()
   for(const label of await frame.locator('[data-slot="sidebar-menu-label-content"]').all()) {
    const geometry=await label.evaluate(e=>({label:e.textContent,scroll:e.scrollWidth,width:e.clientWidth}))
    expect(geometry.scroll,JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.width+1)
   }
  }
 })
}

for(const theme of ['light','dark'] as const) {
 test(`Teams page: every production rig state renders in ${theme}`,async({page})=>{
  await openTeams(page,theme)
  await page.evaluate(()=>document.fonts.ready)
  for(const scene of ['active','needs-you','settled','empty','pending','failed','narrow']) {
   const frame=page.locator(`#teams-page-${scene}`)
   await expect(frame.locator('[data-slot="teams-page"]')).toBeVisible()
   if(scene==='pending')await expect(frame.getByText('Reading recorded usage…')).toBeVisible()
   if(scene==='failed')await expect(frame.getByText('The Team usage record could not be read')).toBeVisible()
   if(scene==='empty')await expect(frame.getByText('No active Teams')).toBeVisible()
   await frame.locator(':scope > div').screenshot({path:`output/playwright/teams-page/${scene}-${theme}.png`})
  }
  const active=page.locator('#teams-page-active')
  await active.getByRole('button',{name:'Ready to wrap · 2'}).click()
  await active.screenshot({path:`output/playwright/teams-page/ready-open-${theme}.png`})
  await active.locator('[data-team-row="team-4"]').getByRole('button',{name:'Hide',exact:true}).click()
  await active.screenshot({path:`output/playwright/teams-page/hidden-${theme}.png`})
 })
}
