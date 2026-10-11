import { useMemo } from 'react'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { previewStore } from './harness'

/** E9 mounts this route through the common preview assembly. No replacement page geometry. */
export const libraryDestinationFixture = (query: URLSearchParams) => {
  const store = frameDestinationStore(previewStore())
  store.openDestination({kind:'library',section:query.get('frame-kind') === 'mcp' ? 'mcp' : 'skill'})
  return store
}
export const LibraryDestinationFixture = () => {
  const store = useMemo(() => libraryDestinationFixture(new URLSearchParams(location.search)), [])
  return <StoreProvider store={store}><App /></StoreProvider>
}
