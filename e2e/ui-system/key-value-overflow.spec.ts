import { expect, test } from '@playwright/test'

/**
 * A fact list holds a path and a sentence inside a narrow dialog.
 *
 * "Arm this trigger" drew its source path past the dialog's right edge and
 * set a three-line sentence flush right. The class of bug is a value column
 * that will not go below its longest word, and a list that right-aligns
 * whatever it is given. So this mounts the real Dialog and KeyValue in a
 * window narrow enough to force both, and asks the layout — not the classes.
 */
const PATH = '~/work/storefront-and-its-long-name/.harnessdesk/triggers/pull-requests/review.json'
const SENTENCE = 'When a pull request opens or is pushed, open review-pr, at most 4 at once.'

test('a path gives up its middle and a sentence wraps, inside a narrow dialog', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 800 })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import factsReact from ${JSON.stringify(reactUrl)};
        import { Dialog, KeyValue, KeyValueRow } from '/src/design/index.ts';
        const facts = document.createElement('section');
        facts.setAttribute('aria-label', 'Key/value fixture');
        document.body.append(facts);
        const h = factsReact.createElement;
        createRoot(facts).render(h(Dialog, { title: 'Arm this trigger', onClose: () => {} },
          h(KeyValue, null,
            h(KeyValueRow, { label: 'Source', kind: 'path' }, ${JSON.stringify(PATH)}),
            h(KeyValueRow, { label: 'Declares' }, ${JSON.stringify(SENTENCE)}),
            h(KeyValueRow, { label: 'Charged', numeric: true }, '$4.20'),
          ),
        ));
      `,
    })
  })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })

  const dialog = page.getByRole('dialog', { name: 'Arm this trigger' })
  await expect(dialog).toBeVisible()

  const laid = await dialog.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const values = [...node.querySelectorAll('[data-slot="key-value"] dd')] as HTMLElement[]
    const line = node.querySelector('[data-slot="middle-truncate"]') as HTMLElement
    const head = line.querySelector('[data-part="head"]') as HTMLElement
    const tail = line.querySelector('[data-part="tail"]') as HTMLElement
    const [path, sentence, money] = values
    const lineHeight = Number.parseFloat(getComputedStyle(sentence!).lineHeight)
    return {
      over: [...node.querySelectorAll('*')]
        .map((child) => child.getBoundingClientRect().right - box.right)
        .reduce((most, past) => Math.max(most, past), 0),
      pathRight: line.getBoundingClientRect().right - path!.getBoundingClientRect().right,
      headCut: head.scrollWidth > head.clientWidth,
      headShown: head.getBoundingClientRect().width,
      tailWhole: tail.scrollWidth <= tail.clientWidth,
      sentenceAlign: getComputedStyle(sentence!).textAlign,
      sentenceLines: Math.round(sentence!.getBoundingClientRect().height / lineHeight),
      moneyAlign: getComputedStyle(money!).textAlign,
      keysStart: [...node.querySelectorAll('[data-slot="key-value"] dt')].map((key) => Math.round(key.getBoundingClientRect().left)),
      valuesStart: values.slice(0, 2).map((value) => Math.round(value.getBoundingClientRect().left)),
    }
  })

  // Nothing past the dialog's edge, and the path inside its own column.
  expect(laid.over).toBeLessThanOrEqual(1)
  expect(laid.pathRight).toBeLessThanOrEqual(1)
  // The middle gave way; the file name did not; and some of the head is left to say so.
  expect(laid.headCut).toBe(true)
  expect(laid.headShown).toBeGreaterThan(10)
  expect(laid.tailWhole).toBe(true)
  // A sentence is set left and wraps; a number is set right.
  expect(laid.sentenceAlign).toMatch(/^(left|start)$/)
  expect(laid.sentenceLines).toBeGreaterThan(1)
  expect(laid.moneyAlign).toMatch(/^(right|end)$/)
  // One key column, one value column.
  expect(new Set(laid.keysStart).size).toBe(1)
  expect(new Set(laid.valuesStart).size).toBe(1)

  const line = dialog.locator('[data-slot="middle-truncate"]')
  await line.hover()
  await expect(line).toHaveAttribute('title', PATH)
})
