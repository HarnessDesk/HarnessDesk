import { expect, test, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { installFramePreviewFixture } from './frame-preview-fixture'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })

const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width: number) => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  await page.evaluate(async () => { await document.fonts.ready })
}

{
const models = [
    { model: 'gpt-5.5', modelName: 'GPT-5.5 medium' },
    { model: 'sol-low', modelName: 'GPT-6.1-Sol Low' },
  ] as const
const states = ['storefront', 'pricing-service'].flatMap(folder => models.map(model => ({ folder, ...model })))
for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, state] of (states).entries()) for (const [item2, width] of ([1280, 1100, 720]).entries()) test(('R12.1 second pass: the composer preserves labels and folds controls across real values') + ' [item ' + [item0,item1,item2].join('-') + ']', async ({ page }) => {

await openFrame(page, `frame-wall=draft&frame-composer-values=1&frame-fix6-folder=${state.folder}&frame-fix6-model=${state.model}`, theme, width)
const toolbar = page.locator('[data-slot="composer-tools"]:visible').last()
await expect(toolbar).toBeVisible()
if (width < FRAME.fold.sidebarFloats) {
      await page.getByRole('button', { name: 'Show sidebar', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Sidebar', exact: true })).toBeVisible()
    } else {
      expect((await page.locator('[data-frame-region="left"]:visible').boundingBox())!.width).toBeGreaterThan(0)
    }
const geometry = await toolbar.evaluate(toolbar => {
      const visible = (node: HTMLElement) => {
        const style = getComputedStyle(node)
        const box = node.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 1 && box.height > 0
      }
      const words = [...toolbar.querySelectorAll<HTMLElement>(
        '[data-slot="text"][data-role="row"], [data-slot="chip-words"] > span:not(.sr-only)',
      )].filter(visible)
      const labels = words.map(node => {
        const track = node.closest<HTMLElement>('[data-composer-track]')!
        const range = document.createRange()
        range.selectNodeContents(node)
        const text = range.getBoundingClientRect()
        const bounds = track.getBoundingClientRect()
        return {
          track: track.dataset.composerTrack,
          text: node.textContent?.trim(),
          clipped: node.scrollWidth > node.clientWidth || text.left < bounds.left - 1 || text.right > bounds.right + 1,
          labelWidth: node.clientWidth,
          labelScrollWidth: node.scrollWidth,
          textWidth: text.width,
          trackWidth: bounds.width,
        }
      })
      const folded = [...toolbar.querySelectorAll<HTMLElement>('[data-composer-track][data-folded]')]
        .map(track => ({
          track: track.dataset.composerTrack,
          hasVisibleWords: [...track.querySelectorAll<HTMLElement>(
            '[data-slot="text"][data-role="row"], [data-slot="chip-words"] > span:not(.sr-only)',
          )].some(visible),
        }))
      const row = toolbar.getBoundingClientRect()
      const send = toolbar.querySelector<HTMLElement>('[data-composer-track="send"] button')!.getBoundingClientRect()
      const style = getComputedStyle(toolbar)
      return {
        labels,
        folded,
        tracks: [...toolbar.querySelectorAll<HTMLElement>('[data-composer-track]')].map(track => ({
          track: track.dataset.composerTrack,
          width: track.getBoundingClientRect().width,
          flexShrink: getComputedStyle(track).flexShrink,
          folded: track.hasAttribute('data-folded'),
        })),
        toolbarWidth: toolbar.clientWidth,
        toolbarScrollWidth: toolbar.scrollWidth,
        gap: style.columnGap,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        rowOverflow: toolbar.scrollWidth - toolbar.clientWidth,
        sendOutside: send.left < row.left - 1 || send.right > row.right + 1,
      }
    })
expect(geometry.rowOverflow, `composer row should not overflow at ${width}px in ${theme}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(0)
expect(geometry.sendOutside, `Send should stay inside the composer at ${width}px in ${theme}`).toBe(false)
const clipped = geometry.labels.filter(label => label.clipped)
if (width === 720) {
      expect(clipped.every(label => label.track === 'work-in'), `only the folder name may truncate at ${width}px in ${theme}`).toBe(true)
      expect(geometry.folded.filter(track => track.hasVisibleWords), `folded controls should be icon-only at ${width}px in ${theme}`).toEqual([])
      for (const track of await toolbar.locator('[data-composer-track][data-folded]').all()) {
        const name = await track.getAttribute('data-composer-track')
        if (name === 'mode' && await track.locator('[data-slot="chip"]').count()) {
          const chip = track.locator('[data-slot="chip"]')
          await expect(chip.locator('.sr-only'), 'the folded mode fact should keep its value for assistive technology').toHaveText('Default')
          await expect(chip).toHaveAttribute('title', 'Default')
        } else {
          await expect(track.locator('button').first(), `folded ${name} control should stay named`).toHaveAccessibleName(/\S/)
        }
      }
    } else {
      expect(clipped, `visible composer labels should fit at ${width}px in ${theme}: ${JSON.stringify(geometry)}`).toEqual([])
    }
const usage = toolbar.locator('[data-composer-track="context"] button')
await expect(usage).toHaveAccessibleName('Usage')
await expect(usage).toHaveAttribute('title', 'Usage')
await expect(usage.locator('[data-slot="progress-ring"]')).toBeVisible()
await expect(usage.locator('[data-role="meta"]')).toHaveCount(0)
if (width === 1280) {
      const folder = toolbar.locator('[data-composer-track="work-in"] [data-slot="text"][data-role="row"]')
      await expect(folder).toHaveText(state.folder)
      await expect(folder).toHaveAttribute('title', `/work/${state.folder}`)
      await expect(toolbar.locator('[data-composer-track="permissions"] [data-slot="text"][data-role="row"]')).toHaveText('Workspace write')
      const mode = toolbar.locator('[data-composer-track="mode"]')
      if (await mode.getAttribute('data-folded') !== null) {
        await expect(mode.locator('button')).toHaveAccessibleName(/Default/)
      } else {
        await expect(mode.locator('[data-slot="text"][data-role="row"]')).toHaveText('Default')
      }
      await expect(toolbar.locator('[data-composer-track="model"] button')).toHaveAccessibleName(state.modelName)
      await expect(toolbar.locator('[data-composer-track="agent"] button').first()).toHaveAccessibleName(/\S/)
      await expect(toolbar.locator('[data-composer-track="more"] button').first()).toHaveAccessibleName(/\S/)
    }


})
}

const openInvestigation = async (page: Page, theme: 'light' | 'dark', width: number) => {
  await openFrame(page, 'team-start=picker', theme, width)
  await page.getByRole('button', { name: 'Investigation', exact: true }).click()
  return page.getByRole('dialog')
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R12.2 the New Team footer stays in place between steps') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

await openFrame(page, 'team-start=picker', theme, width)
const dialog = page.getByRole('dialog')
const geometry = async () => dialog.evaluate(element => {
      const footer = element.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!
      return { top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, footerTop: footer.getBoundingClientRect().top }
    })
const picker = await geometry()
await page.getByRole('button', { name: 'Investigation', exact: true }).click()
const form = await geometry()
expect(form.height, `dialog height at ${width}px in ${theme}`).toBeCloseTo(picker.height, 1)
expect(form.footerTop, `footer position at ${width}px in ${theme}`).toBeCloseTo(picker.footerTop, 1)
expect(form.top, `dialog top at ${width}px in ${theme}`).toBeCloseTo(picker.top, 1)


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R12.3 Back puts its text on the footer edge and its plate past it') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

const dialog = await openInvestigation(page, theme, width)
const alignment = await dialog.evaluate(element => {
      const footer = element.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!
      const navigation = footer.querySelector<HTMLElement>('[data-slot="dialog-footer-navigation"]')!
      const back = [...navigation.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === 'Back')!
      const range = document.createRange()
      range.selectNodeContents(back)
      return { text: range.getBoundingClientRect().left, edge: navigation.getBoundingClientRect().left, plate: back.getBoundingClientRect().left }
    })
expect(Math.abs(alignment.text - alignment.edge), `Back text edge at ${width}px in ${theme}`).toBeLessThanOrEqual(1)
expect(alignment.plate, `Back plate should outdent at ${width}px in ${theme}`).toBeLessThan(alignment.edge)


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R12.4 the New Team role name uses sentence case') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

const dialog = await openInvestigation(page, theme, width)
const role = dialog.locator('[aria-label="Who does what"] [data-slot="row-title"]').first()
await expect(role).toHaveText('Research')
await expect(role).not.toHaveText('research')


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R12.5 Details uses the shared disclosure chevron') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {

const dialog = await openInvestigation(page, theme, width)
const details = dialog.getByRole('button', { name: 'Details', exact: true })
await expect(details).toHaveAttribute('aria-expanded', 'false')
await expect(dialog.locator('details')).toHaveCount(0)
await expect(dialog.locator('[data-flow-details]')).toBeHidden()
const chevron = details.locator('[data-slot="disclosure-chevron"]')
await expect(chevron).toBeVisible()
await details.click()
await expect(details).toHaveAttribute('aria-expanded', 'true')
await expect(chevron).toHaveAttribute('data-open', '')
await expect(dialog.locator('[data-flow-details]')).toBeVisible()


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R12.6 team approvals use the same short folder label and full-path title') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {
const path = '/private/tmp/frame-fix6/fixture-run/storefront'
await openFrame(page, 'team-overview', theme, width)
const approval = page.locator('#team-overview-answer-approval [data-slot="request-answer"]')
const folder = approval.locator('[data-slot="approval-meta"][data-kind="folder"]')
await expect(folder).toBeVisible()
await expect(folder.locator('span').nth(0)).toHaveText('in')
await expect(folder.locator('span').nth(1)).toHaveText('storefront')
await expect(folder).toHaveAttribute('title', path)
await expect(folder).not.toContainText(path)


})
}

{

for (const [item0, theme] of (['light', 'dark'] as const).entries()) for (const [item1, width] of ([1280, 720]).entries()) test(('R12.7 an unavailable conversation keeps the message in its body without repeating it in the strip') + ' [item ' + [item0,item1].join('-') + ']', async ({ page }) => {
const message = 'A runtime was found at /work/fixture/bin/agent, but did not report its version.'
await openFrame(page, 'frame-wall=conversation&frame-fix6-runtime-unavailable=1', theme, width)
await expect(page.locator('[data-slot="conversation-empty-state"]')).toContainText(message)
await expect(page.locator('[data-slot="notice-strip"]')).toHaveCount(0)


})
}
