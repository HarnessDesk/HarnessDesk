import type { DesktopBridge } from '../lib/desktop'

/**
 * `?frame-update=1` shows the window with an update waiting. The desktop shell
 * is what reports one, so the preview stands in for it here — the same
 * stand-in the visual specs install (`e2e/ui-system/frame-preview-fixture.ts`),
 * kept in the page so the review board's windows, which no spec prepares,
 * show the state too. A bridge already present is left alone.
 */
if (new URLSearchParams(location.search).get('frame-update') === '1' && !window.harnessdesk) {
  const listeners = new Set<(fact: { label: string; enabled: boolean } | null) => void>()
  window.harnessdesk = {
    platform: 'fixture', openExternal: () => {}, setTitle: () => {}, onShortcut: () => () => {},
    readAppUpdate: async () => ({ label: 'Relaunch to update', enabled: true }),
    onAppUpdate: (receive: (fact: { label: string; enabled: boolean } | null) => void) => { listeners.add(receive); return () => { listeners.delete(receive) } },
    appUpdateAction: () => listeners.forEach((receive) => receive(null)),
  } as unknown as DesktopBridge
}
