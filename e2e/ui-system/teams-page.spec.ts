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
  const chips=frame.locator('[data-team-row] [data-slot="chip"]')
  await expect(chips).toHaveCount(3)
  for(const chip of await chips.all())await expect(chip).toHaveAttribute('data-variant','default')
  for(const [id,turns] of [[0,21],[1,8],[2,137],[3,46],[4,92]])await expect(frame.locator(`[data-team-row="team-${id}"] td[data-align="end"]`).nth(1)).toHaveText(String(turns))
  await expect(frame.locator('[data-team-row="team-3"] [data-slot="team-detail"]')).toHaveText('Review accepted the invoice rounding change.')
  await expect(frame.locator('[data-team-row="team-4"] [data-slot="team-detail"]')).toHaveCount(0)
  const ready=frame.locator('[data-team-row="team-3"]')
  await ready.getByTitle('More',{exact:true}).click()
  await page.getByRole('menuitem',{name:'Hide',exact:true}).click()
  await expect(frame.locator('[data-team-row]')).toHaveCount(4)
  await frame.getByRole('button',{name:'Settled',exact:true}).click()
  await expect(frame.locator('[data-team-row]')).toHaveCount(2)
  await frame.locator('[data-team-row="team-3"]').getByTitle('More',{exact:true}).click()
  await expect(page.getByRole('menuitem',{name:'Show in Active'})).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(()=>document.fonts.ready)
  for(const row of await frame.locator('[data-team-row]').all()) {
   await expect(row.locator('[data-shape="face"]')).toHaveCount(2)
   expect(await row.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true)
  }
  const attention=page.locator('#teams-page-needs-you [data-team-row="team-0"] [data-slot="team-detail"]')
  await expect(attention).toHaveCSS('white-space','nowrap')
  await expect(attention).toHaveAttribute('title',/choose whether to keep the original payment method/)
 })
 test(`Teams page: 375px and 720px keep navigation and all readings inside the page in ${theme}`,async({page})=>{
  for(const width of [375,720]) {
   await page.setViewportSize({width,height:900})
   await openTeams(page,theme)
   const frame=page.locator('#teams-page-active')
   const pageBox=frame.locator('[data-slot="teams-page"]')
   await expect(pageBox).toBeVisible()
   if((await pageBox.boundingBox())!.width<600){
    await expect(pageBox).toHaveAttribute('data-layout','narrow')
    await expect(frame.locator('[data-team-row][data-slot="list-row"]')).toHaveCount(3)
   }
   for(const item of await frame.locator('[data-slot="app-window"], [data-slot="app-window-page"], [data-team-row]').all()) {
    expect(await item.evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true)
   }
   await expect(frame.getByRole('button',{name:'Needs you',exact:true})).toBeVisible()
   const filters=await Promise.all(['Active','Needs you','Settled'].map(name=>frame.getByRole('button',{name,exact:true}).boundingBox()))
   expect(filters.every(box=>box!==null)).toBe(true)
   const inOneRow=filters.every(box=>Math.abs(box!.y-filters[0]!.y)<1)
   const inOneColumn=filters.every(box=>Math.abs(box!.x-filters[0]!.x)<1)
   expect(inOneRow||inOneColumn,`filters at ${width}px: ${JSON.stringify(filters)}`).toBe(true)
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
   const pageBox=frame.locator('[data-slot="teams-page"]')
   await expect(pageBox).toBeVisible()
   if((await pageBox.boundingBox())!.width<600){
    await expect(pageBox).toHaveAttribute('data-layout','narrow')
    await expect(frame.locator('[data-team-row][data-slot="list-row"]')).toHaveCount(3)
   }
   if(scene==='pending')await expect(frame.getByText('Reading recorded usage…')).toBeVisible()
   if(scene==='failed')await expect(frame.getByText('The Team usage record could not be read')).toBeVisible()
   if(scene==='empty')await expect(frame.getByText('No active Teams')).toBeVisible()
   await frame.locator(':scope > div').screenshot({path:`output/playwright/teams-page/${scene}-${theme}.png`})
  }
  const active=page.locator('#teams-page-active')
  await active.getByRole('button',{name:'Ready to wrap · 2'}).click()
  await active.screenshot({path:`output/playwright/teams-page/ready-open-${theme}.png`})
  await active.locator('[data-team-row="team-4"]').getByTitle('More',{exact:true}).click()
  await page.getByRole('menuitem',{name:'Hide',exact:true}).click()
  await active.screenshot({path:`output/playwright/teams-page/hidden-${theme}.png`})
 })
}

for (const theme of ['light','dark'] as const) {
 test(`unread Team title and detail share one edge in ${theme}`,async({page})=>{
  await page.goto(`/preview.html?teams-page&theme=${theme}`)
  for(const width of [1440,720]) {
   await page.setViewportSize({width,height:1000})
   const row=page.locator('#teams-page-active [data-team-row]').first()
   const delta=await row.evaluate(el=>{
    const title=el.querySelector('[data-role="subject"]')!
    const detail=el.querySelector('[data-slot="team-detail"]')!
    const a=document.createRange(),b=document.createRange();a.selectNodeContents(title);b.selectNodeContents(detail)
    return Math.abs(a.getClientRects()[0]!.left-b.getClientRects()[0]!.left)
   })
   expect(delta).toBeLessThan(1)
   await expect(row.locator('[aria-label="Unread changes"]')).toBeVisible()
  }
 })
}
