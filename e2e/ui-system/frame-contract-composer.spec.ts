import { openWallDestination } from './frame-wall-actions'
import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_THEMES } from './frame-wall-destinations'
import { openFrame, expectMenuGeometry } from './frame-contract-helpers'


// Contract runs measure the preview; the final wall owns images and recordings.
test.use({ screenshot: 'off', trace: 'off', video: 'off' })


// The independent Composer subset of C2; More/Undo follows B after the merge.
for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C2 Composer Add at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation', theme, width)
    await page.getByRole('button', { name: 'Add', exact: true }).first().click()
    const surface = page.locator('[data-popup-kind="menu"]:visible').last()
    await expect(surface).toBeVisible()
    await expectMenuGeometry(surface)
    const rows = surface.locator('[data-menu-row]')
    expect(await rows.count()).toBeGreaterThanOrEqual(4)
    await expect(surface.getByRole('menuitem', { name: 'Add a file @', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Add', exact: true }).first()).toBeFocused()
  })
}
for (const theme of WALL_THEMES) for (const width of [1440, 1100, 720]) {
  test(`C2 Undo is outside More at ${width} in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-conversation-actions=1', theme, width)
    await openWallDestination(page, { undo: true })
    await expect(page.getByRole('alertdialog', { name: 'Undo the last turn?' })).toBeVisible()
    await expect(page.locator('[data-popup-kind="menu"]:visible')).toHaveCount(0)
    await page.getByRole('button', { name: 'Keep', exact: true }).click()
    await expect(page.getByRole('alertdialog')).toBeHidden()
  })
}

// Composer fit follow-up: real toolbar values, including the 720px folded state.
for (const theme of WALL_THEMES) {
  test(`Composer fit: permission value and trailing chevron stay together at 1280 in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft&frame-composer-values=1', theme, 1280)
    expect((await page.locator('[data-frame-region="left"]').boundingBox())!.width).toBeGreaterThan(0)
    const tools = page.locator('[data-slot="composer-tools"]:visible').last()
    const permission = tools.locator('[data-composer-track="permissions"] button')
    const label = permission.locator('[data-slot="text"][data-role="row"]')
    await expect(label).toHaveText('Workspace write')
    const geometry = await permission.evaluate(button => {
      const text = button.querySelector<HTMLElement>('[data-slot="text"][data-role="row"]')!
      const range = document.createRange(); range.selectNodeContents(text)
      const ink = range.getBoundingClientRect()
      const chevron = [...button.querySelectorAll<SVGElement>('svg')].at(-1)!.getBoundingClientRect()
      return { width: text.clientWidth, scroll: text.scrollWidth, chevronGap: chevron.left - ink.right }
    })
    expect(geometry.scroll, 'the full permission value should fit').toBeLessThanOrEqual(geometry.width)
    expect(geometry.chevronGap, 'the chevron should follow the value at the trigger gap').toBeLessThanOrEqual(5)
    const model = tools.locator('[data-composer-track="model"] button')
    await expect(model).toHaveAccessibleName('GPT-5.5 medium')
  })

  test(`Composer fit: Mode fact stays whole with the right panel at main 560 in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=conversation&frame-composer-values=1', theme, 1280)
    expect((await page.locator('[data-frame-region="left"]').boundingBox())!.width).toBeGreaterThan(0)
    const top = page.locator('[data-slot="top-bar"]:visible')
    const rail = top.getByRole('button', { name: 'Toggle rail', exact: true })
    if (await rail.getAttribute('aria-expanded') === 'true') await rail.click()
    await top.getByRole('button', { name: 'Changes', exact: true }).click()
    const main = page.locator('[data-frame-region="main"]:visible')
    const right = page.locator('[data-frame-region="right"]:visible')
    await expect(right).toBeVisible()
    await expect.poll(async () => Math.round((await right.boundingBox())!.width)).toBe(FRAME.rightPanel.width)
    const before = (await main.boundingBox())!
    const seam = page.getByRole('separator', { name: 'Resize the right panel', exact: true })
    const seamBox = (await seam.boundingBox())!
    const y = seamBox.y + seamBox.height / 2
    const x = seamBox.x + seamBox.width / 2
    const delta = before.width - 560
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - delta, y, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await main.boundingBox())!.width)).toBe(560)
    await expect(page.locator('[data-frame-region="right"]')).toBeVisible()
    const tools = page.locator('[data-slot="composer-tools"]:visible').last()
    const modeTrack = tools.locator('[data-composer-track="mode"]')
    const modeChip = modeTrack.locator('[data-slot="chip"]')
    const modeWords = modeChip.locator('[data-slot="chip-words"] > span:not(.sr-only)')
    await expect(modeWords).toHaveText('Default')
    const geometry = await modeWords.evaluate(node => {
      const track = node.closest('[data-composer-track]')!.getBoundingClientRect()
      const text = node.getBoundingClientRect()
      return { width: node.clientWidth, scroll: node.scrollWidth, rightOverflow: text.right - track.right }
    })
    expect(geometry.scroll, 'the Mode fact should fit in its track').toBeLessThanOrEqual(geometry.width)
    expect(geometry.rightOverflow, 'the full Mode fact should stay inside its track').toBeLessThanOrEqual(1)
    const usage = tools.locator('[data-composer-track="context"] button')
    await expect(usage).toHaveAccessibleName('Usage')
    await expect(usage).toHaveAttribute('title', 'Usage')
    await expect(usage.locator('[data-role="meta"]')).toHaveCount(0)
    const model = tools.locator('[data-composer-track="model"] button')
    await expect(model).toHaveAccessibleName(/GPT-5\.5.*medium/)
  })

  {

    for (const [item0, width] of ([1280, 720]).entries()) test(`Composer fit: Usage ring carries its name without repeating the word in ${theme} [item ${[item0].join('-')}]`, async ({ page }) => {

      await openFrame(page, 'frame-wall=draft&frame-composer-values=1', theme, width)
      const tools = page.locator('[data-slot="composer-tools"]:visible').last()
      const usage = tools.locator('[data-composer-track="context"] button')
      await expect(usage).toHaveAccessibleName('Usage')
      await expect(usage).toHaveAttribute('title', 'Usage')
      await expect(usage.locator('[data-slot="progress-ring"]')).toBeVisible()
      await expect(usage.locator('[data-role="meta"]')).toHaveCount(0)
      const overflow = await usage.evaluate(button => button.getBoundingClientRect().right - button.closest('[data-composer-track]')!.getBoundingClientRect().right)
      expect(overflow, `the ring should fit its track at ${width}px`).toBeLessThanOrEqual(1)


    })
  }

  test(`Composer fit: folded Mode never shows a lone initial at 720 in ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=draft&frame-composer-values=1', theme, 720)
    expect((await page.locator('[data-frame-region="left"]').boundingBox())!.width).toBeGreaterThan(0)
    const modeTrack = page.locator('[data-slot="composer-tools"]:visible [data-composer-track="mode"]')
    const chip = modeTrack.locator('[data-slot="chip"]')
    if (await chip.count()) {
      const folded = await modeTrack.getAttribute('data-folded') !== null || await modeTrack.getAttribute('data-tight') !== null
      if (folded) {
        expect(await chip.locator('svg').count(), 'a folded fact keeps its mode mark').toBeGreaterThan(0)
        await expect(chip.locator('[data-slot="chip-words"] > span:not(.sr-only)')).toHaveCount(0)
      } else {
        const modeWords = chip.locator('[data-slot="chip-words"] > span:not(.sr-only)')
        const geometry = await modeWords.evaluate(node => ({ text: node.textContent?.trim(), width: node.clientWidth, scroll: node.scrollWidth }))
        expect(geometry.text).toBe('Default')
        expect(geometry.scroll).toBeLessThanOrEqual(geometry.width)
      }
    }
  })
}
