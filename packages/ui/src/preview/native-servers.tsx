import { useMemo } from 'react'
import { useTheme } from '../state/theme'
import { PREVIEW_AGENTS, previewStore } from './harness'
import { PagePreview } from './page-preview'
export const NativeServersPreview = () => {
  useTheme()
  const entry = { ...PREVIEW_AGENTS[0]!, definition: { ...PREVIEW_AGENTS[0]!.definition!, runtimeServers: [] } }
  const own = useMemo(() => previewStore({ agents: [entry] }), [])
  return <div className="h-screen"><PagePreview fixture={own} page={{kind:'agents',id:entry.id}} /></div>
}
