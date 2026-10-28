import { useMemo, useState, useSyncExternalStore } from 'react'
import type { AuthoringDocument, FlowExecution, FlowPolicy, FlowStartRequest, HostParams } from '@harnessdesk/protocol'
import { App } from '../app/App'
import { FrontDoor } from '../components/FrontDoor'
import { StoreProvider } from '../state/context'
import { frameDestinationStore } from './frame-destination-store'
import { teamStartStore } from './frames-team-start'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'
import type { AppStore } from '../state/store'
import { PREVIEW_GOALS } from './goal-fixture'

const ROOT = '/work/storefront'
interface FlowFixtureEvidence {
  readonly saved?: { readonly source: string }
  readonly started?: { readonly source: string; readonly sentence: string; readonly task: string; readonly goal: string; readonly count: number }
}

/** The real destination and editor, with synthetic files and local-only authoring answers. */
export const flowsDestinationStore = (observe?: (evidence: Partial<FlowFixtureEvidence>) => void): AppStore => {
  const fixture = teamStartStore()
  const policies = new Map<string, FlowPolicy>(Object.entries(TEAM_START_POLICIES))
  const sources = new Map(Object.entries(TEAM_START_SOURCES))
  let nextSave = 0
  const saves = new Map<string, HostParams<'authoring/save/preview'>>()
  let nextPreview = 0
  const previews = new Map<string, { readonly source: string; readonly vars: Readonly<Record<string, string>>; readonly policy: FlowPolicy; readonly goal: FlowStartRequest['goal'] }>()
  const started = new Map<string, FlowExecution>()
  const lookup = new Proxy(fixture, { get(target, key, receiver) {
    if (key === 'flowCatalog') return async () => (await fixture.flowCatalog(ROOT)).map(entry => ({ ...entry, policy: policies.get(entry.id) ?? null }))
    if (key === 'readAuthoring') return async (target: Parameters<AppStore['readAuthoring']>[0]): Promise<AuthoringDocument> => ({
      target, source: target.kind === 'flow' ? sources.get(target.id) ?? '' : '', digest: '0'.repeat(64), exists: true,
      displayPath: target.kind === 'flow' ? `${target.id}.yml` : 'triggers.yml', writable: target.origin !== 'builtin', issues: [],
    })
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const store = frameDestinationStore(lookup)
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method, params) => {
    if (method === 'flow/source') return fixture.flowSource(ROOT, (params as HostParams<'flow/source'>).id)
    if (method === 'authoring/shape/render') return fixture.renderShape((params as HostParams<'authoring/shape/render'>).policy)
    if (method === 'authoring/start/preview') {
      const input = params as HostParams<'authoring/start/preview'>
      const preview = await fixture.previewFrontDoor(input)
      if (preview.flow.compiled.document.format !== 'agents' || !preview.flow.token) return preview
      const token = `synthetic-flow-preview-${++nextPreview}` // hd-secrets-ok: invented preview token, scoped to this fixture.
      previews.set(token, { source: input.source, vars: { ...input.vars }, policy: preview.flow.compiled.document.flow, goal: input.goal })
      return { ...preview, flow: { ...preview.flow, token } }
    }
    if (method === 'authoring/save/preview') {
      const input = params as HostParams<'authoring/save/preview'>
      const token = `synthetic-flow-save-${++nextSave}` // hd-secrets-ok: invented save token, scoped to this fixture.
      saves.set(token, { ...input, target: { ...input.target } })
      return { token, edits: [{ path: input.target.kind === 'flow' ? `flows/${input.target.id}.yml` : 'triggers.yml', before: input.target.kind === 'flow' ? sources.get(input.target.id) ?? null : null, after: input.source }], issues: [], resuming: false }
    }
    if (method === 'authoring/save/apply') {
      const { token } = params as HostParams<'authoring/save/apply'>
      const input = saves.get(token)
      if (!input) throw new Error('Synthetic save token is unknown or was already applied.')
      saves.delete(token)
      if (input.target.kind === 'flow') {
        sources.set(input.target.id, input.source)
        if (input.source.startsWith('{')) policies.set(input.target.id, JSON.parse(input.source) as FlowPolicy)
        observe?.({ saved: { source: input.source } })
      }
      return { state: 'applied', written: [input.target.kind === 'flow' ? `.harnessdesk/flows/${input.target.id}.yml` : '.harnessdesk/triggers.yml'], message: 'Saved.' }
    }
    if (method === 'flow/start-goal') {
      const input = params as HostParams<'flow/start-goal'>
      const preview = previews.get(input.token)
      if (!preview || input.root !== ROOT || input.source !== preview.source || JSON.stringify(input.vars ?? {}) !== JSON.stringify(preview.vars)
        || JSON.stringify(input.goal) !== JSON.stringify(preview.goal) || !input.sentence.trim()) throw new Error('Synthetic start does not match the source and inputs that were previewed.')
      const prior = started.get(input.token)
      if (prior) return prior
      const execution: FlowExecution = { version: 2, id: 'synthetic-flow-run', goal: 'synthetic-flow-team', document: { format: 'agents', flow: preview.policy }, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null }
      const base = PREVIEW_GOALS[0]!
      const board = { ...base.board, id: execution.goal, name: input.sentence, root: ROOT, members: [], intents: [], channel: [] }
      const view = { ...base, goal: { ...base.goal, id: execution.goal, root: ROOT, cwd: ROOT, sentence: input.sentence }, board, activity: 'needs-you' as const, members: [], waitingOn: [] }
      const snapshot = store.getSnapshot()
      Object.assign(snapshot, { goals: new Map(snapshot.goals).set(execution.goal, view), teams: new Map(snapshot.teams).set(execution.goal, board), flowExecutions: new Map(snapshot.flowExecutions).set(execution.id, execution) })
      started.set(input.token, execution)
      observe?.({ started: { source: input.source, sentence: input.sentence, task: input.vars?.task ?? '', goal: execution.goal, count: started.size } })
      return execution
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  return store
}

export const FlowsDestinationFixture = () => {
  const scene = new URLSearchParams(location.search).get('flows-page')
  const [evidence, setEvidence] = useState<FlowFixtureEvidence>({})
  const store = useMemo(() => {
    const next = flowsDestinationStore(patch => setEvidence(current => ({ ...current, ...patch })))
    if (scene === 'unavailable' || scene === 'all-unavailable') {
      const unavailable = Array.from({ length: 20 }, (_, index) => ({ path: `/work/removed-${index + 1}`, name: `Removed ${index + 1}`, lastOpenedAt: 1 }))
      Object.assign(next.getSnapshot(), { workspace: unavailable[0], workspaces: [...unavailable, ...(scene === 'unavailable' ? next.getSnapshot().workspaces : [])] })
      const request = next.transport.request.bind(next.transport)
      next.transport.request = (async (method, params) => {
        if (method === 'flow/catalog' && unavailable.some(folder => folder.path === (params as HostParams<'flow/catalog'>).root)) {
          throw new Error(`ENOENT: no such file or directory, realpath '${(params as HostParams<'flow/catalog'>).root}'`)
        }
        return request(method, params as never)
      }) as typeof next.transport.request
    }
    next.openDestination(scene === 'editor' ? { kind: 'flows', root: ROOT, id: 'fix-and-review', origin: 'builtin' }
      : scene === 'draft' ? { kind: 'flows', root: ROOT, id: null, origin: null }
        : { kind: 'flows', root: null, id: null, origin: null })
    return next
  }, [scene])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const destination = snapshot.workbench.navigation.current
  const openedGoal = destination.kind === 'work' && destination.view.kind === 'room' ? destination.view.room : undefined
  return <StoreProvider store={store}><div className="h-screen" data-frame-id="flows-page" data-flow-saved-source={evidence.saved?.source}
    data-flow-started-source={evidence.started?.source} data-flow-started-task={evidence.started?.task} data-flow-started-sentence={evidence.started?.sentence}
    data-flow-started-goal={evidence.started?.goal} data-flow-start-count={evidence.started?.count} data-flow-opened-goal={openedGoal}><App />
    {scene === 'new-team' && <FrontDoor context={{ kind: 'project', root: ROOT }} initial={{ id: 'fix-and-review', origin: 'builtin' }} initialTask="Fix the checkout retry and verify the change" onClose={() => {}} onStarted={() => {}} />}
  </div></StoreProvider>
}
