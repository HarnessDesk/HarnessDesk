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
  const doing=wide.locator('[data-seat="seat-0"] [data-slot="seat-doing"]')
  await expect(doing).toHaveAttribute('title',/Edit/)
  expect(await doing.evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(true)
  const quiet=wide.locator('[data-resting]')
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
  const state=tree.locator('[data-slot="sidebar-menu-state"]')
  await expect(state).toHaveAttribute('aria-label','Working')
  await expect(state.locator('[data-slot="chip"]')).toHaveAttribute('data-variant','quiet')
  expect(await state.locator('[data-slot="chip"]').evaluate(e=>getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
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
