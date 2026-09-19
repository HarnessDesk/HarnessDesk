import { expect, test, type Page } from '@playwright/test'

/**
 * The history tool row at the widths it is really given.
 *
 * The pane opens beside a conversation at about 460px, and at that width the
 * row has room for its controls and not for the commit count as well. The
 * count gives way first because nobody acts on it, but it leaves whole: cut to
 * "0…" it is a number with no noun, which answers nothing. The search beside it
 * keeps room for its own words either way.
 */
const mount = async (page: Page, width: number) => {
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
      gitFrame.setAttribute('aria-label', 'Git tools fixture');
      Object.assign(gitFrame.style, {
        position: 'fixed', top: '80px', left: '16px', width: '${width}px',
        height: '550px', background: 'var(--hd-background)', zIndex: '1'
      });
      document.body.append(gitFrame);
      createRoot(gitFrame).render(gitElement(StoreProvider, { store: gitStore },
        gitElement(MountProvider, { scope: { area: 'main', id: 'git-preview', view: { kind: 'git', root: '/repo/example' } } },
          gitElement(GitPane))));
    ` })
  })
  await page.goto('/preview.html')
  const frame = page.getByRole('region', { name: 'Git tools fixture' })
  await expect(frame.getByRole('searchbox', { name: 'Search history' })).toBeVisible()
  return frame
}

test('in the pane’s opening width the count leaves whole and the search keeps its words', async ({ page }) => {
  const frame = await mount(page, 460)
  await expect(frame.getByText('0 commits', { exact: true })).toBeHidden()
  const search = await frame.getByRole('searchbox', { name: 'Search history' }).evaluate(node => node.getBoundingClientRect().width)
  expect(search).toBeGreaterThanOrEqual(120)
})

test('with room for it the count stands whole, never cut to a number without its noun', async ({ page }) => {
  const frame = await mount(page, 900)
  const count = frame.getByText('0 commits', { exact: true })
  await expect(count).toBeVisible()
  const cut = await count.evaluate(node => node.scrollWidth > node.clientWidth)
  expect(cut).toBe(false)
})
