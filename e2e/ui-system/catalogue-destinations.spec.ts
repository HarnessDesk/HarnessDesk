import { expect, test } from '@playwright/test'
import { openFrame } from './frame-contract-helpers'

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1440, 375]) {
    test(`Agent catalogue keeps role identity and facts bounded at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=agents', theme, width)
      const cards = page.locator('[data-slot="agent-card"]:visible')
      await expect(cards.first()).toBeVisible()
      await expect(page.getByRole('searchbox', { name: 'Search Agents', exact: true })).toBeVisible()
      const measured = await cards.evaluateAll(nodes => nodes.map(node => {
        const card = node.getBoundingClientRect()
        const title = node.querySelector('[data-slot="agent-card-title"]')!.getBoundingClientRect()
        const face = node.querySelector('[data-slot="agent-card-face"]')!.getBoundingClientRect()
        return { height: card.height, left: card.left, right: card.right, titleLeft: title.left, faceRight: face.right,
          overflow: node.scrollWidth > node.clientWidth + 1,
          escaped: [...node.querySelectorAll('[data-slot="agent-card-title"], [data-slot="agent-card-runtime"], [data-slot="agent-card-state"]')].some(child => {
            const rect = child.getBoundingClientRect()
            return rect.left < card.left - 1 || rect.right > card.right + 1
          }) }
      }))
      for (const card of measured) {
        expect(card.height).toBeLessThanOrEqual(280)
        expect(card.titleLeft).toBeGreaterThan(card.faceRight)
        expect(card.overflow).toBe(false)
        expect(card.escaped).toBe(false)
      }
      const sources = page.getByRole('button', { name: 'Sources and precedence', exact: true })
      await expect(sources).toHaveAttribute('aria-expanded', 'false')
      await sources.click()
      await expect(sources).toHaveAttribute('aria-expanded', 'true')
      await sources.click()
      const search = page.getByRole('searchbox', { name: 'Search Agents', exact: true })
      await search.fill('no such reusable role')
      await expect(cards).toHaveCount(0)
      await search.fill('Implementer')
      await expect(cards).toHaveCount(1)
      await expect(cards).toHaveAccessibleName('Implementer')
      await cards.click()
      await expect(page.getByRole('heading', { name: 'Implementer', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })

    test(`Teams attention cards preserve full reasons without a text tower at ${width} in ${theme}`, async ({ page }) => {
      await openFrame(page, 'frame-wall=teams', theme, width)
      const card = page.locator('[data-team-row="team-0"]')
      const issue = card.locator('[data-slot="issue-mark"]')
      await expect(issue).toHaveCount(1)
      await expect(issue).toHaveAttribute('title', /choose whether to keep the original payment method/)
      await expect(issue).toHaveAccessibleName(/choose whether to keep the original payment method/)
      expect((await card.boundingBox())!.height).toBeLessThanOrEqual(240)
      const detail = card.locator('[data-slot="team-detail"]')
      await expect(detail).not.toContainText('choose whether to keep the original payment method')
      expect(await card.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
      await page.getByRole('searchbox', { name: 'Search Teams', exact: true }).fill('original payment method')
      await expect(card).toBeVisible()
      await expect(page.locator('[data-team-row]')).toHaveCount(1)
      await card.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-slot="retained-work"]')).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }
}
