import { expect, test, type Page } from '@playwright/test'

/**
 * The two shapes the transcript's message parts draw: a sent message is a
 * plate capped at two thirds of the reading column (`Bubble`'s own
 * `max-w-[66.6667%]`) and pinned to the right edge; an answer is unframed
 * prose that takes the whole row. Measured in the real engine, through the
 * real transcript row (`ItemView` → `UserMessage`/`AssistantMessage`) rather
 * than a hand-built fixture — a loose bound (anything under 80%, say) would
 * pass even if the cap moved or vanished, so the assertion is the cap
 * itself, tight enough that only that cap can satisfy it.
 */

const LONG_SENTENCE =
  'One long run of words with no line break the sender typed, long enough that wrapping is forced only by the bubble’s own maximum width rather than by anything in the text, so the measured width is genuinely the cap and not merely whatever the sentence happened to need.'

const mount = async (page: Page) => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import factsReact from ${JSON.stringify(reactUrl)};
        import { ItemView } from '/src/components/Items.tsx';
        // StoreProvider and emptySnapshot are already imported by the preview
        // harness above, sharing this module scope — importing either again
        // under the same name is a duplicate-declaration error.
        (() => {
          // The harness's own default scene is already mounted onto #root by
          // the code above (this script is appended after it) — hidden so it
          // does not paint under the fixture this rig mounts of its own.
          const defaultRoot = document.getElementById('root');
          if (defaultRoot) defaultRoot.style.display = 'none';
          const host = document.createElement('div');
          host.setAttribute('data-testid', 'message-fixture');
          host.style.width = '736px';
          document.body.append(host);
          const snapshot = { ...emptySnapshot(), status: 'open' };
          const fixtureStore = {
            subscribe: () => () => {},
            getSnapshot: () => snapshot,
            notice: () => {},
          };
          const h = factsReact.createElement;
          createRoot(host).render(
            h(StoreProvider, { store: fixtureStore },
              h(ItemView, {
                item: { id: 'w-long', type: 'userMessage', content: [{ type: 'text', text: ${JSON.stringify(LONG_SENTENCE)} }] },
                root: '/workspace',
              }),
              h(ItemView, {
                item: { id: 'w-answer', type: 'assistantMessage', phase: 'final', text: 'Ready to look at the change.' },
                root: '/workspace',
              }),
            ),
          );
        })();
      `,
    })
  })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
}

test('a sent message’s bubble caps at two thirds of the column, not eighty percent', async ({ page }) => {
  await mount(page)
  const host = page.getByTestId('message-fixture')
  const laid = await host.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const bubble = node.querySelector('[data-slot="bubble"][data-variant="secondary"]') as HTMLElement
    const rect = bubble.getBoundingClientRect()
    return { hostWidth: box.width, hostRight: box.right, bubbleWidth: rect.width, bubbleRight: rect.right }
  })
  // The real cap, read from the source: two thirds of the row, not "under 80%"
  // — a bound loose enough to pass at any cap, or none, proves nothing.
  const cap = laid.hostWidth * (2 / 3)
  expect(Math.abs(laid.bubbleWidth - cap)).toBeLessThanOrEqual(2)
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
