import { expect, test, type Page } from '@playwright/test'
import path from 'node:path'
import { COLLECT, textReasons } from '../../script/shots/audit.mjs'

const frame = async (page: Page, name: string) => {
  await page.evaluate(() => document.fonts.ready)
  expect(textReasons(await page.evaluate(COLLECT))).toEqual([])
  if (process.env.SWEEP_FRAMES_DIR) await page.screenshot({ path: path.join(process.env.SWEEP_FRAMES_DIR, `${name}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Fold keeps headers and cards aligned when a foundation moves the target in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.emulateMedia({ colorScheme: theme })
    await page.route('**/src/preview/main.tsx*', async route => {
      const response = await route.fetch(), source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('preview React import was not found')
      await route.fulfill({ response, body: `${source}
        import foldReact from ${JSON.stringify(reactUrl)};
        import { Board as FoldBoard, BoardColumn as FoldColumn, BoardCard as FoldCard } from '/src/design/index.ts';
        const foldHost = document.createElement('section'); foldHost.setAttribute('data-fold-foundation', ''); document.body.append(foldHost);
        const fh = foldReact.createElement;
        function FoldFoundation() {
          const [collapsed, setCollapsed] = foldReact.useState(true), [needsCollapsed, setNeedsCollapsed] = foldReact.useState(false);
          return fh(FoldBoard, null,
            fh(FoldColumn, { title: 'Ready', count: 1, 'data-column': 'ready', collapsed, onCollapsedChange: setCollapsed }, fh(FoldCard, { title: 'Ready work' })),
            fh(FoldColumn, { title: 'Needs you', count: 1, 'data-column': 'needs', collapsed: needsCollapsed, onCollapsedChange: setNeedsCollapsed }, fh(FoldCard, { title: 'Waiting work' })));
        }
        createRoot(foldHost).render(fh(FoldFoundation));
      ` })
    })
    await page.goto(`/preview.html?board-list&theme=${theme}`)
    const production = page.locator('[data-frame-id="board-list-page"] [data-slot="board"]')
    await expect(production.locator('[data-slot="board-column"][data-collapsed]')).toHaveCount(0)
    await expect(production.getByRole('button', { name: /Open column/ })).toHaveCount(0)
    const fixture = page.locator('[data-fold-foundation]')
    const ready = fixture.locator('[data-column="ready"]')
    await ready.getByRole('button', { name: 'Ready 1 — Open column', exact: true }).click()
    for (const target of [24, 28, 32]) {
      await page.evaluate(target => document.body.style.setProperty('--hd-icon-target', `${target}px`), target)
      const geometry = await fixture.locator('[data-slot="board"]').evaluate(board => {
        const ready = board.querySelector('[data-column="ready"]')!
        const other = board.querySelector('[data-column="needs"]')!
        return {
          readyHeader: ready.querySelector('header')!.getBoundingClientRect().height,
          otherHeader: other.querySelector('header')!.getBoundingClientRect().height,
          readyCard: ready.querySelector('[data-slot="board-card"]')!.getBoundingClientRect().top,
          otherCard: other.querySelector('[data-slot="board-card"]')!.getBoundingClientRect().top,
        }
      })
      if (target === 32) await frame(page, `fold-${theme}`)
      expect.soft(geometry.readyHeader).toBe(geometry.otherHeader)
      expect.soft(geometry.readyCard).toBe(geometry.otherCard)
    }
  })

  test(`Team seat actions keep their full keyboard ring inside clipping ancestors in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto(`/preview.html?team-frame=running&theme=${theme}`)
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 })
      const details = page.getByRole('button', { name: 'Toggle rail', exact: true })
      if (await details.getAttribute('aria-pressed') !== 'true') await details.click()
      const seats = page.locator('[data-slot="tool-section"][aria-label="Seats"]')
      const trigger = seats.locator('[data-slot="list-row"] button[title^="Actions for"]').first()
      await expect(trigger).toBeVisible()
      await trigger.focus()
      await page.keyboard.press('Tab')
      await trigger.focus()
      await expect(trigger).toBeFocused()
      const clipped = await trigger.evaluate(node => {
        const style = getComputedStyle(node)
        const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
        const rect = node.getBoundingClientRect()
        const hits: string[] = []
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor)
          const box = ancestor.getBoundingClientRect()
          const margin = css.overflowX === 'clip' && css.overflowY === 'clip' ? parseFloat(css.overflowClipMargin.split(' ').at(-1) ?? '') || 0 : 0
          if (/(hidden|clip|auto|scroll)/.test(css.overflowX) && (rect.left - reach < box.left - margin - 0.5 || rect.right + reach > box.right + margin + 0.5)) hits.push('inline')
          if (/(hidden|clip|auto|scroll)/.test(css.overflowY) && (rect.top - reach < box.top - margin - 0.5 || rect.bottom + reach > box.bottom + margin + 0.5)) hits.push('block')
        }
        return { reach, hits }
      })
      await frame(page, `members-${width}-${theme}`)
      expect(clipped.reach).toBeGreaterThan(0)
      expect.soft(clipped.hits).toEqual([])
    }
  })

  for (const surface of ['timeline', 'inspector'] as const) for (const focused of ['opener', 'confirm'] as const) {
    test(`${surface} consent moves focus from ${focused} to Keep when its Run ends in ${theme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme })
      await page.goto(`/preview.html?theme=${theme}`)
      await page.evaluate(async surface => {
        const root = document.getElementById('root')!
        root.remove()
        const container = document.createElement('section')
        document.body.appendChild(container)
        // Vite loads the fixture from this checkout, using the production dialog.
        const url = '/src/preview/frames-retry-lifecycle.tsx'
        const { mountRetryLifecycle } = await import(url)
        mountRetryLifecycle(container, surface)
      }, surface)
      const opener = page.getByRole('button', { name: 'Run again…', exact: true, includeHidden: true })
      await opener.focus()
      await page.keyboard.press('Enter')
      const dialog = page.getByRole('alertdialog', { name: 'Run this check again?' })
      await expect(dialog.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled()
      if (focused === 'confirm') await dialog.getByRole('button', { name: 'Run again', exact: true }).focus()
      else await expect(opener).toBeFocused()
      // The lifecycle update comes from outside the modal, as the host's event does.
      await page.getByRole('button', { name: 'End Run', exact: true, includeHidden: true }).evaluate((node: HTMLButtonElement) => node.click())
      if (focused === 'opener') await frame(page, `consent-${surface}-${theme}`)
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('This run is settled. Start a new run to run this check again.')
      await expect(dialog.getByRole('button', { name: 'Run again', exact: true })).toBeDisabled()
      await expect(dialog.getByRole('button', { name: 'Keep', exact: true })).toBeFocused()
      if (focused === 'opener') await page.keyboard.press('Escape')
      else await page.keyboard.press('Enter')
      await expect(dialog).toBeHidden()
    })
  }
}
