import { expect, test } from '@playwright/test'
import { applyPageFrameActions } from './frame-page-actions'
import { applyLeftColumnActions } from './left-column-actions'

for (const theme of ['light', 'dark'] as const) {
  test(`final Flow step selection uses a neutral outline in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=team-run-recorded&theme=${theme}`)
    await applyPageFrameActions(page, { tab: 'run', viewChoice: 'Flow' })
    await page.locator('.react-flow__node').first().click()
    const card = page.locator('[data-slot="flow-step"][data-selected] > [data-slot="card"]:not([data-behind])')
    await expect(card).toBeVisible()
    expect(await card.evaluate(element => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--hd-border-strong)'
      document.body.append(probe)
      const ink = getComputedStyle(probe).color
      probe.remove()
      return getComputedStyle(element).outlineColor === ink
    })).toBe(true)
  })

  test(`final page radio selection uses a neutral mark in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=settings&frame-section=browser&theme=${theme}`)
    const mark = page.getByRole('radio', { name: /^In HarnessDesk/ }).locator('[data-slot="row-choice-mark"]')
    await expect(mark).toBeVisible()
    expect(await mark.evaluate(element => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--hd-foreground)'
      document.body.append(probe)
      const ink = getComputedStyle(probe).color
      probe.remove()
      return getComputedStyle(element).color === ink
    })).toBe(true)
  })

  test(`final account selection uses neutral ink and ground in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=conversation&theme=${theme}`)
    await applyLeftColumnActions(page, { leftOpen: true, leftPopup: 'account' })
    const current = page.locator('[data-menu-row][data-current]')
    await expect(current).toBeVisible()
    expect(await current.evaluate(element => {
      const probe = document.createElement('div')
      probe.style.background = 'var(--hd-active)'
      document.body.append(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      return getComputedStyle(element).backgroundColor === expected
    })).toBe(true)
  })
  test(`final picture selection uses a neutral selection ring in ${theme}`, async ({ page }) => {
    await page.goto(`/preview.html?frame-wall=settings&frame-section=profile&theme=${theme}`)
    const picture = page.locator('[data-slot="picture-choices"] [aria-checked="true"]')
    await expect(picture).toBeVisible()
    expect(await picture.evaluate(element => {
      const probe = document.createElement('div')
      probe.style.color = 'var(--hd-border-strong)'
      document.body.append(probe)
      const ink = getComputedStyle(probe).color
      probe.remove()
      return getComputedStyle(element).boxShadow.includes(ink)
    })).toBe(true)
  })
}
