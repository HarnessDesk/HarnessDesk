import type { Page } from '@playwright/test'

/** The real table primitives in a synthetic preview, with interior cell variants. */
export const framedTableFixture = async (page: Page) => {
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React import missing')
    await route.fulfill({ response, body: `${source}
      import fixtureReact from ${JSON.stringify(reactUrl)};
      import { Table as FixtureTable, TableHeader as FixtureHeader, TableHead as FixtureHead, TableBody as FixtureBody, TableRow as FixtureRow, TableCell as FixtureCell, TableCaption as FixtureCaption } from '/src/design/index.ts';
      document.getElementById('root').hidden = true;
      const tableHost = document.createElement('section');
      tableHost.id = 'table-inset-fixture'; tableHost.className = 'bg-background p-6 text-foreground';
      document.body.append(tableHost);
      const node = fixtureReact.createElement;
      createRoot(tableHost).render(node('div', { className: 'grid gap-6' },
        ...['comfortable', 'compact'].map(density => node('section', { key: density, 'data-density': density },
          node('h2', { className: 'text-lg font-semibold mb-3' }, density === 'comfortable' ? 'Comfortable' : 'Compact'),
          node(FixtureTable, { variant: 'framed', inset: 'row', density },
            node(FixtureCaption, { variant: 'sr-only' }, 'Project checks and recorded totals'),
            node(FixtureHeader, null, node(FixtureRow, null,
              node(FixtureHead, null, 'Project'), node(FixtureHead, null, 'Detail'), node(FixtureHead, null, 'Total'), node(FixtureHead, null, 'State'))),
            node(FixtureBody, null, node(FixtureRow, null,
              node(FixtureCell, null, 'Storefront'), node(FixtureCell, { variant: 'detail' }, 'Review the project checks.'),
              node(FixtureCell, { variant: 'footer' }, '3 checks'), node(FixtureCell, null, 'Ready'))))))));
    ` })
  })
}

/** Host-shaped empty history; the shipped pane still renders and navigates it. */
export const emptyGitFixture = async (page: Page) => {
  await page.route('**/src/preview/harness.tsx*', async route => {
    const response = await route.fetch(), source = await response.text()
    const body = source.replace('if (method === "git/log") return gitLog();', 'if (method === "git/log") return { commits: [], hasMore: false };')
    if (body === source) throw new Error('preview Git log answer missing')
    await route.fulfill({ response, body })
  })
}
