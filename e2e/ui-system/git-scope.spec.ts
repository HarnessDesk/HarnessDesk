import { expect, test } from '@playwright/test'

for (const theme of ['light', 'dark'] as const) {
  test(`git branch scope keeps labels separated and keyboard reachable in ${theme}`, async ({ page }, testInfo) => {
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    // Mount the real GitPane with synthetic host answers in the existing
    // preview. Only fixture data and the frame are supplied here; the pane,
    // controls and styles are the production modules served by Vite.
    await page.route('**/src/preview/main.tsx*', async route => {
      const response = await route.fetch()
      const source = await response.text()
      const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
      if (!reactUrl) throw new Error('Preview React module import was not found')
      await route.fulfill({ response, body: `${source}
        import gitReact from ${JSON.stringify(reactUrl)};
        const gitElement = gitReact.createElement;
        import { GitPane } from '/src/components/GitPane.tsx';
        import { MountProvider } from '/src/panels/mount.tsx';
        const gitTransport = { request: async (method) => {
          if (method === 'git/log') return { commits: [], hasMore: false };
          if (method === 'git/refs') return {
            headSha: 'aaaa111', branch: 'main', branches: [], remotes: [], tags: [], stashes: []
          };
          if (method === 'git/worktrees') return [];
          return null;
        }};
        const gitStore = new Proxy(store, {
          get: (target, key) => key === 'transport' ? gitTransport : Reflect.get(target, key)
        });
        const gitFrame = document.createElement('section');
        gitFrame.setAttribute('aria-label', 'Git scope regression fixture');
        Object.assign(gitFrame.style, {
          position: 'fixed', top: '80px', left: '16px', width: 'calc(100vw - 32px)',
          height: '550px', background: 'var(--hd-background)', zIndex: '1'
        });
        document.body.append(gitFrame);
        createRoot(gitFrame).render(gitElement(StoreProvider, { store: gitStore },
          gitElement(MountProvider, { scope: { area: 'main', id: 'git-preview', view: { kind: 'git', root: '/repo/example' } } },
            gitElement(GitPane))));
      ` })
    })
    await page.goto('/preview.html')
    expect(pageErrors).toEqual([])
    await page.getByRole('combobox', { name: 'theme', exact: true }).selectOption(theme)
    const group = page.getByRole('radiogroup', { name: 'Which branches', exact: true })
    await expect(group.getByRole('radio')).toHaveCount(2)
    const measurements = await group.getByRole('radio').evaluateAll(nodes => nodes.map(node => {
      const box = node.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(node)
      const text = range.getBoundingClientRect()
      const css = getComputedStyle(node)
      return {
        label: node.textContent, height: box.height, fontSize: css.fontSize,
        paddingLeft: parseFloat(css.paddingLeft), paddingRight: parseFloat(css.paddingRight),
        textLeft: text.left - box.left, textRight: box.right - text.right,
        textStart: text.left, textEnd: text.right,
      }
    }))
    await testInfo.attach('git-scope-layout', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' })
    await group.screenshot({ path: testInfo.outputPath('git-scope.png') })
    for (const item of measurements) {
      expect.soft(item.paddingLeft, item.label ?? '').toBeGreaterThanOrEqual(8)
      expect.soft(item.paddingRight, item.label ?? '').toBeGreaterThanOrEqual(8)
      expect.soft(item.textLeft, item.label ?? '').toBeGreaterThanOrEqual(8)
      expect.soft(item.textRight, item.label ?? '').toBeGreaterThanOrEqual(8)
      expect.soft(item.height, item.label ?? '').toBeGreaterThanOrEqual(24)
    }
    expect.soft(measurements[1]!.textStart - measurements[0]!.textEnd).toBeGreaterThanOrEqual(16)
    const all = group.getByRole('radio', { name: 'All branches', exact: true })
    const current = group.getByRole('radio', { name: 'Current', exact: true })
    await expect(all).toBeChecked()
    await all.focus()
    await page.keyboard.press('ArrowRight')
    await expect(current).toBeFocused()
    await page.keyboard.press('Space')
    await expect(current).toBeChecked()
    await expect(all).not.toBeChecked()
    await page.keyboard.press('Space')
    await expect(current).toBeChecked()
  })
}
