import { CustomizeTabs, type CustomizeSection } from '../design'
import { useStore } from '../state/context'

/** Keep existing destination identities and history while sharing one entrance. */
export const CustomizeNavigation = ({ section, onLibrarySection }: {
  readonly section: CustomizeSection
  readonly onLibrarySection?: (section: 'skill' | 'mcp') => void
}) => {
  const store = useStore()
  return <CustomizeTabs value={section} onChange={next => {
    if (next === 'plugins') store.openDestination({ kind: 'plugins', section: 'installed', id: null })
    else if (onLibrarySection) onLibrarySection(next)
    else store.openDestination({ kind: 'library', section: next })
  }} />
}
