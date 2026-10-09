import { useMemo, useState } from 'react'
import { NO_CAPABILITIES, runtimeId, sessionId, type HistoryImportState, type HistorySummary, type RuntimeInfo } from '@harnessdesk/protocol'
import { Settings, type Section } from '../components/Settings'
import { StoreProvider } from '../state/context'
import { Frame } from './main'
import { previewStore } from './harness'

const alpha: RuntimeInfo = { id: runtimeId('alpha'), name: 'Alpha', version: '1.0.0', capabilities: { ...NO_CAPABILITIES, listHistory: true }, presentation: { name: 'Alpha' } }
const beta: RuntimeInfo = { ...alpha, id: runtimeId('beta'), name: 'Beta', presentation: { name: 'Beta' } }
const time = new Date('2026-10-08T16:30:00Z').getTime()
const done: HistoryImportState = { state: 'done', count: 2000, importedAt: time, lastScanAt: time }
const rows: readonly HistorySummary[] = ['Trace the slow startup', 'Fix the project picker', 'Review the toolbar', 'Plan the next release', 'Check the saved draft', 'Document the import flow'].map((title, i) => ({
  runtime: i % 2 ? beta.id : alpha.id, id: sessionId(`history-${i}`), title, cwd: i % 2 ? '/preview/atlas' : '/preview/demo',
  repo: { root: i % 2 ? '/preview/atlas' : '/preview/demo', worktree: false }, preview: null, status: { type: 'notLoaded' }, createdAt: time, updatedAt: time - i * 60_000,
  archived: i === 1, hidden: false,
}))
const states = {
  'agent-new': null,
  'agent-running': { ...done, state: 'running', count: 1500, importedAt: null },
  'agent-done': done,
  'agent-failed': { ...done, state: 'failed', count: 500, error: 'The agent could not read its history. Retry when it is available.' },
} as const
const HistoryFrame = ({ scene }: { scene: string }) => {
  const [route, setRoute] = useState<{ section: Section; focus: string | null }>({ section: scene.startsWith('agent-') ? 'runtimes' : 'history', focus: scene.startsWith('agent-') ? alpha.id : null })
  const own = useMemo(() => {
    const state = states[scene as keyof typeof states] ?? (scene === 'empty' || scene === 'agent-new' ? null : done)
    const store = previewStore({ runtimes: [alpha, beta], activeRuntime: alpha.id, accountsByRuntime: {},
      healthByRuntime: { alpha: { state: 'ready' }, beta: { state: 'ready' } },
      historyImports: { alpha: state, beta: scene === 'empty' ? null : done }, workspaces: [],
    })
    store.loadHistoryImport = async () => {}
    store.runtimeResources = async () => []
    store.healthFor = async () => ({ state: 'ready' })
    store.optionsFor = async () => []
    const original = store.transport.request
    store.transport.request = (async (method, params) => {
      if (method === 'history/status') return state
      if (method === 'history/import' || method === 'history/cancel') return null
      if (method === 'history/list') {
        const filter = params as { query?: string; runtimes?: readonly string[]; repoRoot?: string }
        return { data: scene === 'empty' ? [] : rows.filter(row => (!filter.query || row.title?.toLowerCase().includes(filter.query.toLowerCase())) && (!filter.runtimes || filter.runtimes.includes(row.runtime)) && (!filter.repoRoot || row.repo?.root === filter.repoRoot)), nextCursor: null }
      }
      return original(method, params as never)
    }) as typeof store.transport.request
    return store
  }, [scene])
  return <Frame id={`history-${scene}`} title={scene.startsWith('agent-') ? `Agent settings — ${scene.slice(6)}` : `History — ${scene}`}>
    <div className="relative h-[700px]" style={{ transform: 'translateZ(0)' }}><StoreProvider store={own}>
      <Settings section={route.section} focus={route.focus} onSection={(section, focus) => setRoute({ section, focus: focus ?? null })} onClose={() => {}} onSignIn={() => {}} />
    </StoreProvider></div>
  </Frame>
}
export const HistoryFrames = () => {
  const scene = new URLSearchParams(window.location.search).get('history')
  return <div className="grid gap-4 p-4">{(scene ? [scene] : ['rows', 'empty', ...Object.keys(states)]).map(scene => <HistoryFrame key={scene} scene={scene} />)}</div>
}
