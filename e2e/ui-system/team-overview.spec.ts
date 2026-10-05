import { expect, test } from '@playwright/test'

for (const theme of ['light','dark'] as const) {
 test(`Team Overview: precedence, resting ink, faces, fold and pane width in ${theme}`, async ({page}) => {
  await page.emulateMedia({colorScheme:theme})
  await page.goto(`/preview.html?team-overview&theme=${theme}`)
  const wide=page.locator('#team-overview-running [data-slot="team-overview"]')
  await expect(wide).toBeVisible({timeout:3000})
  await expect(wide).toHaveAttribute('data-layout','table')
  await expect(wide.locator('[data-seat]')).toHaveCount(4)
  expect(await wide.locator('[data-seat]').evaluateAll(rows=>rows.map(row=>row.textContent))).toEqual(expect.arrayContaining([expect.stringContaining('Needs you'),expect.stringContaining('Unread'),expect.stringContaining('Working'),expect.stringContaining('Idle')]))
  expect(await wide.locator('[data-seat]').evaluateAll(rows=>rows.map(row=>row.getAttribute('data-seat')))).toEqual(['seat-1','seat-2','seat-0','seat-3'])
  await expect(wide.locator('[data-shape="face"]')).toHaveCount(4)
  // The face shares the whole cell centre, including the name and role.
  for (const row of await wide.locator('[data-seat]').all()) {
   const delta = await row.evaluate(e => {
    const face = e.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
    const cell = e.querySelector('[data-slot="table-cell"]')!.getBoundingClientRect()
    return Math.abs((face.top + face.bottom) / 2 - (cell.top + cell.bottom) / 2)
   })
   expect(delta).toBeLessThan(1.5)
  }
  const doing=wide.locator('[data-seat="seat-0"] [data-slot="seat-doing"]')
  await expect(doing).toHaveAttribute('title',/Edit/)
  expect(await doing.evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(true)
  const quiet=wide.locator('[data-resting]').last()
  const ink = await quiet.evaluate(e => {
    const text=e.querySelector('[data-slot="text"]') ?? e
    const mark=document.createElement('span'); mark.style.color='var(--hd-muted-foreground)'; e.append(mark)
    const expected=getComputedStyle(mark).color; const actual=getComputedStyle(text).color; mark.remove()
    return {actual,expected}
  })
  expect(ink.actual).toBe(ink.expected)
  const done=page.locator('#team-overview-done [data-slot="team-overview"]')
  await expect(done.getByRole('button',{name:'3 done'})).toHaveAttribute('aria-expanded','false')
  await expect(done.locator('[data-seat]')).toHaveCount(0)
  await done.getByRole('button',{name:'3 done'}).click()
  await expect(done.locator('[data-seat]')).toHaveCount(3)
  const narrow=page.locator('#team-overview-narrow [data-slot="team-overview"]')
  await expect(narrow).toHaveAttribute('data-layout','narrow')
  await expect(narrow.locator('[data-seat][data-slot="list-row"]')).toHaveCount(4)
  expect(await narrow.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true)
  const rig=page.locator('#team-overview-team')
  await expect(rig.locator('[data-slot="team-overview"]')).toBeVisible()
  await expect(rig.getByText('2 done',{exact:true})).toBeVisible()
  expect(await rig.locator('aside').textContent()).toMatch(/Agents2/)
  await expect(rig.locator('aside [data-slot="member-done"]')).toHaveCount(2)
  for (const state of await rig.locator('aside [data-slot="member-done"]').all()) {
   expect(await state.evaluate(e => {
    const label = e.getBoundingClientRect()
    const row = e.closest('[data-slot="list-row"]')!.getBoundingClientRect()
    return label.left >= row.left && label.right <= row.right
   })).toBe(true)
  }
  const tree=page.locator('#team-overview-sidebar')
  expect(await tree.locator('[data-slot="sidebar-menu"]').evaluateAll(lists=>[...new Set(lists.map(list=>getComputedStyle(list).listStyleType))])).toEqual(['none'])
  const spinner=tree.locator('[data-slot="spinner"]')
  await expect(spinner).toBeVisible()
  await expect(spinner.locator('..')).toHaveAccessibleName('Running')
  await expect(spinner).toHaveAttribute('data-tone','neutral')
  await expect(spinner).toHaveCSS('animation-name','none')
  await expect(tree).not.toContainText('Working')
  await expect(tree.locator('[data-slot="sidebar-menu-state"], [data-slot="chip"]')).toHaveCount(0)
  const disclosure=tree.getByRole('button',{name:'Show the agents in Retry the checkout call',exact:true})
  await expect(disclosure).toHaveAttribute('aria-expanded','false')
  await tree.getByRole('button',{name:'Room Retry the checkout call',exact:true}).hover()
  await disclosure.click()
  await expect(tree.locator('[data-slot="sidebar-menu-button"]').filter({hasText:'Writer conversation'})).toHaveCount(1)
  await expect(tree.locator('[data-slot="sidebar-menu-button"]').filter({hasText:'Reviewer conversation'})).toHaveCount(1)
 })
}

for (const theme of ['light','dark'] as const) {
 test(`Team Overview: attention sentences wrap whole in ${theme}`, async ({page}) => {
  await page.goto(`/preview.html?team-overview&theme=${theme}`)
  for (const scene of ['running','narrow']) {
   const attention=page.locator(`#team-overview-${scene} [aria-label="Needs you"]`)
   const sentence=attention.locator('[data-slot="list-row-subtitle"]')
   await expect(sentence).toHaveText(/choose whether to keep the original payment method/)
   expect(await sentence.evaluate(e=>{
    const style=getComputedStyle(e)
    const range=document.createRange();range.selectNodeContents(e)
    const bounds=e.getBoundingClientRect()
    return {whiteSpace:style.whiteSpace,textOverflow:style.textOverflow,lines:range.getClientRects().length,fits:e.scrollWidth<=e.clientWidth&&e.scrollHeight<=e.clientHeight,inside:[...range.getClientRects()].every(r=>r.left>=bounds.left-1&&r.right<=bounds.right+1&&r.bottom<=bounds.bottom+1)}
   })).toMatchObject({whiteSpace:'normal',textOverflow:'clip',fits:true,inside:true})
   if (scene==='narrow') expect(await sentence.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThan(30)
  }
 })
}

for (const theme of ['light', 'dark'] as const) {
 test(`Team Overview: the Run strip keeps live status and clickable faces align in ${theme}`, async ({ page }) => {
  await page.goto(`/preview.html?team-overview&theme=${theme}`)
  await page.evaluate(() => document.fonts.ready)
  for (const [scene, sentence] of [
   ['running', 'Alpha is working'],
   ['needs-you', 'Beta is waiting for your approval'],
   ['stalled', 'Choose the target before this Run can continue'],
  ]) {
   const overview = page.locator(`#team-overview-live-${scene} [data-slot="team-overview"]`)
   await expect(overview.locator('[aria-label="Run"] [data-slot="room-live-line"]')).toContainText(sentence!)
   await expect(overview.locator('[data-slot="room-run-reason"]')).toHaveCount(0)
   // Clickable names keep the whole cell centre; the role keeps the name's left edge.
   for (const row of await overview.locator('[data-slot="table-row"][data-seat]').all()) {
    const delta = await row.evaluate(e => {
     const face = e.querySelector('[data-slot="icon-tile"]')!.getBoundingClientRect()
     const cell = e.querySelector('[data-slot="table-cell"]')!.getBoundingClientRect()
     const name = e.querySelector('[data-role="subject"]')!
     const range = document.createRange(); range.selectNodeContents(name)
     const line = range.getClientRects()[0]!
     const role = e.querySelector('[data-slot="table-cell"] [data-role="meta"]')
     const roleRange = document.createRange(); if (role) roleRange.selectNodeContents(role)
     return { face: Math.abs((face.top + face.bottom) / 2 - (cell.top + cell.bottom) / 2),
      column: role ? Math.abs(line.left - roleRange.getClientRects()[0]!.left) : 0 }
    })
    expect(delta.face).toBeLessThan(1.5)
    expect(delta.column).toBeLessThan(1.5)
   }
  }
 })
}

for (const theme of ['light', 'dark'] as const) {
 test(`Team Overview: evidence and unrouted reasons stay visible once in ${theme}`, async ({ page }) => {
  await page.goto(`/preview.html?team-overview&theme=${theme}`)
  const waiting=page.locator('#team-overview-live-waiting-evidence [data-slot="team-overview"]')
  await expect(waiting.locator('[aria-label="Needs you"]')).toContainText('Waiting for its evidence.')
  await expect(waiting).not.toContainText('Rule after-review:')
  await waiting.getByRole('button',{name:'Open findings',exact:true}).click()
  await expect(page.locator('#team-overview-live-waiting-evidence [aria-label="Findings"]').first()).toBeVisible()
  const reason='"Review the change" (#2) answered revise; no rule continues from it, so this waits for you'
  const run=page.locator('#team-overview-live-unrouted [aria-label="Run"]')
  await expect(run.locator('[data-slot="room-run-reason"]')).toHaveText(reason)
  expect((await run.textContent())?.split(reason)).toHaveLength(2)

 })
}

for (const theme of ['light', 'dark'] as const) {
 test(`Overview gives the name the available width and drops empty readings in ${theme}`, async ({ page }) => {
  await page.goto(`/preview.html?team-overview&theme=${theme}`)
  const overview=page.locator('#team-overview-live-running [data-slot="team-overview"]')
  const widths=await overview.locator('th').evaluateAll(heads=>heads.map(head=>head.getBoundingClientRect().width))
  expect(widths[0]).toBeGreaterThan(widths[4]!)
  await expect(overview.locator('[data-seat="seat-0"] [data-slot="seat-card"]')).toHaveCSS('white-space','nowrap')
  const done=page.locator('#team-overview-comparison [data-slot="team-overview"]')
  await expect(done.locator('th')).toHaveText(['Agent','Card','Round','State','Time','Open conversation'])
  expect(await done.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true)

 })
}
