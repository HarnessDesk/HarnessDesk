import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark']) {
  for (const [width, multiple] of [[465, false], [465, true], [320, true], [900, true]] as const) {
    test(`detail head preserves its reading measure at ${width}px with ${multiple ? 'several actions' : 'one action'} in ${theme}`, async ({ page }, testInfo) => {
      // Supply only the content; the component, buttons and cascade are real.
      await page.route('**/src/design/explorer/main.tsx*', async route => {
        const response = await route.fetch()
        const source = await response.text()
        const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
        if (!reactUrl) throw new Error('explorer React module import was not found')
        await route.fulfill({
          response,
          body: `${source}
            import fixtureReact from ${JSON.stringify(reactUrl)};
            import { DetailHead, DetailMark, Button } from '/src/design/index.ts';
            document.getElementById('root').hidden = true;
            const frame = document.createElement('section');
            frame.setAttribute('aria-label', 'Detail head fixture');
            frame.style.cssText = 'width: ${width}px; margin: 24px';
            document.body.append(frame);
            const h = fixtureReact.createElement;
            const labels = ${JSON.stringify(multiple ? ['Start a conversation as Review assistant', 'Customize…', 'Remove…'] : ['Reset to default'])};
            createRoot(frame).render(h(DetailHead, {
              mark: h(DetailMark, null, 'R'), name: 'Review assistant', owner: 'built in',
              blurb: 'Read the proposed changes and explain the risks before starting a conversation.',
              actions: labels.map(label => h(Button, { key: label, variant: 'outline' }, label)),
            }));
          `,
        })
      })
      await page.goto('/design.html')
      const frame = page.getByRole('region', { name: 'Detail head fixture' })
      await expect(frame.getByRole('button').first()).toBeVisible()
      await page.evaluate(theme => document.body.toggleAttribute('data-hd-dark-theme', theme === 'dark'), theme)
      await page.evaluate(() => document.fonts.ready)
      const layout = await frame.evaluate(node => {
        const head = node.firstElementChild!
        const text = head.querySelector('[class*="detailText"]')!.getBoundingClientRect()
        const actions = head.querySelector('[class*="detailCtl"]')!.getBoundingClientRect()
        const box = head.getBoundingClientRect()
        return {
          textWidth: text.width, textTop: text.top, textBottom: text.bottom,
          actionsTop: actions.top, actionsRight: actions.right, right: box.right,
          buttonRows: [...head.querySelectorAll('button')].map(button => button.getBoundingClientRect().top),
          overflow: head.scrollWidth - head.clientWidth,
        }
      })
      expect(layout.textWidth).toBeGreaterThanOrEqual(256)
      expect(layout.overflow).toBeLessThanOrEqual(1)
      if (multiple && width < 900) {
        expect(layout.actionsTop).toBeGreaterThan(layout.textBottom)
        expect(new Set(layout.buttonRows).size).toBeGreaterThan(1)
      } else {
        expect(layout.actionsTop).toBe(layout.textTop)
        expect(layout.buttonRows[0] - layout.textTop).toBe(6)
        expect(layout.actionsRight).toBe(layout.right)
      }
      await frame.screenshot({ path: testInfo.outputPath('detail-head.png') })
    })
  }
}
