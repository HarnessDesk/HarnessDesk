import { expect, test } from '@playwright/test'

for(const theme of ['light','dark']) for(const scene of ['flow','plain']) {
 test(`New Team recovery fills the form in ${theme} (${scene})`,async({page})=>{
  await page.goto(`/preview.html?workspace-recovery=${scene}&theme=${theme}`)
  const dialog=page.getByRole('dialog',{name:'New Team'})
  await expect(dialog).toBeVisible()
  const action=dialog.getByRole('button',{name:'Open storefront',exact:true}).first()
  await expect(action).toBeVisible()
  const frame=action.locator('xpath=ancestor::*[@data-measure][1]')
  await expect(frame).toHaveAttribute('data-measure','container')
  const geometry=await frame.evaluate(node=>({width:node.getBoundingClientRect().width,parent:node.parentElement!.getBoundingClientRect().width}))
  expect(Math.abs(geometry.width-geometry.parent)).toBeLessThanOrEqual(1)
  await expect(frame.locator('[data-floating]')).toHaveCount(0)
  await page.screenshot({path:`/tmp/issues-1642-${theme}-${scene}.png`})
 })
}
