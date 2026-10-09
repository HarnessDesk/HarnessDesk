import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const captureFrame = async (page: import('@playwright/test').Page, name: string) => {
 const directory = process.env.TEAM_FRAME_SHOTS_DIR
 if (!directory) return
 if(name.endsWith('-dark')) await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
 else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
 await page.evaluate(async()=>{await document.fonts.ready})
 mkdirSync(directory, {recursive:true})
 await page.screenshot({path:`${directory}/${name}.png`})
}

for (const theme of ['light','dark'] as const) {
 test(`Team frame: one sidebar, segmented tabs and a reversible layout toggle in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:1440,height:900})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
  const team=page.locator('[data-slot="team-room"]')
  await expect(team.getByRole('tab')).toHaveCount(6)
  await expect(team.locator('aside')).toHaveCount(0)
  await expect(page.locator('[data-slot="workbench-rail"]')).toHaveCount(1)
  const header=team.locator('header').first()
  await expect(header.locator('[data-slot="avatar-stack"]')).toHaveCount(1)
  await expect(header.locator('[data-slot="avatar"][data-shape="face"]')).toHaveCount(2)
  await expect(header.getByRole('button',{name:'Wrap',exact:true})).toHaveCount(0)
  await expect(header.getByRole('button',{name:'Pull request #7',exact:true})).toBeVisible()
  const aligned = await team.evaluate(el => {
   const card = el.querySelector('[data-slot="team-overview"] [data-slot="card"]')!.getBoundingClientRect()
   const title = el.querySelector('[data-team-title]')!
   const range = document.createRange(); range.selectNodeContents(title.firstChild!)
   return Math.abs(card.left - range.getBoundingClientRect().left)
  })
  expect(aligned).toBeLessThan(2)
  await page.evaluate(async () => { await document.fonts.ready })
  await captureFrame(page, `after-frame-running-1440-${theme}`)
  await team.getByRole('tab',{name:/^Board/}).click()
  const toggle=header.getByRole('button',{name:'Side by side',exact:true})
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed','true')
  await expect(team.getByRole('tab',{name:'Side by side',exact:true})).toHaveAttribute('aria-selected','true')
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed','false')
  await expect(team.locator('[data-slot="board"]')).toBeVisible()
  await header.getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('menuitem',{name:'Fill the window',exact:true})).toBeVisible()
 })
 test(`Team frame: folded tools and icon tabs stay reachable in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:320,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame&theme=${theme}`)
  const team=page.locator('[data-slot="team-room"]')
  const header=team.locator('header').first()
  await expect(header.getByRole('button',{name:'Side by side',exact:true})).toBeHidden()
  await page.evaluate(async () => {await document.fonts.ready})
  await captureFrame(page,`after-frame-320-${theme}`)
  await header.getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('switch',{name:'Side by side',exact:true})).toBeVisible()
  await expect(page.getByRole('switch',{name:'Hold messages at the board',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Pull request #7',exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(header.getByRole('button',{name:'More',exact:true})).toBeFocused()
  const overview=team.getByRole('tab',{name:/^Overview/})
  await overview.focus()
  await page.keyboard.press('End')
  await expect(team.getByRole('tab',{name:'Side by side',exact:true})).toBeFocused()
  await page.keyboard.press('ArrowLeft')
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
 test(`Team frame: Wrap is outlined on a ready Overview in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=ready&theme=${theme}`)
  const team=page.locator('[data-slot="team-room"]')
  const wrap=team.locator('[data-slot="team-overview"]').getByRole('button',{name:'Wrap',exact:true})
  await expect(wrap).toBeVisible()
  await expect(wrap).toHaveAttribute('data-variant','outline')
  await expect(team.locator('header').first().getByRole('button',{name:'Wrap',exact:true})).toHaveCount(0)
 })
}


for (const theme of ['light','dark'] as const) {
 test(`Team frame: keyboard focus stays inside its scrolling tab strip in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  for(const width of [1440,320]) {
   await page.setViewportSize({width,height:900})
   const tab=page.locator('[data-team-page="overview"]')
   await tab.focus()
   await page.keyboard.press('ArrowRight')
   const focused=page.locator('[data-team-page="run"]')
   await expect(focused).toBeFocused()
   const ring=await focused.evaluate(node=>{
    const style=getComputedStyle(node)
    return {width:parseFloat(style.outlineWidth),offset:parseFloat(style.outlineOffset)}
   })
   expect(ring.width).toBeGreaterThan(0)
   expect(ring.offset).toBeLessThanOrEqual(-ring.width)
  }
 })
 test(`Team frame: narrow members preserve faces and wrap work sentences in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:320,height:760})
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const trigger=page.getByRole('button',{name:'Team members',exact:true})
  expect((await trigger.boundingBox())!.width).toBeGreaterThanOrEqual(24)
  await expect(trigger.locator('[data-slot="avatar-stack"]')).toBeVisible()
  await expect(trigger.locator('[data-team-members-count]')).toBeHidden()
  await trigger.click()
  const members=page.locator('[data-slot="team-members"]')
  const subtitles=members.locator('[data-slot="list-row-subtitle"]')
  await expect(subtitles.first()).toBeVisible()
  for(const subtitle of await subtitles.all()) {
   const style=await subtitle.evaluate(node=>{
    const computed=getComputedStyle(node)
    return {space:computed.whiteSpace,overflow:computed.textOverflow}
   })
   expect(style).toEqual({space:'normal',overflow:'clip'})
  }
  await captureFrame(page,`after-members-320-${theme}`)
 })
}

test('the Team title shares the content column edge', async ({page}) => {
 await page.goto('/preview.html?team-frame=running')
 const edges=await page.locator('[data-slot="team-room"]').evaluate(el=>{
  const card=el.querySelector('[data-slot="team-overview"] [data-slot="card"]')!
  const title=el.querySelector('[data-team-title]')!
  const range=document.createRange();range.selectNodeContents(title.firstChild!)
  return {card:card.getBoundingClientRect().left,label:range.getBoundingClientRect().left}
 })
 expect(Math.abs(edges.card-edges.label)).toBeLessThanOrEqual(1)
})

for (const theme of ['light', 'dark'] as const) {
 test(`Team frame: header and page tabs share one row on every page in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const team=page.locator('[data-slot="team-room"]')
  for (const name of ['overview', 'run', 'board', 'room', 'findings']) {
   await team.locator(`[data-team-page="${name}"]`).click()
   const edges=await team.evaluate(el=>{
    const title=el.querySelector('header [data-role="subject"]')!
    const tab=el.querySelector('[data-team-page="overview"]')!
    const a=title.getBoundingClientRect(),b=tab.getBoundingClientRect()
    return {title:a.top+a.height/2,tab:b.top+b.height/2}
   })
   expect(Math.abs(edges.title-edges.tab),name).toBeLessThanOrEqual(1)
  }
 })

 test(`Team frame: portalled members retain their own width in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  for (const width of [1440,320]) {
   await page.setViewportSize({width,height:900})
   await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
   await page.getByRole('button',{name:'Team members',exact:true}).click()
   const members=page.locator('[data-slot="team-members"]')
   await expect(members).toBeVisible()
   const box=(await members.boundingBox())!
   expect(box.width).toBe(232)
   expect(box.x).toBeGreaterThanOrEqual(0)
   expect(box.x+box.width).toBeLessThanOrEqual(width)
   expect(await members.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
   await captureFrame(page,`after-members-${width}-${theme}`)
  }
 })
}

for(const theme of ['light','dark']) {
 test(`Team Agent work sentences wrap at 320px in ${theme}`,async({page})=>{
  await page.setViewportSize({width:320,height:760})
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  for(const subtitle of await page.locator('[data-slot="team-overview"] [data-slot="list-row-subtitle"]').all()) {
   expect(await subtitle.evaluate(node=>getComputedStyle(node).whiteSpace)).toBe('normal')
   expect(await subtitle.evaluate(node=>getComputedStyle(node).textOverflow)).toBe('clip')
  }
  const work=page.locator('[data-slot="team-overview"] [data-slot="seat-doing"]').first()
  await expect(work).toBeVisible()
  await work.evaluate(node=>{node.textContent='Edited the checkout error message and checked the retry budget before sending the review.'})
  const geometry=await work.evaluate(node=>{
   const range=document.createRange();range.selectNodeContents(node)
   return {lines:range.getClientRects().length,space:getComputedStyle(node).whiteSpace,overflow:node.scrollWidth>node.clientWidth,width:node.getBoundingClientRect().width}
  })
  expect(geometry.width).toBeGreaterThanOrEqual(128)
  expect(geometry.space).toBe('normal')
  expect(geometry.lines).toBeGreaterThan(1)
  expect(geometry.overflow).toBe(false)
 })
}

for (const theme of ['light','dark'] as const) {
 test(`Team frame: narrow mounted More menu is held open in ${theme}`,async({page})=>{
  await page.setViewportSize({width:380,height:760})
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=controls&theme=${theme}`)
  await expect(page.getByRole('switch',{name:'Side by side',exact:true})).toBeVisible()
  await expect(page.getByRole('switch',{name:'Hold messages at the board',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Pull request #7',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Fill the window',exact:true})).toBeVisible()
  await captureFrame(page,`after-controls-380-${theme}`)
 })
}


for(const theme of ['light','dark'] as const) {
 test(`Team frame: the attention scene matches the before frame in ${theme}`,async({page})=>{
  await page.setViewportSize({width:1440,height:900})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=needs-you&theme=${theme}`)
  await expect(page.locator('[data-slot="team-overview"]').getByRole('button',{name:'Answer in the conversation',exact:true})).toBeVisible()
  await captureFrame(page,`after-frame-1440-${theme}`)
 })
}
