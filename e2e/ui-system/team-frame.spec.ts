import { expect, test } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { FRAME } from '../../packages/ui/src/design/frame'
import { teamBar, teamSeats, selectTeamPage, closeTeamDetails } from './team-frame-actions'

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
  const team=page.locator('[data-frame-id="team-frame"]')
  await expect(team.getByRole('tab')).toHaveCount(5)
  await expect(team.locator('[data-slot="team-room"] aside')).toHaveCount(0)
  await expect(page.locator('[data-slot="workbench-rail"]')).toHaveCount(1)
  const header=teamBar(team)
  await expect(header.locator('[data-slot="avatar-stack"]')).toHaveCount(0)
  const seats=await teamSeats(team)
  await expect(seats.locator('[data-slot="icon-tile"][data-shape="face"]')).toHaveCount(2)
  await closeTeamDetails(team)
  await expect(header.getByRole('button',{name:'Wrap',exact:true})).toHaveCount(0)
  expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
  expect((await header.locator('[data-topbar-title]').boundingBox())!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
  await captureFrame(page, `after-frame-running-1440-${theme}`)
  await selectTeamPage(team,'room')
  await header.getByRole('button',{name:'View',exact:true}).click()
  await page.getByRole('menuitemradio',{name:'Side by side',exact:true}).click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await header.getByRole('button',{name:'View',exact:true}).click()
  await expect(page.getByRole('menuitemradio',{name:'Side by side',exact:true})).toHaveAttribute('aria-checked','true')
  await page.getByRole('menuitemradio',{name:'Thread',exact:true}).click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(0)
  await expect(header.locator('[data-team-page="room"]')).toHaveAttribute('data-active','')
  await header.getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('menuitem',{name:'Fill the window',exact:true})).toBeVisible()
 })
 test(`Team frame: folded destinations and tools stay reachable in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:720,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame&theme=${theme}`)
  const team=page.locator('[data-frame-id="team-frame"]')
  const header=teamBar(team)
  await expect(header.getByRole('button',{name:'Side by side',exact:true})).toBeHidden()
  await page.evaluate(async () => {await document.fonts.ready})
  await captureFrame(page,`after-frame-720-${theme}`)
  await header.getByRole('button',{name:'More',exact:true}).click()
  await expect(page.getByRole('switch',{name:'Hold messages at the board',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Open pull request',exact:true})).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(header.getByRole('button',{name:'More',exact:true})).toBeFocused()
  await selectTeamPage(team,'findings')
  await expect(team.locator('[data-slot="tool-pane"][aria-label="Findings"]')).toBeVisible()
  expect(await team.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  expect(await header.getByRole('button',{name:'More',exact:true}).evaluate(el=>{
   const box=el.getBoundingClientRect(); const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)
   return hit===el || el.contains(hit)
  })).toBe(true)
 })
 test(`Team frame: folded layout toggle reports its state in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:720,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const team=page.locator('[data-frame-id="team-frame"]')
  const header=teamBar(team)
  await selectTeamPage(team,'room')
  await header.getByRole('button',{name:'View',exact:true}).click()
  const toggle=page.getByRole('menuitemradio',{name:'Side by side',exact:true})
  await expect(toggle).toHaveAttribute('aria-checked','false')
  await toggle.click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(2)
  await header.getByRole('button',{name:'View',exact:true}).click()
  await expect(toggle).toHaveAttribute('aria-checked','true')
  await page.getByRole('menuitemradio',{name:'Thread',exact:true}).click()
  await expect(team.locator('[data-slot="side-by-side-tile"]')).toHaveCount(0)

 })
 test(`Team frame: More menu labels share one left edge in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:720,height:760})
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme','')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme','')
  const team=page.locator('[data-frame-id="team-frame"]')
  await teamBar(team).getByRole('button',{name:'More',exact:true}).click()
  const labelLeft = (role: 'switch' | 'menuitem', label: string) =>
   page.getByRole(role,{name:label,exact:true}).evaluate((row, label) => {
    const text = [...row.querySelectorAll('span')].find(span => span.textContent?.trim() === label)
    return text!.getBoundingClientRect().left
   }, label)
  const edges = await Promise.all([
   labelLeft('switch','Hold messages at the board'),
   labelLeft('menuitem','Open pull request'),
   labelLeft('menuitem','Wrap…'),
   labelLeft('menuitem','Fill the window'),
  ])
  expect(Math.max(...edges)-Math.min(...edges)).toBeLessThanOrEqual(1)
  await captureFrame(page, `after-controls-${theme}`)
 })
 test(`Team frame: Wrap is outlined on a ready Overview in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=ready&theme=${theme}`)
  const team=page.locator('[data-frame-id="team-frame"]')
  const wrap=team.locator('[data-slot="team-overview"]').getByRole('button',{name:'Wrap',exact:true})
  await expect(wrap).toBeVisible()
  await expect(wrap).toHaveAttribute('data-variant','outline')
  await expect(teamBar(team).getByRole('button',{name:'Wrap',exact:true})).toHaveCount(0)
 })
}


for (const theme of ['light','dark'] as const) {
 test(`Team frame: keyboard focus stays visible in tabs and the folded destination menu in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  for(const width of [1440,720]) {
   await page.setViewportSize({width,height:900})
   const frame=page.locator('[data-frame-id="team-frame"]')
   await selectTeamPage(frame,'overview')
   const bar=teamBar(frame)
   const tab=bar.locator('[data-team-page="overview"]:visible')
   let focused: import('@playwright/test').Locator
   if(await tab.count()) {
    await tab.focus()
    await page.keyboard.press('ArrowRight')
    focused=bar.locator('[data-team-page="run"]:visible')
   } else {
    const views=bar.getByTitle('Destination views',{exact:true})
    await views.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Home')
    focused=page.locator('[role="menu"] [data-team-page="overview"]:visible')
   }
   await expect(focused).toBeFocused()
   const ring=await focused.evaluate(node=>({width:parseFloat(getComputedStyle(node).outlineWidth),box:node.getBoundingClientRect().toJSON()}))
   expect(ring.width).toBeGreaterThan(0)
   expect(ring.box.x).toBeGreaterThanOrEqual(0)
   expect(ring.box.x+ring.box.width).toBeLessThanOrEqual(width)

  }
 })
 test(`Team frame: narrow members preserve faces and wrap work sentences in ${theme}`, async ({page}) => {
  await page.setViewportSize({width:720,height:760})
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const members=await teamSeats(page.locator('[data-frame-id="team-frame"]'))
  await expect(members.locator('[data-slot="icon-tile"][data-shape="face"]')).toHaveCount(2)
  for(const face of await members.locator('[data-slot="icon-tile"][data-shape="face"]').all()) expect((await face.boundingBox())!.width).toBeGreaterThanOrEqual(24)
  const subtitles=members.locator('[data-slot="list-row-subtitle"]')
  await expect(subtitles.first()).toBeVisible()
  for(const subtitle of await subtitles.all()) {
   const style=await subtitle.evaluate(node=>{
    const computed=getComputedStyle(node)
    return {space:computed.whiteSpace,overflow:computed.textOverflow}
   })
   expect(style).toEqual({space:'normal',overflow:'clip'})
  }
  await captureFrame(page,`after-members-720-${theme}`)
 })
}

test('the Team title uses the fixed shell width and stays inside the bar', async ({page}) => {
 await page.goto('/preview.html?team-frame=running')
 const header=teamBar(page.locator('[data-frame-id="team-frame"]'))
 await expect.poll(async()=>(await header.locator('[data-topbar-title]').boundingBox())?.width??0).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
 const bar=(await header.boundingBox())!, title=(await header.locator('[data-topbar-title]').boundingBox())!
 expect(title.x).toBeGreaterThanOrEqual(bar.x)
 expect(title.x+title.width).toBeLessThanOrEqual(bar.x+bar.width)
 expect((await header.locator('..').boundingBox())!.height).toBe(FRAME.bar.height)
})

for (const theme of ['light', 'dark'] as const) {
 test(`Team frame: header and page tabs share one row on every page in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
  const team=page.locator('[data-frame-id="team-frame"]')
  for (const name of ['overview', 'run', 'board', 'room', 'findings']) {
   await selectTeamPage(team,name)
   const header=teamBar(team)
   const title=(await header.locator('[data-topbar-title]').boundingBox())!
   const tab=header.locator('[data-team-page="overview"]:visible')
   const destination=await tab.count()?tab:header.getByTitle('Destination views',{exact:true})
   const box=(await destination.boundingBox())!
   expect(Math.abs(title.y+title.height/2-box.y-box.height/2),name).toBeLessThanOrEqual(1)
  }
 })

 test(`Team frame: Details Seats retain their bounded reading width in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  for (const width of [1440,720]) {
   await page.setViewportSize({width,height:900})
   await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
   const members=await teamSeats(page.locator('[data-frame-id="team-frame"]'))
   await expect(members).toBeVisible()
   const box=(await members.boundingBox())!
   if(width===1440) expect((await members.locator('xpath=ancestor::*[@data-slot="tool-body"]').boundingBox())!.width).toBe(FRAME.rightPanel.width)
   expect(box.x).toBeGreaterThanOrEqual(0)
   expect(box.x+box.width).toBeLessThanOrEqual(width)
   expect(await members.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
   await captureFrame(page,`after-members-${width}-${theme}`)
  }
 })
}

for(const theme of ['light','dark']) {
 test(`Team Agent work sentences wrap in a narrow content column in ${theme}`,async({page})=>{
  await page.setViewportSize({width:720,height:760})
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-overview&theme=${theme}`)
  const narrow=page.locator('#team-overview-narrow')
  for(const subtitle of await narrow.locator('[data-slot="team-overview"] [data-slot="list-row-subtitle"]').all()) {
   expect(await subtitle.evaluate(node=>getComputedStyle(node).whiteSpace)).toBe('normal')
   expect(await subtitle.evaluate(node=>getComputedStyle(node).textOverflow)).toBe('clip')
  }
  const work=narrow.locator('[data-slot="team-overview"] [data-slot="seat-doing"]').first()
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
  await page.setViewportSize({width:720,height:760})
  await page.emulateMedia({colorScheme:theme as 'light'|'dark'})
  await page.goto(`/preview.html?team-frame=controls&theme=${theme}`)
  await expect(page.getByRole('switch',{name:'Hold messages at the board',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Open pull request',exact:true})).toBeVisible()
  await expect(page.getByRole('menuitem',{name:'Fill the window',exact:true})).toBeVisible()
  await captureFrame(page,`after-controls-720-${theme}`)
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
