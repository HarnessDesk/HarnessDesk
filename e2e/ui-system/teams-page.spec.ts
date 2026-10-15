import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

for (const theme of ['light','dark'] as const) {
 for (const width of [1440,1100,720,375]) test(`Teams board keeps three equal columns or stacks in reading order ${width} ${theme}`,async({page})=>{
  await openFrame(page,'frame-wall=teams',theme,width)
  const bar=page.locator('[data-slot="top-bar"]:visible')
  await expect(bar.getByRole('button',{name:'New Team',exact:true})).toHaveCount(0)
  const toolbar=page.locator('[data-slot="teams-board-toolbar"]:visible')
  await expect(toolbar.getByRole('button',{name:'New Team',exact:true})).toBeVisible()
  await expect(toolbar.getByRole('button',{name:'All projects',exact:true})).toBeVisible()
  await expect(toolbar.getByRole('searchbox',{name:'Search Teams',exact:true})).toBeVisible()
  // The board owns creation and filtering. At 375px every remaining bar
  // control still fits in its row and accepts keyboard focus.
  if(width===375){
   await expect(page.locator('[data-slot="status-bar"]')).toHaveCount(0)
   const controls=bar.locator('button:visible')
   expect(await controls.count()).toBeGreaterThan(0)
   for(const control of await controls.all()){
    await control.focus()
    expect(await control.evaluate(node=>{
     const row=node.closest('[data-slot="top-bar"]')!.getBoundingClientRect(),button=node.getBoundingClientRect()
     return document.activeElement===node && button.left>=row.left-1 && button.right<=row.right+1 && button.top>=row.top-1 && button.bottom<=row.bottom+1
    }),await control.getAttribute('aria-label') ?? await control.innerText()).toBe(true)
   }
  }
  const board=page.locator('[data-slot="teams-board"]:visible')
  const columns=board.locator('[data-slot="teams-board-column"]')
  await expect(columns).toHaveCount(3)
  expect(await columns.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))).toEqual(['Needs you','Working','Ready to wrap'])
  const boxes=await columns.evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width}}))
  const stacked=(await board.boundingBox())!.width<=760
  if(stacked){
   expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y)
   expect(boxes.every(box=>Math.abs(box.x-boxes[0]!.x)<1)).toBe(true)
  }else{
   expect(boxes.every(box=>Math.abs(box.y-boxes[0]!.y)<1 && Math.abs(box.w-boxes[0]!.w)<1)).toBe(true)
   const toolbar=page.locator('[data-slot="teams-board-toolbar"]')
   const create=(await toolbar.getByRole('button',{name:'New Team',exact:true}).boundingBox())!
   const search=(await toolbar.getByRole('searchbox',{name:'Search Teams'}).boundingBox())!
   expect(Math.abs(create.y-search.y)).toBeLessThanOrEqual(2)
   expect(search.width).toBeCloseTo(240,0)
  }
  await expect(board.locator('[data-team-row]')).toHaveCount(5)
  const card=board.locator('[data-team-row="team-2"]')
  await expect(card.locator('[data-slot="avatar-stack"]')).toHaveAccessibleName('6 seats')
  await expect(card.locator('[data-shape="face"]')).toHaveCount(4)
  await expect(card.locator('[data-slot="avatar-stack"]')).toContainText('+2')
  for(const node of await board.locator('[data-team-row], [data-slot="team-detail"], [data-slot="avatar-stack"]').all()){
   expect(await node.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true)
  }
  const reason=board.locator('[data-team-row="team-0"] [data-slot="team-detail"]')
  await expect(reason).toContainText('choose whether to keep the original payment method')
  await expect(reason).toHaveCSS('white-space','normal')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
 })
 test(`Teams board filters every column and folds only wrapped receipts ${theme}`,async({page})=>{
  await openFrame(page,'frame-wall=teams',theme,1440)
  const board=page.locator('[data-slot="teams-board"]')
  const fold=board.getByRole('button',{name:'Wrapped · 1',exact:true})
  await expect(fold).toHaveAttribute('aria-expanded','false')
  await expect(board.locator('[data-team-row="team-5"]')).toHaveCount(0)
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded','true')
  await expect(board.locator('[data-team-row]')).toHaveCount(6)
  await fold.click()
  await page.getByRole('searchbox',{name:'Search Teams',exact:true}).fill('invoice')
  await expect(board.locator('[data-team-row]')).toHaveCount(1)
  await expect(board.locator('[data-team-row="team-3"]')).toBeVisible()
  await page.getByRole('searchbox',{name:'Search Teams',exact:true}).fill('')
  await page.getByRole('button',{name:'All projects',exact:true}).click()
  await page.getByRole('menuitemradio',{name:'billing',exact:true}).click()
  await expect(board.locator('[data-team-row]')).toHaveCount(1)
  await page.getByRole('button',{name:'billing',exact:true}).last().click()
  await page.getByRole('menuitemradio',{name:'All projects',exact:true}).click()
  await page.getByRole('searchbox',{name:'Search Teams',exact:true}).fill('no matching team')
  await expect(board.locator('[data-team-row]')).toHaveCount(0)
  await expect(page.getByText('No Teams match this search and project.')).toBeVisible()
 })
 test(`Teams cards retain full brief hover, truthful path and one keyboard opening ${theme}`,async({page})=>{
  await openFrame(page,'frame-wall=teams',theme,1440)
  const card=page.locator('[data-team-row="team-2"]')
  await expect(card.locator('[aria-label="Unread changes"]')).toHaveCount(1)
  await expect(card).toHaveAccessibleDescription(/Reviewer.*round 2.*storefront/)
  await expect(card.locator('[data-slot="team-title"]')).toHaveAttribute('title','Retry the checkout call on a 502')
  await expect(card.locator('[data-step-state="done"]')).toHaveCount(1)
  await expect(card.locator('[data-step-state="current"]')).toHaveCount(1)
  await expect(card.locator('[data-step-state="future"]')).toHaveCount(2)
  expect(await card.locator('[data-slot="avatar-stack"]').evaluate(el=>{
   const parent=el.closest('[data-team-row]')!.getBoundingClientRect()
   return [...el.querySelectorAll('[data-shape="face"]')].every(face=>{const b=face.getBoundingClientRect();return b.left>=parent.left&&b.right<=parent.right})
  })).toBe(true)
  await card.focus();await page.keyboard.press('Enter')
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="teams"]:visible')).toHaveCount(1)
  await expect(card.locator('[aria-label="Unread changes"]')).toHaveCount(0)
 })
 test(`Teams preview states render the production board ${theme}`,async({page})=>{
  await page.goto(`/preview.html?teams-page&theme=${theme}`)
  for(const scene of ['active','needs-you','settled','empty','pending','failed','narrow']){
   const frame=page.locator(`#teams-page-${scene}`)
   if(scene==='empty')await expect(frame.getByRole('heading',{name:'No Teams yet'})).toBeVisible()
   else await expect(frame.locator('[data-slot="teams-board"]')).toBeVisible()
   if(scene==='failed')await expect(frame.getByText('The Team usage record could not be read')).toBeVisible()
  }
 })
}
