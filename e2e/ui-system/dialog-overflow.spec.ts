import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) test(`Storage cleanup keeps its full consequence visible in a short window (${theme})`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 520 })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({ response, body: `${source}
      import storageReact from ${JSON.stringify(reactUrl)};
      import { StorageSection as DescriptionStorageSection } from '/src/components/Storage.tsx';
      import { StoreProvider as StorageStoreProvider } from '/src/state/context.tsx';
      import { emptySnapshot as emptyStorageSnapshot } from '/src/state/store.ts';
      const storageSnapshot = emptyStorageSnapshot();
      const reading = { bytes: 1024, count: 12, computing: false };
      const storageFixture = {
        subscribe: () => () => {}, getSnapshot: () => storageSnapshot,
        subscribeStorageUsage: () => () => {},
        transport: { request: async method => {
          if (method === 'storage/usage') return { database: reading, snapshots: reading, cachedPreviews: reading, worktrees: reading };
          if (method === 'storage/kept') return [];
          if (method === 'storage/cleanupPreview') return {
            cleanBytes: 12288, dirtyBytes: 0, inventoryToken: 'storage-dialog-fixture', // hd-secrets-ok: synthetic storage preview inventory stamp
            candidates: Array.from({ length: 12 }, (_, at) => ({
              runtime: 'demo', sessionId: 'inactive-' + at, title: 'Inactive conversation ' + (at + 1),
              path: '/work/demo-' + at, bytes: 1024, clean: true,
            })),
          };
          throw new Error('The description fixture does not perform storage mutations');
        } },
      };
      const storageFrame = document.createElement('section');
      storageFrame.setAttribute('aria-label', 'Storage description fixture');
      document.body.append(storageFrame);
      createRoot(storageFrame).render(storageReact.createElement(StorageStoreProvider, { store: storageFixture }, storageReact.createElement(DescriptionStorageSection)));
    ` })
  })
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  await page.getByRole('region', { name: 'Storage description fixture' }).getByRole('button', { name: 'Review…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Clean up inactive conversations', exact: true })
  await expect(dialog).toBeVisible()
  const description = dialog.locator('[data-slot="dialog-description"]')
  await expect(description).toHaveText('Conversations and branches stay. Reopening a conversation recreates its worktree.')
  await expect(description).not.toHaveAttribute('tabindex')
  const held = await dialog.evaluate(node => {
    const head = node.querySelector<HTMLElement>('[data-slot="dialog-head"]')!, desc = head.querySelector<HTMLElement>('[data-slot="dialog-description"]')!
    const footer = node.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!, body = node.querySelector<HTMLElement>('[data-slot="modal-dialog-body"]')!
    const range = document.createRange(); range.selectNodeContents(desc)
    const ink = range.getBoundingClientRect(), h = head.getBoundingClientRect(), d = node.getBoundingClientRect(), f = footer.getBoundingClientRect(), css = getComputedStyle(desc)
    return {
      whiteSpace: css.whiteSpace, textOverflow: css.textOverflow,
      lines: desc.clientHeight / Number.parseFloat(css.lineHeight),
      inkSpill: Math.max(h.top - ink.top, ink.bottom - h.bottom, h.left - ink.left, ink.right - h.right),
      horizontalSpill: node.scrollWidth - node.clientWidth,
      viewportSpill: Math.max(-d.top, d.bottom - innerHeight, -d.left, d.right - innerWidth),
      footerSpill: f.bottom - d.bottom, bodyHeight: body.clientHeight, bodyScroll: body.scrollHeight - body.clientHeight,
      cards: [...body.querySelectorAll<HTMLElement>('[data-slot="rows"]')].map(card => {
        const rows = [...card.querySelectorAll<HTMLElement>(':scope > [data-slot="row"]')]
        const c = card.getBoundingClientRect()
        return { height: c.height, contentHeight: rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0),
          clipped: card.scrollHeight - card.clientHeight,
          rowHeights: rows.map(row => row.getBoundingClientRect().height),
          rowFloor: parseFloat(getComputedStyle(card).getPropertyValue('--hd-table-row-min-bare')) }
      }),
    }
  })
  expect(held.whiteSpace).toBe('normal')
  expect(held.textOverflow).not.toBe('ellipsis')
  expect(held.lines).toBeGreaterThan(1)
  expect(held.inkSpill).toBeLessThanOrEqual(1)
  expect(held.horizontalSpill).toBeLessThanOrEqual(1)
  expect(held.viewportSpill).toBeLessThanOrEqual(1)
  expect(held.footerSpill).toBeLessThanOrEqual(1)
  expect(held.bodyHeight).toBeGreaterThan(0)
  expect(held.bodyScroll).toBeGreaterThan(0)
  expect(held.cards).toHaveLength(1)
  expect(held.cards[0]!.rowHeights).toHaveLength(12)
  for (const card of held.cards) {
    expect(card.height, 'the candidate card contains every row at its full height').toBeGreaterThanOrEqual(card.contentHeight)
    expect(card.clipped, 'candidate rows scroll with the dialog body, not behind a clipped card').toBeLessThanOrEqual(1)
    for (const height of card.rowHeights) expect(height, 'a candidate retains the table row floor').toBeGreaterThanOrEqual(card.rowFloor)
  }
  await dialog.getByText('Inactive conversation 12', { exact: true }).scrollIntoViewIfNeeded()
  await expect(dialog.getByText('Inactive conversation 12', { exact: true })).toBeVisible()
  expect(await dialog.locator('[data-slot="modal-dialog-body"]').evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await dialog.locator('[data-slot="dialog-footer"]').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

for (const height of [520, 720]) for (const theme of ['light', 'dark'] as const) test(`an authored consequence wraps whole across three or four lines (${height} ${theme})`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height })
  const consequence = 'Conversations and branches stay. Existing projects keep their folders and their saved work. New chats use the selected location. Reopening a conversation recreates its worktree in that same location.'
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({ response, body: `${source}
      import authoredReact from ${JSON.stringify(reactUrl)};
      import { Dialog as AuthoredDialog } from '/src/design/patterns/ModalDialog.tsx';
      import { Button as AuthoredButton } from '/src/design/ui/button.tsx';
      const authoredFrame = document.createElement('section');
      document.body.append(authoredFrame);
      const AuthoredFixture = () => {
        const [open, setOpen] = authoredReact.useState(false);
        return open ? authoredReact.createElement(AuthoredDialog, {
          title: 'Change chats location', description: ${JSON.stringify(consequence)}, onClose: () => setOpen(false),
          footer: authoredReact.createElement(AuthoredButton, { onClick: () => setOpen(false) }, 'Continue'),
        }, authoredReact.createElement('p', null, 'Choose the location for new chats.'))
          : authoredReact.createElement(AuthoredButton, { onClick: () => setOpen(true) }, 'Open authored consequence');
      };
      createRoot(authoredFrame).render(authoredReact.createElement(AuthoredFixture));
    ` })
  })
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  await page.getByRole('button', { name: 'Open authored consequence', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Change chats location', exact: true })
  await expect(dialog).toHaveAccessibleDescription(consequence)
  const description = dialog.locator('[data-slot="dialog-description"]')
  await expect(description).not.toHaveAttribute('tabindex')
  const held = await description.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node)
    const ink = range.getBoundingClientRect(), d = node.getBoundingClientRect(), css = getComputedStyle(node)
    return { lines: node.clientHeight / Number.parseFloat(css.lineHeight), maxHeight: css.maxHeight,
      clipped: node.scrollHeight - node.clientHeight,
      inkSpill: Math.max(d.top - ink.top, ink.bottom - d.bottom, d.left - ink.left, ink.right - d.right) }
  })
  expect(held.lines).toBeGreaterThanOrEqual(3)
  expect(held.lines).toBeLessThanOrEqual(4)
  expect(held.maxHeight).toBe('none')
  expect(held.clipped).toBeLessThanOrEqual(1)
  expect(held.inkSpill).toBeLessThanOrEqual(1)
  await expect(dialog.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(dialog).toHaveCount(0)
})

for (const height of [520, 900]) for (const theme of ['light', 'dark'] as const) test(`a long folder refusal leaves its body and actions reachable (${height} ${theme})`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({ response, body: `${source}
      import folderReact from ${JSON.stringify(reactUrl)};
      import { FolderPicker as RefusedFolderPicker } from '/src/components/FolderPicker.tsx';
      import { StoreProvider as FolderStoreProvider } from '/src/state/context.tsx';
      import { emptySnapshot as emptyFolderSnapshot } from '/src/state/store.ts';
      import { Button as FolderFixtureButton } from '/src/design/ui/button.tsx';
      const folderSnapshot = emptyFolderSnapshot();
      const folderFixtureStore = {
        subscribe: () => () => {}, getSnapshot: () => folderSnapshot,
        transport: { request: async method => {
          if (method === 'workspace/browse') return { path: '/work', parent: '/', entries: Array.from({ length: 20 }, (_, at) => ({ name: 'Folder ' + at, path: '/work/folder-' + at })) };
          throw new Error('The refusal fixture does not perform filesystem mutations');
        } },
      };
      const folderProblem = 'The chosen chats location contains an opened project: /work/' + 'nested-directory/'.repeat(45) + 'project';
      const folderFixtureFrame = document.createElement('section');
      folderFixtureFrame.setAttribute('aria-label', 'Folder refusal fixture');
      document.body.append(folderFixtureFrame);
      const RefusedFolderFixture = () => {
        const [open, setOpen] = folderReact.useState(false);
        return folderReact.createElement(FolderStoreProvider, { store: folderFixtureStore }, open
          ? folderReact.createElement(RefusedFolderPicker, { title: 'Chats folder', problem: folderProblem,
            onChoose: async path => { folderFixtureFrame.dataset.chosen = path; return false; }, onClose: () => setOpen(false) })
          : folderReact.createElement(FolderFixtureButton, { onClick: () => setOpen(true) }, 'Open refused folder'));
      };
      createRoot(folderFixtureFrame).render(folderReact.createElement(RefusedFolderFixture));
    ` })
  })
  await page.goto('/preview.html')
  await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
  const opener = page.getByRole('button', { name: 'Open refused folder', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Chats folder', exact: true })
  const problem = 'The chosen chats location contains an opened project: /work/' + 'nested-directory/'.repeat(45) + 'project'
  await expect(dialog).toHaveAccessibleDescription(problem)
  const description = dialog.locator('[data-slot="dialog-description"]')
  await expect(description).toHaveText(problem)
  const held = await dialog.evaluate(node => {
    const d = node.getBoundingClientRect(), body = node.querySelector<HTMLElement>('[data-slot="modal-dialog-body"]')!, footer = node.querySelector<HTMLElement>('[data-slot="dialog-footer"]')!
    const description = node.querySelector<HTMLElement>('[data-slot="dialog-description"]')!, f = footer.getBoundingClientRect()
    const list = body.querySelector<HTMLElement>('[data-slot="navigation-list"]')!, row = list.querySelector('button')!
    const b = body.getBoundingClientRect(), l = list.getBoundingClientRect(), r = row.getBoundingClientRect()
    const prelude = body.querySelector<HTMLElement>('[data-slot="dialog-body-prelude"]')!.getBoundingClientRect()
    return { bodyHeight: body.clientHeight, footerSpill: f.bottom - d.bottom,
      viewportSpill: Math.max(-d.top, d.bottom - innerHeight), horizontalSpill: node.scrollWidth - node.clientWidth,
      reasonScroll: description.scrollHeight - description.clientHeight, reasonHeight: description.getBoundingClientRect().height,
      folderHeight: r.height, visibleFolderHeight: Math.max(0, Math.min(r.bottom, l.bottom, b.bottom) - Math.max(r.top, l.top, b.top, prelude.bottom)),
      lineHeight: Number.parseFloat(getComputedStyle(description).lineHeight) }
  })
  expect(held.bodyHeight).toBeGreaterThan(0)
  expect(held.folderHeight).toBeGreaterThan(0)
  expect(held.visibleFolderHeight).toBeGreaterThanOrEqual(held.folderHeight - 1)
  expect(held.footerSpill).toBeLessThanOrEqual(1)
  expect(held.viewportSpill).toBeLessThanOrEqual(1)
  expect(held.horizontalSpill).toBeLessThanOrEqual(1)
  expect(held.reasonScroll).toBeGreaterThan(0)
  expect(held.reasonHeight).toBe(Math.max(held.lineHeight, Math.min(Math.floor(height * .08 / held.lineHeight) * held.lineHeight, held.lineHeight * 4)))
  await expect(description).toHaveAttribute('tabindex', '0')
  await page.keyboard.press('Tab')
  await expect(description).toBeFocused()
  await page.keyboard.press('PageDown')
  await expect.poll(() => description.evaluate(node => node.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('End')
  await expect.poll(() => description.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1)
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Open “work”', exact: true }).click()
  // The refused choice keeps the modal open, so Base UI hides this background fixture from role queries.
  await expect(page.locator('section[aria-label="Folder refusal fixture"]')).toHaveAttribute('data-chosen', '/work')
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await opener.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

/**
 * A dialog holds what it is given, in both directions.
 *
 * The hand-off sheet did neither. Its three choices were drawn at the `sm`
 * control size — a fixed 28px box whose base does not wrap — so the hint under
 * each label ran the row wider than the dialog and the dialog grew a horizontal
 * scrollbar, while the two lines of the choice itself sat outside the 28px they
 * had been given. On screen that reads as the labels being cut off at the left
 * and the descriptions running off to the right, which is what was reported.
 *
 * The check is the class rather than the case: nothing inside a dialog may be
 * wider than the dialog, and a choice's own words may not stand outside it.
 */
test('the hand-off dialog holds its choices', async ({ page }) => {
  // Mount the real sheet in the existing preview. Only the frame is supplied
  // here; the dialog, its controls and its styles are the production modules.
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    await route.fulfill({
      response,
      body: `${source}
        import sheetReact from ${JSON.stringify(reactUrl)};
        import { HandoffSheet } from '/src/components/ComposerControls.tsx';
        const frame = document.createElement('section');
        frame.setAttribute('aria-label', 'Hand-off sheet fixture');
        document.body.append(frame);
        createRoot(frame).render(sheetReact.createElement(HandoffSheet, {
          to: 'Claude', from: 'Codex', onCancel: () => {}, onConfirm: () => {},
        }));
      `,
    })
  })
  await page.goto('/preview.html')

  const dialog = page.getByRole('dialog', { name: /Hand off to/ })
  await expect(dialog).toBeVisible()

  // Nothing in it is wider than it is.
  const overflow = await dialog.evaluate(node => {
    const widest = [...node.querySelectorAll('*')]
      .map(child => child.scrollWidth - node.clientWidth)
      .reduce((most, over) => Math.max(most, over), 0)
    return { own: node.scrollWidth - node.clientWidth, widest }
  })
  expect(overflow.own).toBeLessThanOrEqual(1)
  expect(overflow.widest).toBeLessThanOrEqual(1)

  // And each choice contains its own words, which a fixed-height row does not.
  const choices = dialog.getByRole('radio')
  await expect(choices).toHaveCount(3)
  const spill = await choices.evaluateAll(nodes =>
    nodes.flatMap(node => {
      const box = node.getBoundingClientRect()
      return [...node.querySelectorAll('div')]
        .filter(child => child.textContent?.trim())
        .map(child => {
          const rect = child.getBoundingClientRect()
          return Math.max(box.top - rect.top, rect.bottom - box.bottom, box.left - rect.left, rect.right - box.right)
        })
    }),
  )
  expect(Math.max(...spill)).toBeLessThanOrEqual(1)
})

/**
 * And the sheet that is a whole screen holds it at both window widths.
 *
 * The sign-in sheet's stylesheet asked for 980px and it was drawn at 448 —
 * `DialogContent`'s base caps a dialog at `sm:max-w-md`, and `app.css` is
 * bundled after the modules, so a `width` in a stylesheet loses to a
 * `max-width` in a utility however specific it is. At 448 the fixed 244px
 * rail left 172 for the pane beside it: the agent's address was cut
 * mid-word, and the closing card's sentence came out one word per line with
 * its button on top of the text. The rows were the hand-off dialog's bug
 * again, a two-line name in a `sm` control's fixed 28px box.
 *
 * Both widths, because each caught something the other did not.
 */
for (const [where, width, height] of [
  ['a narrow window', 520, 820],
  ['a wide one', 1280, 900],
] as const) {
  test(`the sign-in sheet holds its agents at ${where}`, async ({ page }) => {
    await page.setViewportSize({ width, height })
    await page.goto('/preview.html')
    await page.evaluate(async () => { await document.fonts.ready })
    // The signed-in scene: it is the one that draws the hand-off alert, whose
    // copy is what a crushed column squeezes to nothing.
    await page.getByLabel('sign in scene').selectOption('connected')
    await page.getByLabel('dialog').selectOption('sign in')
    const dialog = page.getByRole('dialog').first()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('group', { name: 'Connected', exact: true })).toBeVisible()
    await expect(dialog.locator('[data-slot="alert-content"]')).toBeVisible()

    const held = await dialog.evaluate(node => {
      const box = node.getBoundingClientRect()
      const rows = [...node.querySelectorAll('[data-slot="list-row"]')]
      return {
        rows: rows.length,
        // A row whose own words stand outside it is a fixed-height control
        // holding two lines, which is what makes the list read as overlapping.
        spill: rows.flatMap(row => {
          const r = row.getBoundingClientRect()
          return [...row.querySelectorAll('span')]
            .filter(child => child.textContent?.trim())
            .map(child => Math.round(child.getBoundingClientRect().bottom - r.bottom))
        }),
        // Nothing crushed to nothing: a flex child with `min-width: 0` and no
        // floor beside two `flex: none` siblings reaches zero.
        narrowest: Math.min(...[...node.querySelectorAll('[data-slot="alert-content"], [data-slot="list-row-content"]')]
          .map(child => Math.round(child.getBoundingClientRect().width))),
        over: [...node.querySelectorAll('*')]
          .map(child => child.scrollWidth - node.clientWidth)
          .reduce((most, past) => Math.max(most, past), 0),
        head: Math.round((node.children[0] as HTMLElement).getBoundingClientRect().height),
        width: Math.round(box.width),
      }
    })
    expect(held.rows).toBeGreaterThan(0)
    expect(Math.max(...held.spill)).toBeLessThanOrEqual(1)
    expect(held.narrowest).toBeGreaterThan(80)
    expect(held.over).toBeLessThanOrEqual(1)
    // The head is a bar, not half the sheet: `DialogContent`'s grid gave its
    // two children a row each until the sheet asked to bleed.
    expect(held.head).toBeLessThan(80)
    /* 448px is `sm:max-w-md`, the cap this sheet spent its life under. Past
       it at both window sizes is the whole regression: what it settles on
       past it is the window's business, not this test's. */
    expect(held.width).toBeGreaterThan(Math.min(448, width - 64))
  })
}

/**
 * And a sheet that bleeds still lays itself out.
 *
 * `bleed` removes `DialogContent`'s five opinions rather than replacing them,
 * which is what lets a lightbox be a grid — and it means the sheet owns its
 * own display. The reading dialog's first version of this leaned on an earlier
 * `bleed` that imposed `flex flex-col overflow-hidden`, so when `bleed` became
 * layout-neutral the sheet quietly computed as `display: block` with visible
 * overflow: its footer stopped short of the bottom, and a long definition grew
 * past the fixed height instead of scrolling inside the body.
 *
 * The two things that says: the foot reaches the foot, and the growing part
 * scrolls rather than the sheet.
 */
test('the MCP detail fills the height it asked for', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto('/preview.html')
  await page.evaluate(async () => { await document.fonts.ready })
  await page.getByRole('combobox', { name: 'settings sheet', exact: true }).selectOption('MCP detail')

  const sheet = page.locator('[data-slot="mcp-sheet"]')
  await expect(sheet).toBeVisible()
  const held = await sheet.evaluate(node => {
    const box = node.getBoundingClientRect()
    // An absolutely positioned child (the close) is not part of the column.
    const laid = [...node.children].filter(child => getComputedStyle(child).position !== 'absolute')
    const last = laid[laid.length - 1].getBoundingClientRect()
    return {
      display: getComputedStyle(node).display,
      laid: laid.length,
      dead: Math.round(box.bottom - last.bottom),
      scrolls: [...node.querySelectorAll('*')].filter(child => child.scrollHeight > child.clientHeight + 1).length,
      over: [...node.querySelectorAll('*')]
        .map(child => child.scrollWidth - node.clientWidth)
        .reduce((most, past) => Math.max(most, past), 0),
    }
  })
  expect(held.laid).toBeGreaterThan(1)
  expect(held.display).not.toBe('block')
  // The foot reaches the foot: a block sheet leaves the rest of the height empty.
  expect(held.dead).toBeLessThanOrEqual(1)
  // And the part that grows is the part that scrolls.
  expect(held.scrolls).toBeGreaterThan(0)
  expect(held.over).toBeLessThanOrEqual(1)
})
