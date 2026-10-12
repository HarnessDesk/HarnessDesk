import type { Page } from '@playwright/test'

/** Fixture tickets only: the real preview keeps its opaque sandbox and host
 * contract; this supplies deterministic local HTML bytes to the frame wall. */
export const installFramePreviewFixture = async (page: Page) => {
  await page.addInitScript(() => {
    if (new URLSearchParams(location.search).get('frame-update') !== '1') return
    const listeners = new Set<(fact: { label: string; enabled: boolean } | null) => void>()
    window.harnessdesk = { platform: 'fixture', openExternal: () => {}, setTitle: () => {}, onShortcut: () => () => {},
      readAppUpdate: async () => ({ label: 'Relaunch to update', enabled: true }),
      onAppUpdate: receive => { listeners.add(receive); return () => { listeners.delete(receive) } },
      appUpdateAction: () => listeners.forEach(receive => receive(null)),
    }
  })
  await page.route(
  /\/preview-frame\?ticket=frame-preview-[^&]*$/,
  route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;padding:16px;color:#242424}h1{font-size:20px}</style></head><body><h1>Storefront preview</h1><p>Synthetic checkout recovery · 長い記録</p><p>The local preview retains its document while tools change.</p></body></html>' }),
)
}
