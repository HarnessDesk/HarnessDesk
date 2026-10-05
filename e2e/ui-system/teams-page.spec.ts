import { expect, test, type Page } from '@playwright/test'

const openTeams=async(page:Page,theme:'light'|'dark')=>{
 await page.goto('/preview.html?teams-page')
 await page.locator('label').filter({hasText:/^theme/}).locator('select').first().selectOption(theme)
 await expect(page.locator('html')).toHaveCSS('color-scheme',theme)
}

for(const theme of ['light','dark'] as const) {
 test(`Teams page: the whole stack and remainder fit inside the table lead in ${theme}`,async({page})=>{
  await openTeams(page,theme)
  const row=page.locator('#teams-page-active [data-team-row="team-2"]')
  await expect(row.locator('[data-slot="avatar-stack"]')).toHaveAccessibleName('6 seats')
  await expect(row.locator('[data-slot="avatar-stack"] [data-shape="face"]')).toHaveCount(4)
  await expect(row.locator('[data-slot="avatar-stack"]')).toContainText('+2')
  expect(await row.evaluate(row=>{
   const lead=row.querySelector('[data-slot="table-cell-lead"]')!.getBoundingClientRect()
   const stack=row.querySelector('[data-slot="avatar-stack"]')!
   return [...stack.querySelectorAll('[data-shape="face"]'),stack.lastElementChild!].every(el=>{
    const box=el.getBoundingClientRect();return box.left>=lead.left-1&&box.right<=lead.right+1&&box.top>=lead.top-1&&box.bottom<=lead.bottom+1
   })
  })).toBe(true)
 })
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
  const hide=page.getByRole('menuitem',{name:'Hide',exact:true})
  await expect(hide).toBeVisible()
  // A nested menu must collide with its window, not the larger catalogue
  // viewport: a taller row can otherwise put Hide under the next window.
  await expect.poll(async()=>{
   const menu=await hide.boundingBox(),win=await frame.locator('[data-slot="app-window"]').boundingBox()
   return !!menu&&!!win&&menu.y>=win.y&&menu.y+menu.height<=win.y+win.height
  }).toBe(true)
  await expect.poll(()=>hide.evaluate(el=>{
   const box=el.getBoundingClientRect()
   return el.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2))
  })).toBe(true)
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
  expect(await attention.evaluate(e=>({fits:e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight,whiteSpace:getComputedStyle(e).whiteSpace}))).toEqual({fits:true,whiteSpace:'normal'})
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

for(const theme of ['light','dark'] as const) {
 test(`read and unread Teams keep the same name edge in ${theme}`,async({page})=>{
  await openTeams(page,theme)
  const rows=page.locator('#teams-page-active [data-team-row]')
  const first=rows.nth(0), second=rows.nth(1)
  const nameLeft=async(row:typeof first)=>(await row.locator('[data-role="subject"]').boundingBox())!.x
  const before=await nameLeft(first)
  await first.locator('[data-role="subject"]').click()
  await expect(first.locator('[aria-label="Unread changes"]')).toHaveCount(0)
  await expect(second.locator('[aria-label="Unread changes"]')).toBeVisible()
  expect(Math.abs(await nameLeft(first)-before)).toBeLessThan(1)
  expect(Math.abs(await nameLeft(first)-await nameLeft(second))).toBeLessThan(1)
 })
}

for(const theme of ['light','dark'] as const) {
 test(`Teams row buttons cover the readings and keep menu targets independent in ${theme}`,async({page})=>{
  await openTeams(page,theme)
  for(const scene of ['active','narrow']) {
   const row=page.locator(`#teams-page-${scene} [data-team-row="team-0"]`)
   const open=row.getByRole('button',{name:'Open Review the checkout retry',exact:true})
   await expect(open).toBeVisible()
   await expect(row).not.toHaveAttribute('tabindex')
   await expect(row.locator('[data-slot="list-row-trail"] > span:empty')).toHaveCount(0)
   await open.focus();await expect(open).toBeFocused()
   const point=await row.evaluate(e=>{
    const reading=e.querySelector('[data-slot="team-detail"]')!.getBoundingClientRect()
    const x=reading.x+reading.width/2,y=reading.y+reading.height/2
    return {x,y,button:document.elementFromPoint(x,y)?.closest('button')?.getAttribute('aria-label')}
   })
   expect(point.button).toBe('Open Review the checkout retry')
   await page.mouse.click(point.x,point.y)
   await expect(row.locator('[aria-label="Unread changes"]')).toHaveCount(0)
  }
 })
}
