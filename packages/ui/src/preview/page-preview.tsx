import { useEffect, useMemo } from 'react'
import { App } from '../app/App'
import { StoreProvider, useStore } from '../state/context'
import type { AppStore } from '../state/store'
import type { PageDestination } from '../state/destinations'
import { frameDestinationStore } from './frame-destination-store'

/** Embedded specimens use the same retained App destination and navigation. */
export const PagePreview = ({ fixture, page }: { readonly fixture: AppStore; readonly page: PageDestination }) => {
  const store = useMemo(() => {
    const next = frameDestinationStore(fixture)
    next.openDestination(page)
    return next
  }, [fixture, page.kind])
  // A specimen's dial replaces the displayed route on the same store.
  const route = JSON.stringify(page)
  useEffect(() => { store.replaceDestination(JSON.parse(route) as PageDestination) }, [store, route])
  return <StoreProvider store={store}><div className="h-full min-h-0 overflow-hidden bg-background"><App /></div></StoreProvider>
}

export const CurrentPagePreview = ({ page }: { readonly page: PageDestination }) => <PagePreview fixture={useStore()} page={page} />
