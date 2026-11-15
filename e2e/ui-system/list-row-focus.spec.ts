import { expect, test } from '@playwright/test'

// Composed browser coverage, not a manual screen-reader claim. Each row with
// interactive slots is a div: a trailing button must not be nested in a button.
for (const theme of ['light', 'dark'] as const) {
  test(`ListRow preserves composed keyboard and reading order in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.route('**/src/preview/main.tsx*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('preview React import missing')
      await route.fulfill({ response, body: `${source}
        import focusReact from ${JSON.stringify(reactUrl)};
        import { ListRow as FocusRow, Button as FocusButton } from '/src/design/index.ts';
        const focusHost = document.createElement('section');
        focusHost.setAttribute('aria-label', 'Composed row keyboard fixture');
        document.body.prepend(focusHost);
        const focusH = focusReact.createElement;
        const focusControl = (name) => focusH(FocusButton, {
          onClick: () => { focusHost.dataset.activated = name; },
        }, name);
        const focusRow = (name, below) => focusH(FocusRow, {
          key: name, 'data-focus-row': name,
          ...(below ? { subtitleLayout: 'below' } : {}),
          title: focusControl(name + ' heading'),
          subtitle: focusH('a', { href: '#row-details' }, name + ' description'),
          meta: focusControl(name + ' metadata'),
          trail: focusControl(name + ' actions'),
        });
        createRoot(focusHost).render(focusH(focusReact.Fragment, null,
          focusControl('Before rows'),
          focusRow('Column', false), focusRow('Below', true),
          focusH(FocusRow, {
            as: 'button', interactive: true,
            title: 'Review', subtitle: 'Two findings',
            trail: focusH('span', { 'aria-hidden': true }, 'Arrow'),
            onClick: () => { focusHost.dataset.activated = 'Open review'; },
          }),
          focusControl('After rows')));
      ` })
    })
    await page.goto(`/preview.html?team-overview=narrow&theme=${theme}`)
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-hd-dark-theme'))).toBe(theme === 'dark')
    const fixture = page.getByRole('region', { name: 'Composed row keyboard fixture' })
    await expect(fixture.getByRole('button', { name: 'Before rows', exact: true })).toBeVisible()

    const column = fixture.locator('[data-focus-row="Column"]')
    const below = fixture.locator('[data-focus-row="Below"]')
    await expect(column).toHaveText('Column headingColumn descriptionColumn metadataColumn actions')
    await expect(below).toHaveText('Below headingBelow actionsBelow descriptionBelow metadata')
    // Explicit accessible names and semantic order supplement the real Tab
    // traversal below; neither is evidence of manual assistive-technology use.
    await expect(column).toMatchAriaSnapshot(`
      - button "Column heading"
      - link "Column description"
      - button "Column metadata"
      - button "Column actions"
    `)
    await expect(below).toMatchAriaSnapshot(`
      - button "Below heading"
      - button "Below actions"
      - link "Below description"
      - button "Below metadata"
    `)
    const controls = [
      fixture.getByRole('button', { name: 'Before rows', exact: true }),
      column.getByRole('button', { name: 'Column heading', exact: true }),
      column.getByRole('link', { name: 'Column description', exact: true }),
      column.getByRole('button', { name: 'Column metadata', exact: true }),
      column.getByRole('button', { name: 'Column actions', exact: true }),
      below.getByRole('button', { name: 'Below heading', exact: true }),
      below.getByRole('button', { name: 'Below actions', exact: true }),
      below.getByRole('link', { name: 'Below description', exact: true }),
      below.getByRole('button', { name: 'Below metadata', exact: true }),
      fixture.getByRole('button', { name: 'Review Two findings', exact: true }),
      fixture.getByRole('button', { name: 'After rows', exact: true }),
    ]
    await controls[0].focus()
    for (const control of controls.slice(1)) {
      await page.keyboard.press('Tab')
      await expect(control).toBeFocused()
    }
    for (const control of controls.slice(0, -1).reverse()) {
      await page.keyboard.press('Shift+Tab')
      await expect(control).toBeFocused()
    }
    await below.getByRole('button', { name: 'Below heading', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(fixture).toHaveAttribute('data-activated', 'Below heading')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Space')
    await expect(fixture).toHaveAttribute('data-activated', 'Below actions')
    await fixture.getByRole('button', { name: 'Review Two findings', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(fixture).toHaveAttribute('data-activated', 'Open review')
  })
}
