import { expect, test } from '@playwright/test'

/**
 * The two shapes the transcript's message parts draw: a sent message is a
 * plate sized to its own words, capped well under the reading column and
 * pinned to the right edge; an answer is unframed prose that takes the whole
 * row. Measured in the real engine — a `max-w-[66.6667%]` utility, or a
 * `Message` with the wrong side's `items-*`, compiles fine and lays out wrong,
 * and jsdom does not lay anything out at all.
 */

const mount = async (page: import('@playwright/test').Page) => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import factsReact from ${JSON.stringify(reactUrl)};
        import { Message, Bubble, BubbleContent } from '/src/design/index.ts';
        const host = document.createElement('div');
        host.setAttribute('data-testid', 'message-fixture');
        host.style.width = '736px';
        document.body.append(host);
        const h = factsReact.createElement;
        createRoot(host).render(
          h('div', null,
            h(Message, { align: 'end' },
              h(Bubble, { variant: 'secondary' },
                h(BubbleContent, { variant: 'secondary' }, 'Does the gate need the renderer in CI too?'),
              ),
            ),
            h(Message, { align: 'start' },
              h(Bubble, { variant: 'ghost' },
                h(BubbleContent, { variant: 'ghost' }, 'Ready to look at the change — one moment.'),
              ),
            ),
          ),
        );
      `,
    })
  })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
}

test('a sent message stays under 80% of the column and pinned to its right edge', async ({ page }) => {
  await mount(page)
  const host = page.getByTestId('message-fixture')
  const laid = await host.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const bubble = node.querySelector('[data-slot="bubble"][data-variant="secondary"]') as HTMLElement
    const rect = bubble.getBoundingClientRect()
    return { hostWidth: box.width, hostRight: box.right, bubbleWidth: rect.width, bubbleRight: rect.right }
  })
  expect(laid.bubbleWidth).toBeLessThanOrEqual(laid.hostWidth * 0.8)
  // Right-aligned: its own right edge meets the row's, not floating short of it.
  expect(Math.abs(laid.bubbleRight - laid.hostRight)).toBeLessThanOrEqual(1)
})

test('an answer spans the full row, unframed', async ({ page }) => {
  await mount(page)
  const host = page.getByTestId('message-fixture')
  const laid = await host.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const bubble = node.querySelector('[data-slot="bubble"][data-variant="ghost"]') as HTMLElement
    const rect = bubble.getBoundingClientRect()
    const style = getComputedStyle(bubble)
    return {
      hostWidth: box.width,
      bubbleWidth: rect.width,
      background: style.backgroundColor,
      radius: style.borderRadius,
    }
  })
  expect(laid.bubbleWidth).toBeGreaterThanOrEqual(laid.hostWidth - 1)
  // Unframed: no fill, no corner — the row itself, not a second box on the
  // Markdown answer's own blocks.
  expect(laid.background).toMatch(/^(rgba\(0, 0, 0, 0\)|transparent)$/)
  expect(laid.radius).toBe('0px')
})
