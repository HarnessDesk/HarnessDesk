import { expect, test, type Locator } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { closeTeamDetails, seatActions, selectTeamPage, teamBar, teamSeats } from './team-frame-actions'

const members = teamSeats

for (const theme of ['light','dark'] as const) {
 {

for (const [item0, scene] of (['wrapped','older','shared','unlinked','empty','narrow','person','running']).entries()) test((`Wrapped Team: the shell title and receipt keep their own measured edges in ${theme}`) + ' [item ' + [item0].join('-') + ']', async ({page}) => {
await page.emulateMedia({colorScheme:theme})
await page.goto(`/preview.html?team-record&theme=${theme}`)
const frame=page.locator(`#team-record-${scene}`)
const bar=teamBar(frame)
const title=bar.locator('[data-topbar-title]')
const heading=frame.locator('[data-slot="goal-receipt"] [data-slot="section-name"]').first()
await expect(heading).toBeVisible()
const titleBox=await title.boundingBox()
const barBox=(await bar.locator('..').boundingBox())!
expect(titleBox,`${scene}: the pane title is visible`).not.toBeNull()
expect(titleBox!.width).toBeGreaterThanOrEqual(FRAME.bar.titleMin)
expect(barBox.height).toBe(FRAME.bar.height)
expect(titleBox!.x).toBeGreaterThanOrEqual(barBox.x)
expect(titleBox!.x+titleBox!.width).toBeLessThanOrEqual(barBox.x+barBox.width)
expect((await heading.boundingBox())!.width).toBeGreaterThan(0)


})
}
 test(`Wrapped Team: Tab and Enter or Space open retained conversations in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-wrapped')
  for (const [name,key] of [['Alpha','Enter'],['Beta','Space']]) {
   const actions=await seatActions(frame,name!)
   const destination=actions.getByRole('menuitem',{name:/^Open conversation(?:\s|$)/})
   await expect(destination).toHaveCount(1)
   await destination.focus()
   await expect(destination).toBeFocused()
   await page.keyboard.press(key!)
   await expect(frame.locator('textarea[data-slot="composer-text"]')).toBeDisabled()
   await expect((await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:`Actions for ${name}`,exact:true})})).toHaveAttribute('aria-current','true')
   await closeTeamDetails(frame)
   await expect(frame.locator('textarea[data-slot="composer-text"]')).toBeDisabled()
  }
 })
 test(`Wrapped Team: three Cost breakdowns, speaker faces and the reading inset align in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-wrapped')
  const cost=frame.getByRole('region',{name:'Cost',exact:true})
  await expect(cost.getByRole('tab')).toHaveCount(3)
  const measure=await frame.evaluate(el=>{
   const box=(node:Element)=>node.getBoundingClientRect()
   const column=el.querySelector('[data-inset="reading"]')!
   const summary=el.querySelector('[data-slot="goal-receipt"] [data-section-head]')!
   const cost=el.querySelector('section[aria-label="Cost"]')!
   const heading=cost.querySelector('[data-slot="section-name"]')!
   const title=[...cost.querySelectorAll('[data-slot="key-value-row"] dt')].find(node=>node.textContent==='Alpha')!
   const answer=[...el.querySelectorAll('[data-slot="goal-receipt"] [data-slot="row"]')].find(node=>node.textContent?.includes('The change was checked'))!
   return {top:box(summary).top-box(column).top, cost:box(heading).left-box(title).left,
    answerMark:answer.querySelector('[data-slot="row-mark"]')!==null,
    answerLeft:box(answer.querySelector('[data-slot="member-name"] [data-role="member"]')!).left-box(answer.querySelector('[data-slot="member-description"]')!).left}
  })
  expect(measure.top).toBe(24)
  expect(Math.abs(measure.cost)).toBeLessThan(2)
  expect(measure.answerMark).toBe(false)
  expect(measure.answerLeft).toBe(0)
  for (const name of ['Alpha','Beta']) {
   const face=(await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:`Actions for ${name}`,exact:true})}).locator('[data-slot="icon-tile"]')
   const receiptFaces=frame.locator('[data-slot="goal-receipt"] [data-slot="member-name"]').filter({hasText:name}).locator('[data-slot="icon-tile"]')
   await expect(receiptFaces).toHaveCount(2)
   for (const one of await receiptFaces.all()) {
    expect(await one.getAttribute('data-tint')).toBe(await face.getAttribute('data-tint'))
    expect(await one.locator('svg').innerHTML()).toBe(await face.locator('svg').innerHTML())
   }
  }
 })
 test(`Wrapped Team: receipt, members, conversations and Run stay readable in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  else await expect(page.locator('body')).not.toHaveAttribute('data-hd-dark-theme')
  const frame=page.locator('#team-record-wrapped')
  await expect(frame.getByText('What finished',{exact:true})).toBeVisible()
  const rail=await members(frame)
  await expect(frame.getByRole('button', {name: 'Wrap', exact: true})).toHaveCount(0)
  await expect(rail).not.toContainText('Side by side')
  await expect(rail).not.toContainText('unclaimed')
  await expect(rail.locator('[data-slot="member-done"]')).toHaveCount(0)
  const receipt = frame.locator('[data-slot="goal-receipt"]')
  await expect(receipt).toContainText('Retry the checkout call')
  await expect(receipt).toContainText('Review the change')
  const geometry = await receipt.evaluate(node => {
   const column = node.closest('[data-inset="reading"]')!
   const parent = column.parentElement!
   const rect = node.getBoundingClientRect()
   const outer = parent.getBoundingClientRect()
   const aligned = [...node.querySelectorAll('[data-section-head]')].every(head => {
    const group = head.nextElementSibling!
    const content = group.querySelector('[data-slot="row-mark"], [data-slot="row-title"], dt')
    if (!content) return true
    const heading = head.querySelector('[data-slot="section-name"]')!
    const item = content.closest('[data-slot="row"], [data-slot="summary-item"]')
    const bodyInset = item ? parseFloat(getComputedStyle(item).paddingLeft) + parseFloat(getComputedStyle(item).borderLeftWidth) : 0
    return Math.abs(heading.getBoundingClientRect().left - head.parentElement!.getBoundingClientRect().left) < 2
      && Math.abs(content.getBoundingClientRect().left - (item ?? group).getBoundingClientRect().left - bodyInset) < 2
   })
   return { left: rect.left - outer.left, right: outer.right - rect.right, aligned }
  })
  expect(geometry.left).toBeGreaterThan(0)
  expect(geometry.right).toBeGreaterThan(0)
  expect(geometry.aligned).toBe(true)
  for (const name of ['Alpha', 'Beta']) {
   const title = rail.locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:`Actions for ${name}`,exact:true})}).locator('[data-slot="list-row-title"]')
   expect(await title.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true)
   await expect(title).not.toContainText('conversation')
  }
  await expect(rail.locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})})).toBeVisible()
  await expect(rail.locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Beta',exact:true})})).toBeVisible()
  await expect(rail.getByRole('button',{name:'Seat an Agent in this Team',exact:true})).toBeDisabled()
  await expect(rail.getByRole('button',{name:'Seat an Agent in this Team',exact:true})).toHaveAttribute('title','This Team is wrapped')
  await closeTeamDetails(frame)
  await selectTeamPage(frame,'room')
  await frame.getByRole('button',{name:'Send to',exact:true}).click()
  {
   const hold=page.getByRole('switch',{name:/^Board-only(?:\s|$)/})
   await expect(hold).toHaveAttribute('aria-disabled','true')
   await expect(hold).toHaveAttribute('title','This Team is wrapped')
   await expect(hold).toContainText('This Team is wrapped')
  }
  await page.keyboard.press('Escape')
  await selectTeamPage(frame,'run')
  await members(frame)
  await expect(frame.locator('[data-slot="tool-body"]:visible [aria-label="Team Run facts"]')).toContainText('Build and review')
  await (await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})}).click()
  await expect(frame.locator('textarea[data-slot="composer-text"]')).toBeDisabled()
  await expect(frame.locator('textarea[data-slot="composer-text"]')).toHaveAttribute('placeholder','This Team is wrapped')
  await expect(frame.locator('[data-slot="composer-send"]')).toBeDisabled()
  await expect(frame.getByRole('button',{name:'Ask the agent to try again',exact:true})).toBeDisabled()
  await expect(frame.getByRole('button',{name:'Ask the agent to try again',exact:true})).toHaveAttribute('title','This Team is wrapped')
  const older=page.locator('#team-record-older')
  await expect((await members(older))).toContainText('Gamma')
  await expect((await members(older)).locator('[title="Conversation not kept"]')).toHaveCount(1)
  const missing=(await members(older)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Gamma',exact:true})})
  await (await members(older)).getByRole('button',{name:'Actions for Gamma',exact:true}).click()
  const missingOpen=page.getByRole('menuitem',{name:/^Open conversation(?:\s|$)/})
  await expect(missingOpen).toHaveAttribute('aria-disabled','true')
  await expect(missingOpen).toHaveAttribute('title','Conversation not kept')
  await expect(missingOpen).toContainText('Conversation not kept')
  await page.keyboard.press('Escape')
  await closeTeamDetails(older)
  await selectTeamPage(older,'overview')
  await expect(older.locator('[data-slot="team-overview"]')).toContainText('Gamma')
  await expect(older.locator('[data-slot="team-overview"]')).toContainText('Conversation not kept')
  await expect(older.locator('[data-slot="team-overview"]').getByRole('button',{name:'Gamma',exact:true})).toHaveCount(0)
 })
 test(`Wrapped Team: a conversation seated twice is one row, and Seats with no conversation are still listed in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const rows=async(scene:string)=>(await members(page.locator(`#team-record-${scene}`))).locator('[data-slot="list-row"]')
  for (const name of ['Alpha','Beta']) await expect((await rows('shared')).filter({has:page.getByRole('button',{name:`Actions for ${name}`,exact:true})})).toHaveCount(1)
  for (const name of ['Alpha','Beta']) {
   const row=(await rows('unlinked')).filter({has:page.getByRole('button',{name:`Actions for ${name}`,exact:true})})
   await expect(row.locator('[title="Conversation not kept"]')).toHaveCount(1)
   const menu=await seatActions(page.locator('#team-record-unlinked'),name)
   await expect(menu.getByRole('menuitem',{name:/^Open conversation(?:\s|$)/})).toHaveAttribute('aria-disabled','true')
   await expect(menu.getByRole('menuitem',{name:/^Open conversation(?:\s|$)/})).toHaveAttribute('title','Conversation not kept')
   await expect(menu.getByRole('menuitem',{name:/^Open conversation(?:\s|$)/})).toContainText('Conversation not kept')
   await page.keyboard.press('Escape')
  }
  await expect((await members(page.locator('#team-record-unlinked')))).not.toContainText('No Agents were kept')
  await expect((await members(page.locator('#team-record-empty')))).toContainText('No Agents were kept')
  const sidebar=page.locator('#team-record-sidebar-shared')
  await expect(sidebar.getByRole('button',{name:'Wrapped · 1',exact:true})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Writer conversation'})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Reviewer conversation'})).toHaveCount(0)
 })
 {

for (const [item0, [row,cost]] of ([['card-2-2','$0.21'],['card-3-3','$0.13']]).entries()) test((`Wrapped Team: Run detail keeps repeated Seats and unlinked usage in ${theme}`) + ' [item ' + [item0].join('-') + ']', async ({page}) => {
await page.emulateMedia({ colorScheme: theme })
await page.goto(`/preview.html?team-record&theme=${theme}`)
const shared=page.locator('#team-record-shared')
await selectTeamPage(shared,'run')
const inspector=shared.locator('[data-slot="run-inspector"]')
await expect(inspector).toHaveCount(0)
await shared.locator(`[data-step-row][data-row="${row}"]`).click()
await expect(inspector).toContainText(cost)
await expect(inspector).not.toContainText('Seat not recorded')
await expect(inspector.getByRole('button',{name:'Open the conversation',exact:true})).toBeVisible()

const unlinked=page.locator('#team-record-unlinked')
await selectTeamPage(unlinked,'run')
await unlinked.locator('[data-step-row][data-row="card-2-2"]').click()
await expect(unlinked.locator('[data-slot="run-inspector"]')).toContainText('$0.21')
await expect(unlinked.locator('[data-slot="run-inspector"]')).toContainText('Conversation not kept')
await expect(unlinked.getByRole('button',{name:'Open the conversation',exact:true})).toHaveCount(0)
})
}
 {

const questionCases = (page?: import('@playwright/test').Page) => {
const dialog=page?.locator('[data-slot="dialog-content"]')!
const board=async(open:Locator)=>{ await selectTeamPage(open,'board') }
return [
   {name:'seating an Agent',action:'Seat Agent',ask:async open=>{ await (await members(open)).getByRole('button',{name:'Seat an Agent in this Team',exact:true}).click() }},
   {name:'adding work',action:'Add to board',ask:async open=>{ await board(open); await open.getByRole('button',{name:/^New job/}).click(); await dialog.getByLabel('What needs doing').fill('Check the retry budget') }},
   {name:'stopping a card',action:'Stop it',ask:async open=>{ await board(open); await open.getByRole('button',{name:'What to do with #1',exact:true}).click(); await page.getByRole('menuitem',{name:/^Stop it/}).click() }},
  ]
}
for (const [item0, one] of questionCases().entries()) test((`Wrapped Team: a question open when the Run ends keeps its place with its final action off in ${theme}`) + ' [item ' + [item0].join('-') + ']', async ({page}) => {
const reason='This Team is wrapped'
const dialog=page.locator('[data-slot="dialog-content"]')
const board=async(open:Locator)=>{ await selectTeamPage(open,'board') }
const one=questionCases(page)[item0]!
await page.emulateMedia({ colorScheme: theme })
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


})
}
 test(`Wrapped Team: a kept conversation's menus refuse compaction and review, and say why, in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-wrapped')
  await (await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})}).click()
  await closeTeamDetails(frame)
  await teamBar(frame).getByRole('button',{name:'More',exact:true}).click()
  const compact=page.getByRole('menuitem',{name:/^Compact now/})
  await expect(compact).toHaveAttribute('aria-disabled','true')
  await expect(compact).toHaveAttribute('title','This Team is wrapped')
  await expect(compact).toContainText('This Team is wrapped')
  await page.keyboard.press('Escape')
  await teamBar(frame).getByRole('button',{name:'More',exact:true}).click()
  await page.getByRole('menuitem',{name:'Folder actions',exact:true}).click()
  const review=page.locator('[role="menuitem"]',{hasText:'Review uncommitted changes'})
  await expect(review).toHaveAttribute('aria-disabled','true')
  await expect(review).toHaveAttribute('title','This Team is wrapped')
 })
 test(`Wrapped Team: sidebar leaves retained conversations and unlinked Seats on Teams in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const sidebar=page.locator('#team-record-sidebar')
  await expect(sidebar.getByRole('button',{name:'Wrapped · 1',exact:true})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Writer conversation'})).toHaveCount(0)
  await expect(sidebar.locator('button[data-slot="sidebar-menu-button"]').filter({hasText:'Reviewer conversation'})).toHaveCount(0)
  await expect(sidebar.getByRole('button',{name:'Gamma',exact:true})).toHaveCount(0)
 })
 test(`Wrapped Team: narrow Seats and receipt stay inside their frame in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-narrow')
  await members(frame)
  await expect((await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})})).toBeVisible()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await closeTeamDetails(frame)
  await selectTeamPage(frame,'receipt')
  await expect(frame.getByText('What finished',{exact:true})).toBeVisible()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  const answers=frame.locator('[data-slot="member-description"]')
  await expect(answers).toHaveCount(2)
  for(const answer of await answers.all()) {
   expect(await answer.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
   expect(await answer.evaluate(el=>getComputedStyle(el).overflowWrap)).toBe('anywhere')
  }
 })
 /* A wrapped Team opens on its Receipt, including one that never had a Run. Its members are reachable from the bar. */
 test(`Wrapped Team: a Team that never had a Run opens on its Receipt in a narrow pane in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-person')
  await expect(frame.getByText('What finished',{exact:true})).toBeVisible()
  await expect(frame.locator('aside')).toHaveCount(0)
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
  await members(frame)
  await expect((await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})})).toBeVisible()
  await expect(frame.getByText('What finished',{exact:true})).toBeVisible()
  expect(await frame.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)
 })
 /* A turn can still be running in a conversation a wrap kept, and the host leaves `turn/interrupt` open for it. The
    composer takes nothing new — no typing, no Send — but Stop is on, so the person can end what is running (#1317). */
 test(`Wrapped Team: a turn still running in a kept conversation can be stopped, and nothing else is on, in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const frame=page.locator('#team-record-running')
  await (await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Alpha',exact:true})}).click()
  await expect(frame.locator('textarea[data-slot="composer-text"]')).toBeDisabled()
  await expect(frame.locator('textarea[data-slot="composer-text"]')).toHaveAttribute('placeholder','This Team is wrapped')
  const stop=frame.getByRole('button',{name:'Stop',exact:true})
  await expect(stop).toBeEnabled()
  await expect(stop).toHaveAttribute('title','Stop this turn')
  // Enabled is not enough. The corner is one coin wide and clips a second, so a refused send drawn beside Stop leaves a
  // Stop that is on and cannot be pressed: the element a pointer finds at its centre is the composer's, not Stop. (A
  // Playwright click is no proof — it scrolls the clipped track until Stop shows, which a person's pointer cannot do.)
  await frame.scrollIntoViewIfNeeded()
  expect(await stop.evaluate(node=>{
    const box=node.getBoundingClientRect()
    const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)
    return hit!==null&&(hit===node||node.contains(hit))
  })).toBe(true)
  await expect(frame.locator('[data-slot="composer-send"]')).toHaveCount(1)
  // The other Seat's turn finished: its conversation has nothing to stop, and its single control is off.
  await (await members(frame)).locator('[data-slot="list-row"]').filter({has:page.getByRole('button',{name:'Actions for Beta',exact:true})}).click()
  await expect(frame.getByRole('button',{name:'Stop',exact:true})).toHaveCount(0)
  await expect(frame.locator('[data-slot="composer-send"]')).toBeDisabled()
 })
 /* The Assign dialog is the one place a person chooses a conversation, and the host will not seat one a wrapped Team's
    receipt keeps for another Team's card. It does not offer it, rather than offer it and refuse (#1317). */
 test(`Wrapped Team: another Team's Assign dialog does not offer a conversation a wrapped Team keeps in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const open=page.locator('#team-record-assign')
  await selectTeamPage(open,'board')
  await open.getByRole('button',{name:'What to do with #3',exact:true}).click()
  await page.getByRole('menuitem',{name:/^Give this to/}).click()
  const dialog=page.locator('[data-slot="dialog-content"]')
  await expect(dialog).toContainText('Assign a conversation')
  const rows=dialog.getByRole('radio')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({hasText:'Tidy the settings copy'})).toHaveCount(1)
  await expect(rows.filter({hasText:'Add a test for the retry budget'})).toHaveCount(1)
  await expect(dialog).not.toContainText('Tighten the checkout copy')
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click()
  await expect(dialog).toHaveCount(0)
 })
 test(`Wrapped Team: the sidebar leaves Seats with no conversation on Teams in ${theme}`, async ({page}) => {
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?team-record&theme=${theme}`)
  const sidebar=page.locator('#team-record-sidebar-unlinked')
  await expect(sidebar.getByRole('button',{name:'Wrapped · 1',exact:true})).toHaveCount(0)
  await expect(sidebar.locator('ul[data-nested="true"]')).toHaveCount(0)
  for (const name of ['Alpha','Beta']) await expect(sidebar.getByRole('button',{name,exact:true})).toHaveCount(0)
 })
}
