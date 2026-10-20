import { useMemo } from 'react'
import type { FlowPolicy, FrontDoorPreviewInput, HostMethodName } from '@harnessdesk/protocol'
import { FrontDoor } from '../components/FrontDoor'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { useTheme } from '../state/theme'

const ROOT = '/work/storefront'
const plainTeam = new URLSearchParams(location.search).get('workspace-recovery') === 'plain'
const refusal = `${ROOT} is outside every folder and repository opened here. Open it first.`
const policy: FlowPolicy = {
  version: 2, name: 'Review', inputs: [{ id: 'task', label: 'Task', default: 'Review the cart changes' }],
  roles: [{ id: 'reviewer', kind: 'person', outcomes: ['done'] }], rules: [],
  seed: { role: 'reviewer', title: '{{task}}' }, messaging: 'board-only', wait: 240,
}

const RecoveryDialog = () => {
  useTheme()
  return <FrontDoor context={{ kind: 'project', root: ROOT }} initial={plainTeam ? undefined : { id: 'review', origin: 'project' }} onClose={() => {}} onStarted={() => {}} />
}

/** Synthetic host boundary: the actual store and dialog recover a confined project. */
export const WorkspaceRecoveryPreview = () => {
  const store = useMemo(() => {
    const store = new AppStore('ws://localhost:0/')
    Object.assign(store.getSnapshot(), { theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light' })
    let opened = false
    store.transport.request = (async (method: HostMethodName, params: FrontDoorPreviewInput) => {
      if (method === 'flow/catalog') {
        if (plainTeam && !opened) throw new Error(refusal)
        return [{ id: 'review', origin: 'project', path: '.harnessdesk/flows/review.yml', name: 'Review', description: null, format: 'agents', problem: null, shadows: [] }]
      }
      if (method === 'flow/source') return JSON.stringify(policy)
      if (method === 'agent/list' || method === 'agent/seat/dry' || method === 'worktree/list') return []
      const workspace = { path: ROOT, name: 'storefront', lastOpenedAt: 1 }
      if (method === 'workspace/open') { opened = true; return workspace }
      if (method === 'workspace/recent') return opened ? [workspace] : []
      if (method === 'goal/start' && !opened) throw new Error(refusal)
      if (method === 'authoring/start/preview') {
        if (!opened) throw new Error(refusal)
        return {
          source: params.source, vars: params.vars, sentence: 'Review the cart changes', goal: null,
          target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' },
          flow: { token: 'preview-only', compiled: { document: { format: 'agents', flow: policy }, bindings: [], problems: [] }, seats: [], commands: [], guards: [], messaging: 'board-only', problems: [] },
        }
      }
      return null
    }) as typeof store.transport.request
    return store
  }, [])
  return <StoreProvider store={store}><RecoveryDialog /></StoreProvider>
}
