import { measureDestination, expectPageJourney, expectDestinationTab } from './frame-page-contract'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { selectFrameTab } from './frame-actions'
import { openFrame } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


test('E9 Changes review content uses the shared page gutter inside its canvas', async ({ page }) => {
  await openFrame(page, 'frame-wall=changes-review', 'light')
  const canvas = page.locator('[data-page-destination="changes-review"]:visible [data-slot="page"][data-width="canvas"]')
  const canvasBox = (await canvas.boundingBox())!
  const firstBlock = (await canvas.locator('[data-slot="summary-list"]').boundingBox())!
  expect(Math.round(firstBlock.x - canvasBox.x)).toBe(FRAME.page.gutter)
})

test('E9 Changes review starts with a single filter field', async ({ page }) => {
  await openFrame(page, 'frame-wall=changes-review', 'light')
  const measured = page.locator('[data-page-destination="changes-review"]:visible [data-page-measure="wide"]')
  const firstRow = measured.locator(':scope > *').first()
  await expect(firstRow.getByRole('searchbox', { name: 'Filter files', exact: true })).toBeVisible()
  await expect(firstRow.locator('[data-slot="row-title"]')).toHaveCount(0)
})

test('E9 review is opened as a page with a clear label', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation&frame-review=1', 'light')
  await page.locator('[data-work-tool="changes"]:visible').click()
  const opener = page.getByRole('button', { name: 'Open review', exact: true })
  await expect(opener).toBeVisible()
  await opener.click()
  await expect(page.locator('[data-page-destination="changes-review"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-slot="app-window"]')).toHaveCount(0)
})

test('R10 nav4 Changes review uses page top gutter and Escape returns to work', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation&frame-review=1', 'light')
  await page.locator('[data-work-tool="changes"]:visible').click()
  await page.getByRole('button', { name: 'Open review', exact: true }).click()
  const review = page.locator('[data-page-destination="changes-review"]:visible')
  await expect(review).toHaveCount(1)
  const topBar = (await page.locator('[data-slot="top-bar"]:visible').boundingBox())!
  const firstBlock = (await review.locator('[data-page-measure="wide"] > *').first().boundingBox())!
  const topOffset = firstBlock.y - (topBar.y + topBar.height)
  // The gutter is drawn from where a 28px switcher track ends; the track is 32 now and centred in the same bar,
  // so its bottom edge sits 2px lower while the page content has not moved.
  const trackGrowth = (topBar.height - 28) / 2
  expect(Math.round(topOffset + trackGrowth)).toBe(FRAME.page.gutter)
  await page.keyboard.press('Escape')
  await expect(review).toHaveCount(0)
  await expect(page.locator('[data-slot="retained-work"]:visible')).toHaveCount(1)
})

// E8 opens from the conversation's review event; review has no column door.
for (const width of [1440, 720]) test(`E8 review journey retains the conversation and normal column ${width}`, async ({ page }) => {
  await expectPageJourney(page, 'Changes', 'changes-review', width, {opener:'review'})
})
for (const theme of ['light', 'dark'] as const) for (const width of [1440, 1100, 720]) {
  test(`E8 Changes canvas ${width} ${theme}`, async ({ page }) => {
    await page.addInitScript(() => {
      const timer = window.setInterval(() => {
        if (document.querySelector('[data-page-destination="changes-review"]')) { clearInterval(timer); return }
        if (document.querySelector('[data-slot="retained-work"]')) window.dispatchEvent(new CustomEvent('harnessdesk:review'))
      }, 20)
    })
    await measureDestination(page, 'frame-wall=navigation&frame-review=1', 'canvas', theme, width, { expectedTopInset: 'page' })
    await expectDestinationTab(page, 'working')
    await expect(page.getByRole('searchbox', { name: 'Filter files', exact: true })).toBeVisible()
    await expect(page.locator('[data-slot="app-window"]')).toHaveCount(0)
  })
}
test('E8 review More contains only Terminal and opens the reviewed folder', async ({ page }) => {
  await openFrame(page, 'frame-wall=navigation', 'light')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('harnessdesk:review')))
  await expect(page.locator('[data-page-destination="changes-review"]:visible')).toHaveCount(1)
  await page.locator('[data-slot="top-bar"]:visible').getByRole('button', { name: 'More', exact: true }).click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveCount(0)
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1)
  await menu.getByRole('menuitemradio', { name: /Terminal/ }).click()
  await expect(page.locator('[data-frame-region="bottom"]:visible')).toBeVisible()
})

// E8 semantic scenes use the assembled dispatcher and the existing review scroll.
test('E8 working staged and filtered reviews keep exact paths and counts', async ({page}) => {
  await openFrame(page,'frame-wall=changes-review','light')
  const body=page.locator('[data-page-destination="changes-review"]:visible')
  await expect(body.getByText('2 files · +3 −1',{exact:true})).toBeVisible()
  await expect(body.locator('[data-review-file]')).toHaveCount(2)
  await page.getByRole('searchbox',{name:'Filter files',exact:true}).fill('src/a')
  await expect(body.locator('[data-review-file]')).toHaveCount(1)
  await expect(body.locator('[data-review-file="src/a.ts"]')).toBeVisible()
  await page.getByRole('searchbox',{name:'Filter files',exact:true}).fill('')
  await selectFrameTab(page,'staged')
  await expect(body.getByText('1 file · +1 −0',{exact:true})).toBeVisible()
  await expect(body.locator('[data-review-file="ready.txt"]')).toBeVisible()
  await expect(body.locator('[data-review-file="src/a.ts"]')).toHaveCount(0)
})
test('E8 body index jumps inside the existing destination scroll',async({page})=>{
  await openFrame(page,'frame-wall=changes-review&frame-review-scene=large','dark',720)
  const scroll=page.locator('[data-page-destination="changes-review"][data-slot="destination-scroll"]')
  await page.locator('[data-page-destination="changes-review"] [data-slot="rows"] button').filter({hasText:'large.txt'}).click()
  await expect.poll(()=>scroll.evaluate(node=>node.scrollTop)).toBeGreaterThan(0)
  const section=page.locator('[data-review-file="large.txt"]')
  const boxes=await Promise.all([scroll.boundingBox(),section.boundingBox()])
  expect(Math.abs(boxes[0]!.y-boxes[1]!.y)).toBeLessThanOrEqual(1)
})
test('E8 capped revision quote returns to the mounted originating work',async({page})=>{
  await openFrame(page,'frame-wall=navigation&frame-review=1&frame-review-scene=large&frame-terminal=1','light')
  const work=page.locator('[data-slot="retained-work"]')
  await work.evaluate(node=>{node.setAttribute('data-retention-witness','original-work')})
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('harnessdesk:review')))
  await page.getByRole('button',{name:'Revise this hunk…',exact:true}).first().click()
  await expect(work).toBeVisible()
  await expect(work).toHaveAttribute('data-retention-witness','original-work')
  const composer=page.locator('[data-slot="composer-text"]:visible')
  await expect(composer).toHaveValue(/Please revise this hunk of/)
  const quote=(await composer.inputValue()).split('\n```diff\n')[1]!.split('\n```')[0]!
  expect(quote).toHaveLength(1802);expect(quote).toMatch(/\n…$/);expect(quote).not.toContain('diff --git')
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="changes-review"]:visible')).toHaveCount(1)
})
for(const scene of ['empty','not-repository'] as const)test(`E8 review preserves the ${scene} message`,async({page})=>{
  await openFrame(page,`frame-wall=changes-review&frame-review-scene=${scene}`,'dark')
  const review=page.locator('[data-page-destination="changes-review"]:visible')
  await expect(review.getByText(scene==='empty'?'No changes yet':'This folder is not a git repository, so there is nothing to compare against.',{exact:true})).toBeVisible()
  if(scene==='empty')await expect(review.getByRole('searchbox',{name:'Filter files',exact:true})).toHaveCount(0)
})
test('E8 bracket history crosses destinations and preserves the editor draft',async({page})=>{
  await openFrame(page,'frame-wall=navigation','dark')
  const composer=page.locator('[data-slot="composer-text"]:visible')
  await composer.fill('Keep this draft')
  await page.keyboard.press('Meta+,');await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+u');await expect(page.locator('[data-page-destination="dashboard"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+[')
  await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
  await expect(composer).toHaveValue('Keep this draft')
  await page.keyboard.press('Meta+]');await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
  await page.keyboard.press('Meta+]');await expect(page.locator('[data-page-destination="settings"]:visible')).toHaveCount(1)
})
