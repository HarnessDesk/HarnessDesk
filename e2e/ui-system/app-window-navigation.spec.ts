import { expect, test, type Page } from '@playwright/test'

const DESTINATION = 'A runtime supplied destination label long enough to reach the trailing status badge'

/** Supply the label through the shipped component, with the catalogue's app-styles-first cascade. */
const mount = async (page: Page) => {
  await page.route('**/src/design/explorer/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('catalogue React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import navigationReact from ${JSON.stringify(reactUrl)};
        import { WindowNav, WindowGroup, WindowNavItem, WindowNavStateMark } from '/src/components/AppWindow.tsx';
        import { Dot } from '/src/design/index.ts';
        import { AgentIcon } from '/src/components/Icons.tsx';
        const h = navigationReact.createElement;
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Compact window navigation fixture');
        frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;width:200px;height:400px;display:flex;flex-direction:column;background:var(--hd-sidebar);overflow:hidden';
        document.body.append(frame);
        createRoot(frame).render(h(WindowNav, { onBack: () => {} },
          h(WindowGroup, { label: 'Runtime pages' },
            h(WindowNavItem, {
              icon: h(AgentIcon, { size: 14 }),
              label: ${JSON.stringify(DESTINATION)},
              count: 25,
              trail: h(WindowNavStateMark, null, h(Dot, { state: 'ready', variant: 'navigation', role: 'img', 'aria-label': 'Ready' })),
              selected: false,
              onClick: () => {},
            }),
          ),
        ));
      `,
    })
  })
  await page.goto('/design.html?view=app-window')
  await expect(page.getByRole('region', { name: 'Compact window navigation fixture' })).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready })
}

for (const theme of ['light', 'dark'] as const) {
  test(`a runtime destination clips clear of its count and status in a 200px window rail (${theme})`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await mount(page)
    await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: theme, exact: true }).click()
    const rail = page.getByRole('region', { name: 'Compact window navigation fixture' })
    const button = rail.getByRole('button', { name: DESTINATION, exact: true })
    const row = button.locator('xpath=parent::*')
    await expect(row.locator('[data-slot="sidebar-menu-badge"]')).toHaveCount(2)
    await expect(row.locator('[data-role="meta"]').filter({ hasText: /^25$/ })).toHaveText('25')
    await expect(row.getByRole('img', { name: 'Ready', exact: true })).toBeVisible()

    const measurements = []
    for (const state of ['rest', 'hover', 'focus'] as const) {
      await button.blur()
      await page.mouse.move(600, 0)
      if (state === 'hover') await button.hover()
      if (state === 'focus') await button.focus()
      const measured = await row.evaluate(node => {
        const rect = (element: Element) => {
          const box = element.getBoundingClientRect()
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height }
        }
        const button = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-button"]')!
        const label = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-label"]')!
        const content = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-label-content"]')!
        const words = content.querySelector('[data-role="navigation"]')!
        const count = node.querySelector<HTMLElement>('[data-slot="sidebar-menu-badge"] [data-role="meta"]')!
        const status = node.querySelector<HTMLElement>('[data-slot="dot"]')!
        const fixture = node.closest('[aria-label="Compact window navigation fixture"]')!
        const range = document.createRange()
        range.selectNodeContents(words)
        const rawText = range.getBoundingClientRect()
        const clip = { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight }
        // Derive clipping from the engine. Do not assume that the label-content
        // clips: removing its overflow must expose text under the trailing marks.
        for (let ancestor = words.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const css = getComputedStyle(ancestor)
          const box = ancestor.getBoundingClientRect()
          if (css.overflowX !== 'visible') {
            const ellipsis = css.textOverflow === 'ellipsis'
            clip.left = Math.max(clip.left, box.left + ancestor.clientLeft + (ellipsis ? parseFloat(css.paddingLeft) : 0))
            clip.right = Math.min(clip.right, box.left + ancestor.clientLeft + ancestor.clientWidth - (ellipsis ? parseFloat(css.paddingRight) : 0))
          }
          if (css.overflowY !== 'visible') {
            clip.top = Math.max(clip.top, box.top + ancestor.clientTop)
            clip.bottom = Math.min(clip.bottom, box.top + ancestor.clientTop + ancestor.clientHeight)
          }
          // This fixture is fixed to the viewport. The scrolling document's
          // body box does not clip it when a theme control scrolls into view.
          if (ancestor === fixture) break
        }
        const visibleText = [...range.getClientRects()].map(box => ({
          left: Math.max(box.left, clip.left), right: Math.min(box.right, clip.right),
          top: Math.max(box.top, clip.top), bottom: Math.min(box.bottom, clip.bottom),
        })).filter(box => box.left < box.right && box.top < box.bottom)
        const marks = [count, status].map(element => {
          const box = rect(element)
          // Badges ignore pointer events; their full painted box, rather than
          // hit testing, proves the count and status remain inside every clip.
          let fullyVisible = box.width > 0 && box.height > 0
            && box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= window.innerHeight
          for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
            const css = getComputedStyle(ancestor)
            if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) fullyVisible = false
            const bounds = rect(ancestor)
            if (css.overflowX !== 'visible' && (box.left < bounds.left || box.right > bounds.right)) fullyVisible = false
            if (css.overflowY !== 'visible' && (box.top < bounds.top || box.bottom > bounds.bottom)) fullyVisible = false
            if (ancestor === fixture) break
          }
          return { ...box, fullyVisible }
        })
        return { rail: rect(node.closest('nav')!), button: rect(button), label: rect(label),
          rawTextWidth: rawText.width, clipWidth: clip.right - clip.left, clip, visibleText,
          contentScrollWidth: content.scrollWidth, contentClientWidth: content.clientWidth, marks }
      })
      measurements.push({ state, ...measured })
      await testInfo.attach(`compact-navigation-${theme}-${state}.json`, {
        body: JSON.stringify(measured, null, 2), contentType: 'application/json',
      })
      expect(measured.rail.width, 'the mounted navigation rail is 200px wide').toBe(200)
      expect(measured.label.right, 'the flex label fits in its row').toBeLessThanOrEqual(measured.button.right + 0.5)
      expect(measured.label.width, 'the destination retains visible label space').toBeGreaterThan(0)
      expect(measured.rawTextWidth, 'the supplied label genuinely overflows').toBeGreaterThan(measured.clipWidth)
      expect(measured.contentScrollWidth, 'the label is clipped rather than fitted or shortened by the fixture').toBeGreaterThan(measured.contentClientWidth)
      expect(measured.visibleText.length, 'some destination text remains visible').toBeGreaterThan(0)
      const [count, status] = measured.marks
      for (const [index, mark] of measured.marks.entries()) {
        expect(mark.fullyVisible, `trailing mark ${index} is fully visible (${state})`).toBe(true)
        expect(mark.left).toBeGreaterThanOrEqual(measured.rail.left)
        expect(mark.right).toBeLessThanOrEqual(measured.rail.right)
        for (const text of measured.visibleText) {
          expect(text.right, `destination text clears trailing mark ${index} (${state})`).toBeLessThanOrEqual(mark.left)
          expect(text.bottom - text.top, 'the label stays on one line').toBeLessThanOrEqual(measured.button.height)
        }
      }
      expect(count!.right, `count and status occupy separate trailing slots (${state})`).toBeLessThanOrEqual(status!.left)
    }
    await testInfo.attach(`compact-navigation-${theme}.json`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
    await rail.screenshot({ path: testInfo.outputPath(`compact-navigation-${theme}.png`) })
  })
}
