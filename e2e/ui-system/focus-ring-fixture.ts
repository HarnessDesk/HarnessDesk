import { expect, type Page } from '@playwright/test'

/** Real controls on the synthetic preview store, including pointer/keyboard restore paths. */
export async function mountFocusFixture(page: Page) {
  await page.route('**/src/preview/**', async route => {
    const response = await route.fetch()
    // Synthetic fixtures use a demo checkout, including in hover titles. A
    // module's own `/@fs/` imports keep the real path, or they would 404 in a
    // checkout at one of these places and leave the page blank.
    const body = (await response.text())
      .replace(/(?<!\/@fs[^"'\s]*)\/Users\/[^/]+\/code\/HarnessDesk/g, '/work/harnessdesk')
      .replace(/(?<!\/@fs[^"'\s]*)\/\.(?:codex|claude|harnessdesk)\/worktrees/g, '/checkouts')
    await route.fulfill({ response, body })
  })
  await page.route('**/src/preview/main.tsx*', async route => {
    const response = await route.fetch()
    const source = await response.text()
    const reactUrl = /from "([^"\n]*\/react\.js[^"\n]*)"/.exec(source)?.[1]
    if (!reactUrl) throw new Error('preview React module import was not found')
    const entry = source.lastIndexOf('createRoot(container).render(')
    if (entry < 0) throw new Error('preview root render was not found')
    await route.fulfill({ response, body: `${source.replace('createRoot(container).render(', 'void (')}
      import focusReact from ${JSON.stringify(reactUrl)};
      import { CommandPalette } from '/src/components/CommandPalette.tsx';
      import { ProfileSection } from '/src/components/SettingsYou.tsx';
      import { Button, Dialog, Input, Search, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '/src/design/index.ts';
      // The palette's debounced reads need wire-shaped answers. The preview
      // transport's null fallback made files.map crash and unmount this root.
      const request = store.transport.request;
      store.transport.request = async (method, params) => {
        if (method === 'workspace/files') return [
          { path: '/work/harnessdesk/appearance.ts', relativePath: 'appearance.ts', score: 1, kind: 'file' },
        ].filter(file => file.relativePath.includes(params.query));
        if (method === 'session/search') return { data: [], nextCursor: null };
        if (method === 'transcripts/search') return [];
        return request(method, params);
      };
      const h = focusReact.createElement;
      const FocusFixture = () => {
        useTheme();
        const [open, setOpen] = focusReact.useState(null);
        const close = () => setOpen(null);
        return h('div', { style: { display: 'flex', gap: 24, padding: 24 } },
          h('section', { 'data-frame-id': 'sidebar-column', style: { width: 280, height: 720, flexShrink: 0 } },
            h(Sidebar, { onOpenSettings: close, onOpenPlugins: close, onOpenTeams: close, onOpenAgents: close, onOpenUsage: close, onBrowseFolders: close, onSignIn: close, onSearch: () => setOpen('palette') })),
          h('div', null,
          h('section', { 'aria-label': 'Focus settings', style: { width: 880, padding: 24, background: 'var(--hd-background)' } },
            h('h1', null, 'Settings · Profile'),
            h(ProfileSection)),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 16 } },
              h(Button, { onClick: () => setOpen('palette') }, 'Open palette'),
              h(Button, { onClick: () => setOpen('dialog') }, 'Open dialog'),
              h(DropdownMenu, null,
                h(DropdownMenuTrigger, { render: h(Button, null) }, 'Open focus menu'),
                h(DropdownMenuContent, null, h(DropdownMenuItem, null, 'Menu action')))),
            h(Input, { 'aria-label': 'Shared field' }),
            h(Search, { value: '', onChange: () => {}, placeholder: 'Shared search' }),
            open === 'palette' && h(CommandPalette, { host: { close, chooseFolder: close, openSettings: close, openUsage: close, openAgents: close, openFrontDoor: close } }),
            open === 'dialog' && h(Dialog, { title: 'Focus dialog', onClose: close, footer: h(Button, { onClick: close }, 'Done') },
              h(Input, { 'aria-label': 'Dialog field' })))
        );
      };
      createRoot(container).render(h(StoreProvider, { store }, h(FocusFixture)));
    ` })
  })
  await page.goto('/preview.html')
  await expect(page.getByRole('region', { name: 'Focus settings' })).toBeVisible()
  await page.evaluate(() => (window as any).__hdPreview.store.patch({ theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }))
}

export const ringOf = (page: Page) => page.evaluate(() => {
  const node = document.activeElement as HTMLElement
  const style = getComputedStyle(node)
  return { outline: style.outlineStyle, shadow: style.boxShadow, border: style.borderColor,
    visible: node.matches(':focus-visible'), ring: getComputedStyle(document.body).getPropertyValue('--hd-ring').trim() }
})
