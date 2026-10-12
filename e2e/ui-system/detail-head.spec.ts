import { expect, test } from '@playwright/test'
import { FRAME } from '../../packages/ui/src/design/frame'

// Phase C moved a detail page's identity and actions into the canonical bar.
// Exercise the replacement at every former detail-head width, preserving
// the reading floor and overflow ceiling and checking the real fold anatomy.
for (const theme of ['light', 'dark']) {
  for (const [width, multiple] of [[465, false], [465, true], [320, true], [900, true]] as const) {
    test(`detail page preserves its reading measure at ${width}px with ${multiple ? 'several actions' : 'one action'} in ${theme}`, async ({ page }, testInfo) => {
      const labels = multiple ? ['Start a conversation as Review assistant', 'Customize…', 'Remove…'] : ['Reset to default']
      await page.route('**/src/design/explorer/main.tsx*', async route => {
        const response = await route.fetch(), source = await response.text()
        const reactUrl = /from ['"]([^'"\n]*\/react\.js[^'"\n]*)['"]/.exec(source)?.[1]
        if (!reactUrl) throw new Error('explorer React module import was not found')
        await route.fulfill({ response, body: `${source}
          import fixtureReact from ${JSON.stringify(reactUrl)};
          import { TopBar, Page, PageExplanation, IconTile, MenuItem } from '/src/design/index.ts';
          import { ArrowRightIcon } from '/src/components/Icons.tsx';
          document.getElementById('root').hidden = true;
          const frame = document.createElement('section');
          frame.setAttribute('aria-label', 'Detail page fixture');
          frame.style.cssText = 'width:${width}px;margin:24px'; document.body.append(frame);
          const h = fixtureReact.createElement, labels = ${JSON.stringify(labels)};
          createRoot(frame).render(h(fixtureReact.Fragment, null,
            h(TopBar, { place:'Review assistant', mark:h(IconTile,{shape:'face',size:'sm'},'R'),
              verb:{label:labels[0],run:()=>{}},
              more:close=>labels.slice(1).map(label=>h(MenuItem,{key:label,label,icon:h(ArrowRightIcon,{size:16}),onSelect:close})) }),
            h(Page,{width:'reading'},h(PageExplanation,null,
              'Read the proposed changes and explain the risks before starting a conversation.'))));
        ` })
      })
      await page.goto(`/design.html?theme=${theme}`)
      const frame = page.getByRole('region', { name: 'Detail page fixture' })
      const bar = frame.locator('[data-slot="top-bar"]')
      await expect(bar).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const layout = await frame.evaluate(node => {
        const bar = node.querySelector('[data-slot="top-bar"]')!, body = node.querySelector('[data-slot="page"]')!
        const css = getComputedStyle(body), box = body.getBoundingClientRect()
        return { textWidth:box.width-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight),
          overflow:node.scrollWidth-node.clientWidth, barHeight:bar.parentElement!.getBoundingClientRect().height,
          bodyBelow:box.top>=bar.parentElement!.getBoundingClientRect().bottom }
      })
      expect(layout.textWidth).toBeGreaterThanOrEqual(256)
      expect(layout.overflow).toBeLessThanOrEqual(1)
      expect(layout.barHeight).toBe(FRAME.bar.height)
      expect(layout.bodyBelow).toBe(true)
      const verb = bar.getByRole('button', { name: labels[0], exact: true })
      const direct = await verb.isVisible()
      if (direct) {
        const text = (await bar.locator('[data-topbar-title]').boundingBox())!, button = (await verb.boundingBox())!
        expect(Math.abs(button.y-text.y)).toBe(4)
      }
      if (multiple || !direct) {
        await bar.getByRole('button', { name: 'More', exact: true }).click()
        const menu = page.getByRole('menu')
        for (const label of labels.slice(direct ? 1 : 0)) await expect(menu.getByRole('menuitem', { name: label, exact: true })).toBeVisible()
        const plate = menu.locator('xpath=ancestor::*[@data-slot="popover-popup"]')
        const box = (await plate.boundingBox())!
        const inner = (await menu.boundingBox())!
        expect(inner.x).toBeGreaterThanOrEqual(box.x)
        expect(inner.x + inner.width).toBeLessThanOrEqual(box.x + box.width)
        expect(box.width).toBeGreaterThanOrEqual(200)
        expect(box.width).toBeLessThanOrEqual(340)
        await page.keyboard.press('Escape')
      }
      await frame.screenshot({ path: testInfo.outputPath('detail-page.png') })
    })
  }
}
