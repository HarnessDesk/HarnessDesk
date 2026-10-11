import type { ReactNode } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import type { PageDestination } from '../state/destinations'
import { Settings } from '../components/Settings'
import { ChangesReview } from '../components/ChangesReview'
export interface MainPageInput {
  readonly page: PageDestination
  readonly visit: (target: PageDestination) => void
  readonly replace: (target: PageDestination) => void
  readonly onSignIn: (runtime: RuntimeId) => void
  readonly onNewTeam: () => void
  readonly libraryImportIntent: number
}
export const MAIN_PAGE_ENTRIES: Partial<Record<PageDestination['kind'], (input: MainPageInput) => ReactNode>> = {
  'changes-review': ({ page }) => page.kind === 'changes-review'
    ? <ChangesReview root={page.root} returnTo={page.returnTo} /> : null,
  settings: ({page,visit,onSignIn}) => page.kind === 'settings'
    ? <Settings route={page.route} onRoute={route=>visit({kind:'settings',route})} onSignIn={onSignIn} /> : null,
}
