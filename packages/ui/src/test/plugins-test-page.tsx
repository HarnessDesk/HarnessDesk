import { useState, type ComponentProps } from 'react'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { installTopBarTestLayout } from './top-bar-layout'
import { PluginsSection } from '../components/PluginsSection'

installTopBarTestLayout()

/** Controlled main-page host for the plugin body tests. */
export const PluginsTestPage = ({ section: initial = 'installed', id: initialId = null, active = true }: {
  readonly section?: 'installed' | 'capabilities'; readonly id?: string | null; readonly active?: boolean
}) => {
  const [section, onSection] = useState(initial)
  const [id, onPlugin] = useState<string | null>(initialId)
  const props = { section, id, onSection, onPlugin } as ComponentProps<typeof PluginsSection>
  return <TopBarProvider>
    <DestinationPageScope owner="destination:plugins" active={active}>
      <PluginsSection {...props} />
    </DestinationPageScope>
    <TopBarOutlet owner="destination:plugins" fallback={{ place: 'New session', more: () => null }} />
  </TopBarProvider>
}
