import { installLibraryChangesFixture } from './library-changes-fixture'
import { useMemo } from 'react'
import { App } from '../app/App'
import { LibraryChanges } from '../components/LibraryChanges'
import { DestinationBody, Page } from '../design'
import { DestinationPageScope } from '../panels/destination-page'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'

/** E9 mounts this route through the common preview assembly. No replacement page geometry. */
export const libraryDestinationFixture = (query: URLSearchParams) => {
  const store = frameDestinationStore(previewStore())
  if (query.get('frame-kind') === 'changes') installLibraryChangesFixture(store)
  store.openDestination({kind:'library',section:query.get('frame-kind') === 'changes' ? 'changes' : query.get('frame-kind') === 'mcp' ? 'mcp' : 'skill'})
  return store
}
export const LibraryDestinationFixture = ({ query = location.search }: { readonly query?: string }) => {
  const store = useMemo(() => libraryDestinationFixture(new URLSearchParams(query)), [query])
  return <StoreProvider store={store}><App /></StoreProvider>
}

/**
 * The Changes page alone, over the same fixture — the coverage frame's own
 * subject. It mounts the page rather than a second whole `App`, so the frame
 * shows the list it names and nothing the shell happens to put around it.
 */
export const LibraryChangesFixture = () => {
  const store = useMemo(() => {
    const seeded = frameDestinationStore(previewStore())
    installLibraryChangesFixture(seeded)
    return seeded
  }, [])
  return <StoreProvider store={store}>
    <div className="grid h-full min-h-0 overflow-hidden">
      <DestinationBody id="library" active>
        <DestinationPageScope owner="destination:library" active>
          <Page width="wide"><LibraryChanges onBack={() => {}} /></Page>
        </DestinationPageScope>
      </DestinationBody>
    </div>
  </StoreProvider>
}
