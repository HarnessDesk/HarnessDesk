import { expect, test, type Locator } from '@playwright/test'

for (const theme of ['light','dark'] as const) {
 test(`Wrapped Team: receipt, rail, conversations and Run stay readable in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-wrapped')
  await expect(frame.getByText('As recorded when wrapped',{exact:true})).toBeVisible()
  const rail=frame.locator('aside')
  await expect(rail.locator('[data-slot="list-row"]').filter({hasText:'Alpha'})).toBeVisible()
  await expect(rail.locator('[data-slot="list-row"]').filter({hasText:'Beta'})).toBeVisible()
  for (const name of ['Seat an Agent in this Goal','Hold messages at the board']) {
   await expect(frame.getByRole('button',{name,exact:true})).toBeDisabled()
   await expect(frame.getByRole('button',{name,exact:true})).toHaveAttribute('title','This Team is wrapped')
  }
  await rail.getByRole('button',{name:/^Run/}).click()
  await expect(frame.locator('[data-slot="run-view"]')).toContainText('Build and review')
  await rail.locator('[data-slot="list-row"]').filter({hasText:'Alpha'}).click()
  await expect(frame.locator('textarea[data-slot="composer-text"]')).toBeDisabled()
  await expect(frame.locator('textarea[data-slot="composer-text"]')).toHaveAttribute('placeholder','This Team is wrapped')
  await expect(frame.locator('[data-slot="composer-send"]')).toBeDisabled()
  await expect(frame.getByRole('button',{name:'Ask the agent to try again',exact:true})).toBeDisabled()
  await expect(frame.getByRole('button',{name:'Ask the agent to try again',exact:true})).toHaveAttribute('title','This Team is wrapped')
  const older=page.locator('#team-record-older')
  await expect(older.locator('aside')).toContainText('Gamma')
  await expect(older.locator('aside')).toContainText('Conversation not kept')
  const missing=older.locator('aside [data-slot="list-row"]').filter({hasText:'Gamma'})
  await expect(missing.getByRole('button')).toHaveCount(0)
  await older.locator('aside').getByRole('button',{name:'Overview',exact:true}).click()
  await expect(older.locator('[data-slot="team-overview"]')).toContainText('Gamma')
  await expect(older.locator('[data-slot="team-overview"]')).toContainText('Conversation not kept')
  await expect(older.locator('[data-slot="team-overview"]').getByRole('button',{name:'Gamma',exact:true})).toHaveCount(0)
 })
 test(`Wrapped Team: a conversation seated twice is one row, and Seats with no conversation are still listed in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const rows=(scene:string)=>page.locator(`#team-record-${scene} aside [data-slot="list-row"]`)
  for (const name of ['Alpha','Beta']) await expect(rows('shared').filter({hasText:name})).toHaveCount(1)
  for (const name of ['Alpha','Beta']) {
   const row=rows('unlinked').filter({hasText:name})
   await expect(row).toContainText('Conversation not kept')
   await expect(row.getByRole('button')).toHaveCount(0)
  }
  await expect(page.locator('#team-record-unlinked aside')).not.toContainText('No Agents were kept')
  await expect(page.locator('#team-record-empty aside')).toContainText('No Agents were kept')
  const sidebar=page.locator('#team-record-sidebar-shared')
  await expect(sidebar.getByRole('button',{name:'Wrapped · 1',exact:true})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Writer conversation'})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Reviewer conversation'})).toHaveCount(0)
 })
 test(`Wrapped Team: a question open when the Run ends keeps its place with its final action off in ${theme}`, async ({page}) => {
  const reason='This Team is wrapped'
  const dialog=page.locator('[data-slot="dialog-content"]')
  const board=async(open:Locator)=>{ await open.locator('aside').getByRole('button',{name:/^Board/}).click() }
  const cases:{name:string,action:string,ask:(open:Locator)=>Promise<void>}[]=[
   {name:'seating an Agent',action:'Seat Agent',ask:async open=>{ await open.getByRole('button',{name:'Seat an Agent in this Goal',exact:true}).click() }},
   {name:'adding work',action:'Add to board',ask:async open=>{ await board(open); await open.getByRole('button',{name:/^New job/}).click(); await dialog.getByLabel('What needs doing').fill('Check the retry budget') }},
   {name:'stopping a card',action:'Stop it',ask:async open=>{ await board(open); await open.getByRole('button',{name:'What to do with #1',exact:true}).click(); await page.getByRole('menuitem',{name:/^Stop it/}).click() }},
  ]
  for (const one of cases) {
   await page.goto(`/preview.html?team-record&theme=${theme}`)
   await one.ask(page.locator('#team-record-open'))
   const action=dialog.getByRole('button',{name:one.action,exact:true})
   await expect(action,`${one.name} is offered while the Team is open`).toBeEnabled()
   await page.evaluate(()=>(window as unknown as {__hdWrapOpenTeam:()=>void}).__hdWrapOpenTeam())
   await expect(action,`${one.name} is refused once the Team has wrapped`).toBeDisabled()
   await expect(action).toHaveAttribute('title',reason)
   await expect(dialog).toContainText(reason)
   await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
   await expect(dialog).toHaveCount(0)
  }
 })
 test(`Wrapped Team: a kept conversation's menus refuse compaction and review, and say why, in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-wrapped')
  await frame.locator('aside [data-slot="list-row"]').filter({hasText:'Alpha'}).click()
  await frame.locator('header button[aria-label="Conversation"]').click()
  const compact=page.locator('button',{hasText:'Compact now'})
  await expect(compact).toBeDisabled()
  await expect(compact).toHaveAttribute('title','This Team is wrapped')
  await expect(compact).toContainText('This Team is wrapped')
  await page.keyboard.press('Escape')
  await frame.locator('button:has-text("storefront")').first().click()
  const review=page.locator('[role="menuitem"]',{hasText:'Review uncommitted changes'})
  await expect(review).toHaveAttribute('aria-disabled','true')
  await expect(review).toHaveAttribute('title','This Team is wrapped')
 })
 test(`Wrapped Team: sidebar leaves retained conversations and unlinked Seats on Teams in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const sidebar=page.locator('#team-record-sidebar')
  await expect(sidebar.getByRole('button',{name:'Wrapped · 1',exact:true})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Writer conversation'})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Reviewer conversation'})).toHaveCount(0)
  await expect(sidebar.getByRole('button',{name:'Gamma',exact:true})).toHaveCount(0)
 })
 test(`Wrapped Team: narrow rail and receipt stay inside their frame in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-narrow')
  await frame.getByRole('button',{name:'Agents',exact:true}).click()
  await expect(frame.locator('aside [data-slot="list-row"]').filter({hasText:'Alpha'})).toBeVisible()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await frame.locator('aside').getByRole('button',{name:'Receipt',exact:true}).click()
  await expect(frame.getByText('As recorded when wrapped',{exact:true})).toBeVisible()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
 })
 /* A narrow room shows one half at a time. A wrapped Team opens on its Receipt, so the Receipt is the half that shows
    — for a Team a person made, which never had a Run, as much as for one a Run wrapped. The Agents list is one tap
    behind it, not in front of it (#1317). */
 test(`Wrapped Team: a Team that never had a Run opens on its Receipt in a narrow pane in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-person')
  await expect(frame.getByText('As recorded when wrapped',{exact:true})).toBeVisible()
  await expect(frame.locator('aside')).toBeHidden()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await frame.getByRole('button',{name:'Agents',exact:true}).click()
  await expect(frame.locator('aside [data-slot="list-row"]').filter({hasText:'Alpha'})).toBeVisible()
  await expect(frame.getByText('As recorded when wrapped',{exact:true})).toBeHidden()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
 })
 test(`Wrapped Team: the sidebar leaves Seats with no conversation on Teams in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const sidebar=page.locator('#team-record-sidebar-unlinked')
  await expect(sidebar.getByRole('button',{name:'Wrapped · 1',exact:true})).toHaveCount(0)
  await expect(sidebar.locator('ul[data-nested="true"]')).toHaveCount(0)
  for (const name of ['Alpha','Beta']) await expect(sidebar.getByRole('button',{name,exact:true})).toHaveCount(0)
 })
}
