import { useMemo, useState, type ReactNode } from 'react'
import { AgentPage } from '../components/AgentPage'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { PREVIEW_AGENTS, previewStore } from './harness'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { PageHeadingProvider } from '../design'

export const NativeServersPreview = () => {
  useTheme()
  const entry = { ...PREVIEW_AGENTS[0]!, definition: { ...PREVIEW_AGENTS[0]!.definition!, runtimeServers: [] } }
  const own = useMemo(() => previewStore({ agents: [entry] }), [])
  const [place, setPlace] = useState<ReactNode>(null)
  return <StoreProvider store={own}><TopBarProvider><PageHeadingProvider onHeading={next => setPlace(next?.place ?? null)}><div className="min-h-screen bg-background px-8 py-10 text-foreground">
    <TopBarOutlet owner="agents" fallback={{ place: place ?? entry.definition.name, more: () => null }} />
    <div className="mx-auto max-w-[760px]"><AgentPage entry={entry} onBack={() => {}} onLeave={() => {}} /></div>
  </div></PageHeadingProvider></TopBarProvider></StoreProvider>
}
