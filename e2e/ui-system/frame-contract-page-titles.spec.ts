import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { openFrame, resolvedPx } from './frame-contract-helpers'

test.use({ screenshot: 'off', trace: 'off', video: 'off' })
const scenes = [
  ['settings-account-usage', 'frame-wall=settings&frame-detail=account', 'Runtimes'],
  ['teams', 'frame-wall=teams', 'Teams'],
  ['library', 'frame-wall=library', 'Library'],
  ['agents', 'frame-wall=agents', 'Agents'],
  ['dashboard', 'frame-wall=dashboard', 'Dashboard'],
  ['plugins', 'frame-wall=plugins', 'Plugins'],
  ['session', 'frame-wall=conversation', null],
] as const
const record = async (page: Page, name: string) => {
  const directory = process.env.PAGE_TITLE_FRAMES
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, `${name}.png`) })
  const bar = page.locator('[data-slot="top-bar"]:visible').locator('..')
  const geometry = await bar.evaluate(node => ({ height: node.getBoundingClientRect().height,
    text: node.textContent, controls: [...node.querySelectorAll('button')].map(button => ({
      name: button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent,
      x: button.getBoundingClientRect().x, width: button.getBoundingClientRect().width,
    })) }))
  await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(geometry, null, 2))
}
for (const theme of ['light', 'dark'] as const) for (const width of [1100, 1800]) {
  for (const [scene, query, title] of scenes) test(`page title ${scene} ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, query, theme, width)
    await record(page, `${scene}-${width}-${theme}`)
    const bar = page.locator('[data-slot="top-bar"]:visible')
    expect((await bar.locator('..').boundingBox())!.height).toBe(40)
    if (title === null) {
      await expect(bar.locator('[data-topbar-place-menu]')).toBeVisible()
      await expect(page.locator('[data-page-destination]:visible h1')).toHaveCount(0)
      return
    }
    expect(await bar.locator('[data-topbar-title]').count()).toBe(0)
    const column = page.locator('[data-page-destination]:visible [data-slot="page"]').first()
    await expect(page.locator('[data-page-destination]:visible')).toHaveAccessibleName(/\S/)
    const heading = column.getByRole('heading', { level: 1 })
    await expect(heading).toHaveText(title)
    const box = (await heading.boundingBox())!, bounds = (await column.boundingBox())!
    const inset = await column.evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))
    expect(box.x).toBeCloseTo(bounds.x + inset, 1)
    const head = heading.locator('..')
    const verb = head.locator('[data-page-controls] > button').first()
    if (await verb.count()) {
      const button = (await verb.boundingBox())!
      expect(button.y + button.height / 2).toBeCloseTo(box.y + box.height / 2, 1)
    }
    const style = await heading.evaluate(node => { const css = getComputedStyle(node); return [css.fontSize, css.lineHeight, css.fontWeight] })
    const weight = await heading.evaluate(node => getComputedStyle(node).getPropertyValue('--hd-weight-semibold').trim())
    expect(style).toEqual(['20px', '28px', weight])
    const gap = await column.evaluate(node => parseFloat(getComputedStyle(node).rowGap))
    expect(gap).toBe(await resolvedPx(page, '--hd-page-stack'))
  })
  test(`long page title keeps its verb ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, 'frame-wall=library', theme, width)
    const title = page.locator('[data-page-destination]:visible h1')
    const action = page.getByRole('button', { name: 'Add skill', exact: true })
    const before = (await action.boundingBox())!
    await title.evaluate(node => { node.textContent = 'Library of shared skills and server configurations with a deliberately long page name' })
    const after = (await action.boundingBox())!, heading = (await title.boundingBox())!
    expect(after.x).toBeCloseTo(before.x, 1)
    expect(after.width).toBeCloseTo(before.width, 1)
    expect(heading.x + heading.width).toBeLessThanOrEqual(after.x)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await record(page, `library-long-title-${width}-${theme}`)
  })
  for (const [scene, query] of scenes.slice(0, 2)) test(`page title scroll and collapsed rail ${scene} ${width} ${theme}`, async ({ page }) => {
    await openFrame(page, query, theme, width)
    await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible()
    const bar = page.locator('[data-slot="top-bar"]:visible').locator('..')
    await expect.poll(async () => (await bar.boundingBox())!.x).toBe(0)
    const before = await bar.evaluate(node => ({ html: node.innerHTML, box: node.getBoundingClientRect().toJSON() }))
    const heading = page.locator('[data-page-destination]:visible h1')
    await expect(heading).toHaveCount(1)
    const column = heading.locator('xpath=ancestor::*[@data-slot="page"]')
    const edge = await column.evaluate(node => node.getBoundingClientRect().x + parseFloat(getComputedStyle(node).paddingLeft))
    expect((await heading.boundingBox())!.x).toBeCloseTo(edge, 1)
    await record(page, `${scene}-${width}-${theme}-collapsed`)
    if (process.env.PAGE_TITLE_FRAMES) await page.screenshot({ path: path.join(process.env.PAGE_TITLE_FRAMES, `${scene}-${width}-${theme}-bar.png`), clip: { x: 0, y: 0, width, height: 40 } })
    const scroll = page.locator('[data-page-destination]:visible')
    // Use the real scroll owner; a short board needs a shorter viewport to scroll.
    await page.setViewportSize({ width, height: 360 })
    await scroll.evaluate(node => { node.scrollTop = node.scrollHeight })
    await expect.poll(async () => (await heading.boundingBox())!.y + (await heading.boundingBox())!.height).toBeLessThanOrEqual(40)
    const after = await bar.evaluate(node => ({ html: node.innerHTML, box: node.getBoundingClientRect().toJSON() }))
    expect(after).toEqual(before)
    await record(page, `${scene}-${width}-${theme}-scrolled`)
  })
}
