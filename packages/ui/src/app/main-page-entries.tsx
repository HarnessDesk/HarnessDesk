import type { ReactNode } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import type { PageDestination } from '../state/destinations'
import { Page } from '../design'
import { PluginsSection } from '../components/PluginsSection'
import { Settings } from '../components/Settings'
export interface MainPageInput {
  readonly page: PageDestination
  readonly visit: (target: PageDestination) => void
  readonly replace: (target: PageDestination) => void
  readonly onSignIn: (runtime: RuntimeId) => void
  readonly onNewTeam: () => void
  readonly libraryImportIntent: number
}
export const MAIN_PAGE_ENTRIES: Partial<Record<PageDestination['kind'], (input: MainPageInput) => ReactNode>> = {
  plugins: ({ page, visit }) => page.kind === 'plugins'
    ? <Page width="wide"><PluginsSection section={page.section} id={page.id}
        onSection={section => visit({ kind: 'plugins', section, id: null })}
        onPlugin={id => visit({ kind: 'plugins', section: 'installed', id })} /></Page> : null,
  settings: ({page,visit,onSignIn}) => page.kind === 'settings'
    ? <Settings route={page.route} onRoute={route=>visit({kind:'settings',route})} onSignIn={onSignIn} /> : null,
}
