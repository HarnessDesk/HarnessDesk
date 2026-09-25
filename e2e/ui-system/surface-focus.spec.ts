import { expect, test, type Page } from '@playwright/test'

/**
 * A popup that holds focus never draws the focus ring round itself.
 *
 * A dialog, a confirm, a menu and a popover all take focus when they open, so
 * Escape reaches them and a reader lands inside. The document-wide
 * `:focus-visible` outline in `styles/app.css` then drew a 2px accent line
 * round the whole surface whenever the opening was a keystroke — a debug
 * border on the refusal sheet, the account menu and a dozen dialogs. The
 * surface is a mechanism, not a control, so it wears no ring; the controls
 * inside it keep theirs.
 *
 * Measured in the real engine on the dev server, where `app.css` is the last
 * sheet and so wins every tie: if a surface is clean here it is clean in any
 * bundle order.
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
        import ringReact from ${JSON.stringify(reactUrl)};
        import { Dialog } from '/src/design/patterns/ModalDialog.tsx';
        import { ConfirmDialog } from '/src/design/patterns/ConfirmDialog.tsx';
        import { Field } from '/src/design/patterns/Settings.tsx';
        import { Button } from '/src/design/ui/button.tsx';
        import { Input } from '/src/design/ui/input.tsx';
        import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuPositioner, DropdownMenuPopup } from '/src/design/ui/dropdown-menu.tsx';
        import { Popover, PopoverTrigger, PopoverContent } from '/src/design/ui/popover.tsx';
        const h = ringReact.createElement;
        const Fixture = () => {
          const [open, setOpen] = ringReact.useState(null);
          const close = () => setOpen(null);
          return h('div', { style: { display: 'flex', gap: 8, padding: 16 } },
            h(Button, { onClick: () => setOpen('plain') }, 'Open plain'),
            h(Button, { onClick: () => setOpen('form') }, 'Open form'),
            h(Button, { onClick: () => setOpen('confirm') }, 'Open confirm'),
            h(DropdownMenu, null,
              h(DropdownMenuTrigger, { render: h(Button, null) }, 'Open menu'),
              h(DropdownMenuContent, { 'data-testid': 'menu-content' }, h(DropdownMenuItem, null, 'One'), h(DropdownMenuItem, null, 'Two'))),
            h(DropdownMenu, null,
              h(DropdownMenuTrigger, { render: h(Button, null) }, 'Open level'),
              h(DropdownMenuPortal, null, h(DropdownMenuPositioner, null,
                h(DropdownMenuPopup, { 'data-testid': 'menu-popup', className: 'plain-level' }, h(DropdownMenuItem, null, 'Three'))))),
            h(Popover, null,
              h(PopoverTrigger, { render: h(Button, null) }, 'Open popover'),
              h(PopoverContent, { 'data-testid': 'popover-content' }, h(Button, null, 'Inside'))),
            open === 'plain' && h(Dialog, { title: 'Nothing to type', onClose: close,
              footer: h(ringReact.Fragment, null, h(Button, { onClick: close }, 'Done'), h(Button, { variant: 'secondary', onClick: close }, 'Cancel')) },
              h('p', null, 'A dialog with no field focuses its own surface.')),
            open === 'form' && h(Dialog, { title: 'Something to type', onClose: close,
              footer: h(Button, { onClick: close }, 'Save') },
              h('p', null, 'A dialog with a field focuses the field.'),
              h(Field, { label: 'Name' }, (control) => h(Input, { ...control, 'data-testid': 'first-field' }))),
            open === 'confirm' && h(ConfirmDialog, { title: 'Remove it?', confirmLabel: 'Remove', tone: 'destructive', onConfirm: close, onCancel: close }, 'It goes.'),
          );
        };
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Ring fixture');
        frame.style.cssText = 'position:fixed;inset:0 auto auto 0;z-index:99999;background:var(--hd-background)';
        document.body.append(frame);
        createRoot(frame).render(h(Fixture));
      `,
    })
  })
  await page.goto('/preview.html')
  await expect(page.getByRole('region', { name: 'Ring fixture' })).toBeVisible()
}

/** Opens the named trigger with the keyboard, the modality that draws a ring. */
const openByKeyboard = async (page: Page, name: string) => {
  const trigger = page.getByRole('region', { name: 'Ring fixture' }).getByRole('button', { name, exact: true })
  await trigger.focus()
  await page.keyboard.press('Enter')
}

const ringOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((node) => {
    const style = getComputedStyle(node)
    return { style: style.outlineStyle, width: style.outlineWidth, visible: node.matches(':focus-visible') }
  })

const focusedRing = (page: Page) =>
  page.evaluate(() => {
    const node = document.activeElement as HTMLElement
    const style = getComputedStyle(node)
    return { tag: node.tagName, text: node.textContent?.trim(), style: style.outlineStyle, width: style.outlineWidth, visible: node.matches(':focus-visible') }
  })

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 })
  await mount(page)
})

test('a dialog with no field takes focus on its surface and draws no ring round it; its buttons keep theirs', async ({ page }) => {
  await openByKeyboard(page, 'Open plain')
  const dialog = page.getByRole('dialog', { name: 'Nothing to type' })
  await expect(dialog).toBeVisible()
  await expect.poll(() => dialog.evaluate((node) => node === document.activeElement)).toBe(true)
  const surface = await ringOf(page, '[data-slot="dialog-content"]')
  // The guard on the guard: the surface really is keyboard-focused, so the
  // global rule is in play and only the primitive keeps it off.
  expect(surface.visible, 'the surface matches :focus-visible').toBe(true)
  expect(surface.style, 'the dialog surface draws no outline').toBe('none')

  await page.keyboard.press('Tab')
  const inside = await focusedRing(page)
  expect(inside.tag).toBe('BUTTON')
  expect(inside.visible).toBe(true)
  expect(inside.style, `${inside.text} keeps its ring`).toBe('solid')
  expect(parseFloat(inside.width)).toBeGreaterThan(0)
})

test('a dialog with a field puts focus in the first field', async ({ page }) => {
  await openByKeyboard(page, 'Open form')
  await expect(page.getByRole('dialog', { name: 'Something to type' })).toBeVisible()
  await expect(page.getByTestId('first-field')).toBeFocused()
  expect((await ringOf(page, '[data-slot="dialog-content"]')).style).toBe('none')
})

test('a confirm, a menu and a popover draw no ring round their surface', async ({ page }) => {
  const cases: [string, string][] = [
    ['Open confirm', '[data-slot="alert-dialog-content"]'],
    ['Open menu', '[data-testid="menu-content"]'],
    ['Open level', '[data-testid="menu-popup"]'],
    ['Open popover', '[data-testid="popover-content"]'],
  ]
  for (const [name, selector] of cases) {
    await openByKeyboard(page, name)
    const surface = page.locator(selector).first()
    await expect(surface).toBeVisible()
    // Whatever the primitive focused on open, the surface itself is where a
    // pointer-opened popup or Escape handling lands; focus it after a keystroke
    // so `:focus-visible` holds.
    await page.keyboard.press('Shift')
    await surface.evaluate((node: HTMLElement) => node.focus())
    const ring = await ringOf(page, selector)
    expect(ring.visible, `${name}: the surface matches :focus-visible`).toBe(true)
    expect(ring.style, `${name}: the surface draws no outline`).toBe('none')
    await page.keyboard.press('Escape')
    await expect(surface).toBeHidden()
  }
})
