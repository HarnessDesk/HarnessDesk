import type { ReactNode } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import type { PageDestination } from '../state/destinations'
import { DashboardEntry } from '../components/Usage'
import { LibraryChanges } from '../components/LibraryChanges'
import { LibrarySection } from '../components/Library'
import { Page } from '../design'
import { PluginsSection } from '../components/PluginsSection'
import { Settings } from '../components/Settings'
import { AgentsWindow } from '../components/AgentsWindow'
import { TeamsWindow } from '../components/TeamsWindow'
import { ChangesReview } from '../components/ChangesReview'
import { FlowsWindow } from '../components/FlowsWindow'
import { FlowPage } from '../components/FlowPage'
export interface MainPageInput {
  readonly page: PageDestination
  readonly visit: (target: PageDestination) => void
  readonly replace: (target: PageDestination) => void
  readonly onSignIn: (runtime: RuntimeId) => void
  readonly onNewTeam: () => void
  readonly libraryImportIntent: number
}
export const MAIN_PAGE_ENTRIES: Partial<Record<PageDestination['kind'], (input: MainPageInput) => ReactNode>> = {
  flows: ({page,visit}) => page.kind === 'flows'
    ? page.root === null
      ? <FlowsWindow onNew={root => visit({kind:'flows',root,id:null,origin:null})} onOpen={(root,id,origin) => visit({kind:'flows',root,id,origin})} />
      : <FlowPage key={JSON.stringify(page)} root={page.root} id={page.id} origin={page.origin ?? undefined} start={page.start} onBack={() => visit({kind:'flows',root:null,id:null,origin:null})} /> : null,
  dashboard: input => <DashboardEntry {...input} />,
  agents: ({ page, visit }) => page.kind === 'agents'
    ? <AgentsWindow focus={page.id} onFocus={id => visit({ kind: 'agents', id })} /> : null,
  library: ({page,visit,libraryImportIntent}) => page.kind === 'library'
    ? <Page width="wide">{page.section === 'changes' ? <LibraryChanges onBack={() => visit({ kind: 'library', section: 'skill' })} /> : <LibrarySection id={page.id} section={page.section} onSection={section=>visit({kind:'library',section})} importIntent={libraryImportIntent} />}</Page> : null,
  plugins: ({ page, visit }) => page.kind === 'plugins'
    ? <Page width={page.id === null ? 'wide' : 'reading'}><PluginsSection section={page.section} id={page.id}
        onSection={section => visit({ kind: 'plugins', section, id: null })}
        onPlugin={id => visit({ kind: 'plugins', section: 'installed', id })} /></Page> : null,
  'changes-review': ({ page }) => page.kind === 'changes-review'
    ? <ChangesReview root={page.root} returnTo={page.returnTo} /> : null,
  settings: ({page,visit,onSignIn}) => page.kind === 'settings'
    ? <Settings route={page.route} onRoute={route=>visit({kind:'settings',route})} onSignIn={onSignIn} /> : null,
  teams: ({page,replace,onNewTeam}) => page.kind === 'teams'
    ? <TeamsWindow filter={page.filter} onFilter={filter=>replace({kind:'teams',filter})} onNew={onNewTeam}/> : null,
}
