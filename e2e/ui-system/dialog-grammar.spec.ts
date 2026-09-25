import { expect, test, type Page } from '@playwright/test'

/**
 * A dialog's footer and form, measured in the real engine.
 *
 * - A footer quiets its secondary buttons only beside a filled act; a lone
 *   Close keeps its frame.
 * - A disabled filled act (the ink or the red one) is one treatment: its own
 *   hue dimmed toward the footer's ground, clearly weaker than enabled, in
 *   both themes. The contrasts are computed from what the engine paints.
 * - A radio group that is not all `RowChoice` rows keeps its card: the
 *   branch picker in New worktree has its edge and its ground.
 * - Choosing an answer in a `ChoiceList` moves nothing.
 */

const mount = async (page: Page) => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import gramReact from ${JSON.stringify(reactUrl)};
        import { Dialog } from '/src/design/patterns/ModalDialog.tsx';
        import { ChoiceList } from '/src/design/patterns/DialogForm.tsx';
        import { Button } from '/src/design/ui/button.tsx';
        import { NewWorktree } from '/src/components/NewWorktree.tsx';
        import { StoreProvider as GramStore } from '/src/state/context.tsx';
        import { emptySnapshot as gramEmpty } from '/src/state/store.ts';
        const h = gramReact.createElement;
        const gramProject = { path: '/repos/storefront', name: 'storefront', lastOpenedAt: 1 };
        const gramSnapshot = { ...gramEmpty(), status: 'open', workspaces: [gramProject], workspace: gramProject };
        const gramStore = {
          subscribe: () => () => {}, getSnapshot: () => gramSnapshot,
          armWorktree: async () => true, newSession: async () => 'x', openWorkspace: async () => {},
          listBranches: async () => [
            { name: 'main', current: true, committedAt: 3 },
            { name: 'feat/checkout-retry', current: false, committedAt: 2 },
            { name: 'fix/webhook', current: false, committedAt: 1 },
          ],
        };
        const Fixture = () => {
          const [open, setOpen] = gramReact.useState(new URLSearchParams(location.hash.slice(1)).get('open'));
          const [value, setValue] = gramReact.useState('read');
          const close = () => setOpen(null);
          window.__open = setOpen;
          return h('div', null,
            open === 'pair' && h(Dialog, { title: 'Pair', onClose: close,
              footer: h(gramReact.Fragment, null, h(Button, null, 'Save'), h(Button, { variant: 'secondary' }, 'Cancel')) }, 'Body'),
            open === 'lone' && h(Dialog, { title: 'Lone', onClose: close, footer: h(Button, { variant: 'secondary' }, 'Close') }, 'Body'),
            open === 'disabled' && h(Dialog, { title: 'Disabled', onClose: close,
              footer: h(gramReact.Fragment, null,
                h(Button, { 'data-testid': 'on-default' }, 'Save'),
                h(Button, { 'data-testid': 'off-default', disabled: true }, 'Save'),
                h(Button, { variant: 'danger', 'data-testid': 'on-danger' }, 'Delete'),
                h(Button, { variant: 'danger', 'data-testid': 'off-danger', disabled: true }, 'Delete')) }, 'Body'),
            open === 'choice' && h(Dialog, { title: 'Choice', onClose: close },
              h(ChoiceList, { label: 'Ceiling', value, onChange: setValue, options: [
                { value: 'read', title: 'Read', description: 'Changes nothing: it reads, searches and reports.' },
                { value: 'edit', title: 'Edit', description: 'May change files and commit in its own checkout.' },
                { value: 'publish', title: 'Publish', description: 'May push its own branch and open a pull request.' },
                { value: 'merge', title: 'Merge', description: 'May merge what it is asked to merge.' },
              ] })),
            open === 'worktree' && h(GramStore, { store: gramStore }, h(NewWorktree, { root: '/repos/storefront', onClose: close })),
          );
        };
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Grammar fixture');
        document.body.append(frame);
        createRoot(frame).render(h(Fixture));
      `,
    })
  })
  await page.goto('/preview.html')
  await page.waitForFunction(() => typeof (window as unknown as { __open?: unknown }).__open === 'function')
}

const open = async (page: Page, which: string) => {
  await page.evaluate((one) => (window as unknown as { __open: (v: string) => void }).__open(one), which)
  const dialog = page.getByRole('dialog', { name: which[0]!.toUpperCase() + which.slice(1), exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}

type Rgb = [number, number, number]
/** The painted colour of `property`, whether the engine says rgb() or color(srgb …). */
const painted = (page: Page, selector: string, property: 'color' | 'backgroundColor'): Promise<Rgb> =>
  page.locator(selector).first().evaluate((node, prop) => {
    const probe = document.createElement('span')
    probe.style.color = getComputedStyle(node)[prop as 'color']
    document.body.append(probe)
    const canvas = document.createElement('canvas').getContext('2d')!
    canvas.fillStyle = getComputedStyle(probe).color
    canvas.fillRect(0, 0, 1, 1)
    const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data
    probe.remove()
    return [r!, g!, b!] as [number, number, number]
  }, property)

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrast = (a: Rgb, b: Rgb): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
  return (x + 0.05) / (y + 0.05)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await mount(page)
})

test('a footer quiets Cancel beside a filled act, and leaves a lone Close its frame', async ({ page }) => {
  let dialog = await open(page, 'pair')
  const ground = (name: string) => dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name, exact: true }).evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(await ground('Cancel')).toBe('rgba(0, 0, 0, 0)')
  expect(await ground('Save')).not.toBe('rgba(0, 0, 0, 0)')
  await page.keyboard.press('Escape')
  dialog = await open(page, 'lone')
  expect(await ground('Close'), 'a lone Close keeps its fill').not.toBe('rgba(0, 0, 0, 0)')
})

for (const theme of ['light', 'dark'] as const) {
  test(`a disabled filled act is its own hue dimmed toward the footer, clearly weaker (${theme})`, async ({ page }) => {
    if (theme === 'dark') await page.evaluate(() => document.body.setAttribute('data-hd-dark-theme', ''))
    await open(page, 'disabled')
    const footer = await painted(page, '[aria-label="Disabled"] [data-slot="dialog-footer"]', 'backgroundColor')
    const report: string[] = []
    for (const variant of ['default', 'danger']) {
      const on = { fill: await painted(page, `[data-testid="on-${variant}"]`, 'backgroundColor'), ink: await painted(page, `[data-testid="on-${variant}"]`, 'color') }
      const off = { fill: await painted(page, `[data-testid="off-${variant}"]`, 'backgroundColor'), ink: await painted(page, `[data-testid="off-${variant}"]`, 'color') }
      const opacity = await page.locator(`[data-testid="off-${variant}"]`).evaluate((node) => getComputedStyle(node).opacity)
      const line = {
        enabledLabel: contrast(on.ink, on.fill), disabledLabel: contrast(off.ink, off.fill),
        enabledShape: contrast(on.fill, footer), disabledShape: contrast(off.fill, footer),
      }
      report.push(`${theme} ${variant}: label ${line.enabledLabel.toFixed(2)} → ${line.disabledLabel.toFixed(2)}, fill/footer ${line.enabledShape.toFixed(2)} → ${line.disabledShape.toFixed(2)}`)
      expect(opacity, 'no half-opacity outlier').toBe('1')
      // Still a shape on the footer, still a label you can make out…
      expect(line.disabledShape).toBeGreaterThan(1.05)
      expect(line.disabledLabel).toBeGreaterThan(1.7)
      // …and clearly weaker than the enabled act.
      expect(line.disabledLabel).toBeLessThan(line.enabledLabel * 0.7)
      expect(line.disabledShape).toBeLessThan(line.enabledShape)
      // Its own hue: a red act stays red when disabled.
      if (variant === 'danger') expect(off.ink[0]).toBeGreaterThan(off.ink[1] + 30)
    }
    console.log(report.join('\n'))
  })
}

test('a radio group of row buttons keeps its card: New worktree’s branch picker', async ({ page }) => {
  await page.evaluate(() => (window as unknown as { __open: (v: string) => void }).__open('worktree'))
  const picker = page.getByRole('radiogroup', { name: 'Start the worktree from' })
  await expect(picker.getByRole('radio', { name: /feat\/checkout-retry/ })).toBeVisible()
  const box = await picker.evaluate((node) => {
    const style = getComputedStyle(node)
    return { border: parseFloat(style.borderTopWidth), ground: style.backgroundColor, left: node.getBoundingClientRect().left, marginLeft: style.marginLeft, slot: node.getAttribute('data-slot') }
  })
  expect(box.slot).toBeNull()
  expect(box.border, 'the card keeps its edge').toBeGreaterThanOrEqual(1)
  expect(box.ground, 'the card keeps its ground').not.toBe('rgba(0, 0, 0, 0)')
  expect(box.marginLeft).toBe('0px')
})

test('choosing an answer moves no row, and every answer shows its description', async ({ page }) => {
  const dialog = await open(page, 'choice')
  const rows = dialog.getByRole('radio')
  await expect(rows).toHaveCount(4)
  const boxes = () => rows.evaluateAll((nodes) => nodes.map((node) => { const r = node.getBoundingClientRect(); return [r.top, r.height] }))
  const before = await boxes()
  for (const index of [3, 1, 2, 0]) {
    await rows.nth(index).click()
    expect(await boxes()).toEqual(before)
  }
  for (const text of ['Changes nothing', 'May change files', 'May push', 'May merge']) await expect(dialog.getByText(text)).toBeVisible()
  // Named by the title alone.
  await expect(dialog.getByRole('radio', { name: 'Edit', exact: true })).toBeVisible()
  // The radio lines up with the dialog's text column.
  const edge = await dialog.locator('[data-slot="modal-dialog-body"]').evaluate((node) => node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft))
  const radio = await rows.first().locator('span').first().evaluate((node) => node.getBoundingClientRect().left)
  expect(Math.abs(radio - edge)).toBeLessThanOrEqual(1)
})
