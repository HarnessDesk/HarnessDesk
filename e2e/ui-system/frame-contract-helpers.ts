import { installFramePreviewFixture } from './frame-preview-fixture'
import { expect, type Page } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'
import { WALL_DESTINATIONS } from './frame-wall-destinations'
import type { Locator } from '@playwright/test'
import { checkInfoGeometry, checkMenuGeometry, checkSubmenuChevrons, checkTrailingChildGaps } from './frame-contract-popup-rules'
import { readSurface } from './frame-contract-popup-snapshot'


/**
 * The rendered check (spec, "How it is checked"): the app measured against
 * the frame contract in `packages/ui/src/design/frame.ts`. Each phase of the
 * frame work adds what it moved; nothing here is a literal of its own.
 */
export const openFrame = async (page: Page, query: string, theme: 'light' | 'dark', width = 1440) => {
  await installFramePreviewFixture(page)
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme })
  await page.mouse.move(width - 1, 899)
  await page.goto(`/preview.html?${query}&theme=${theme}`)
  if (theme === 'dark') await expect(page.locator('body')).toHaveAttribute('data-hd-dark-theme', '')
  await page.evaluate(async () => { await document.fonts.ready })
}

/** A token's resolved pixels: a hidden probe takes it as its width. */
export const resolvedPx = (page: Page, token: string) => page.evaluate((name) => {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;width:var(${name})`
  document.body.append(probe)
  const px = probe.getBoundingClientRect().width
  probe.remove()
  return px
}, token)

export const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (color: string) => {
    const encoded = color.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/)
    const values = encoded
      ? encoded.slice(1, 4).map(value => Number(value) * 255)
      : color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
    if (!values || values.length !== 3) throw new Error(`Cannot read RGB color ${color}`)
    const linear = values.map(value => {
      const channel = value / 255
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export const layoutDestinations = (() => {
  return WALL_DESTINATIONS.filter(destination => {
    if (destination.surface === 'pattern' || destination.id.startsWith('popup-') || destination.query.includes('popup=')) return false
    if (destination.popup || destination.leftPopup || destination.hover || destination.focus || destination.plan || destination.infoTarget || destination.infoFocus || destination.contextInfo || destination.memberInfo || destination.account || destination.inbox || destination.undo || destination.git || destination.select || destination.composerAdd) return false
    return true
  })
})()

// Task 10 extends this same window contract to the transitional
// AppWindow hosts. The pattern probe deliberately has no application lead.
export const B10_NONWORK = /frame-wall=(?:teams|agents|agent|dashboard|settings(?:-general|-runtimes)?|library|plugins|changes-review)(?:&|$)/
export const D6_NONWORK = /frame-wall=settings-(?:navigation|search)(?:&|$)/
export const B6_WORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => destination.surface !== 'pattern' && !B10_NONWORK.test(destination.query) && !D6_NONWORK.test(destination.query))
export const B10_NONWORK_DESTINATIONS = WALL_DESTINATIONS.filter(destination => B10_NONWORK.test(destination.query) || D6_NONWORK.test(destination.query))

/**
 * The popup checks other specs call on a surface they staged themselves. Each
 * reads the surface once and hands it to the rule in
 * `frame-contract-popup-rules.ts`, the same rule the C10 popup specs run.
 */
export const expectMenuGeometry = async (surface: Locator) => {
  checkMenuGeometry((await readSurface(surface)).popup)
}

export const expectTrailingChildGaps = async (_page: Page, surface: Locator) => {
  const { popup, tokens } = await readSurface(surface)
  checkTrailingChildGaps(popup, tokens)
}

export const expectSubmenuChevrons = async (_page: Page, surface: Locator) => {
  const { popup, tokens } = await readSurface(surface)
  checkSubmenuChevrons(popup, tokens)
}

export const expectInfoGeometry = async (card: Locator) => {
  await expect(card).toBeVisible()
  await expect.poll(async () => (await card.boundingBox())?.width).toBe(FRAME.infoCard.width)
  checkInfoGeometry((await readSurface(card)).popup)
}
export const expectRefusedMenuRow = async (row: Locator) => {
  const colors = await row.evaluate(el => {
    const disabledProbe = document.createElement('span'); disabledProbe.style.color = 'var(--hd-disabled-foreground)'; el.append(disabledProbe)
    const disabled = getComputedStyle(disabledProbe).color; disabledProbe.remove()
    const secondaryProbe = document.createElement('span'); secondaryProbe.style.color = 'var(--hd-secondary-foreground)'; el.append(secondaryProbe)
    const secondary = getComputedStyle(secondaryProbe).color; secondaryProbe.remove()
    return {
      disabled,
      secondary,
      tracks: [el, ...el.querySelectorAll('[data-menu-icon],[data-menu-label],[data-menu-trailing]')].map(node => getComputedStyle(node).color),
      reason: el.querySelector('[data-menu-hint]') ? getComputedStyle(el.querySelector('[data-menu-hint]')!).color : null,
    }
  })
  expect(colors.tracks.length).toBe(4)
  for (const color of colors.tracks) expect(color).toBe(colors.disabled)
  if (colors.reason !== null) expect(colors.reason).toBe(colors.secondary)
  const icon = row.locator('[data-menu-icon] svg')
  await expect(icon).toHaveCount(1)
  const box = (await icon.boundingBox())!
  expect([box.width, box.height]).toEqual([16, 16])
  const hint = row.locator('[data-menu-hint]')
  expect(await hint.evaluate(el => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight])).toEqual(['12px', '16px'])
}

// The popup areas deal these out; the git-ref destination is read beside the popup kinds.
export const popupContractDestinations = WALL_DESTINATIONS.filter(destination => !destination.gitRef)
