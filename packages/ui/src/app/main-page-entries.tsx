import type { ReactNode } from 'react'
import type { RuntimeId } from '@harnessdesk/protocol'
import type { PageDestination } from '../state/destinations'
import { libraryBack } from '../state/destinations'
import { useStore } from '../state/context'
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
import { LeadPage } from '../components/LeadPage'
import { FlowPage } from '../components/FlowPage'
export interface MainPageInput {
  readonly page: PageDestination
  readonly visit: (target: PageDestination) => void
  readonly replace: (target: PageDestination) => void
  readonly onSignIn: (runtime: RuntimeId) => void
  readonly onNewTeam: () => void
  readonly libraryImportIntent: number
}
/**
 * The Library destination's own page.
 *
 * Back to Library is a step into the store's one history when a Library page
 * is behind the Changes page, and otherwise a visit to the section last used
 * (`state/destinations`, `libraryBack`). It is a component rather than a
 * branch of the registry so the store can be read where it is used.
 */
const LibraryPage = ({ page, visit, libraryImportIntent }: MainPageInput) => {
  const store = useStore()
  if (page.kind !== 'library') return null
  const back = (): void => {
    const target = libraryBack(store.getSnapshot().workbench.navigation)
    if (target.step) { void store.navigateBack(); return }
    visit({ kind: 'library', section: target.section })
  }
  return <Page width="wide">{page.section === 'changes'
    ? <LibraryChanges onBack={back} />
    : <LibrarySection id={page.id} section={page.section} onSection={section => visit({ kind: 'library', section })} importIntent={libraryImportIntent} />}</Page>
}
export const MAIN_PAGE_ENTRIES: Partial<Record<PageDestination['kind'], (input: MainPageInput) => ReactNode>> = {
  lead: ({page}) => <LeadPage focus={page.kind === 'lead' ? page.focus : null} />,
  flows: ({page,visit}) => page.kind === 'flows'
    ? page.root === null
      ? <FlowsWindow onNew={root => visit({kind:'flows',root,id:null,origin:null})} onOpen={(root,id,origin) => visit({kind:'flows',root,id,origin})} />
      : <FlowPage key={JSON.stringify(page)} root={page.root} id={page.id} origin={page.origin ?? undefined} start={page.start} onBack={() => visit({kind:'flows',root:null,id:null,origin:null})} /> : null,
  dashboard: input => <DashboardEntry {...input} />,
  agents: ({ page, visit }) => page.kind === 'agents'
    ? <AgentsWindow focus={page.id} onFocus={id => visit({ kind: 'agents', id })} /> : null,
  library: input => <LibraryPage {...input} />,
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
