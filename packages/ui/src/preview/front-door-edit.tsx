import { useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import type { FlowPolicy, FlowPreview, FrontDoorPreviewInput } from '@harnessdesk/protocol'
import { FrontDoor } from '../components/FrontDoor'
import { StoreProvider } from '../state/context'
import type { AppSnapshot, AppStore } from '../state/store'
import { useTheme } from '../state/theme'
import { teamStartStore } from './frames-team-start'
import { BEFORE_TEAM_START_POLICY, EDIT_TEAM_START_POLICY } from './front-door-edit-fixture'
import '../styles/app.css'

// The current specimen shares the canonical policy; before explicitly
// reproduces the former publication contract.
const makeStore = (): AppStore => {
  const base = teamStartStore()
  const patch = (base as unknown as { patch: (value: Partial<AppSnapshot>) => void }).patch
  const runtimes = base.getSnapshot().runtimes.slice(0, 2).map((one, index) => ({ ...one,
    presentation: { ...one.presentation, name: index === 0 ? 'Runtime Alpha' : 'Runtime Beta' },
    ceilings: index === 0 ? { read: { settings: [], how: 'Native guard' }, edit: { settings: [], how: 'Workspace guard' } } : { read: { settings: [], how: 'Read guard' } },
  }))
  patch({ runtimes })
  const before = new URLSearchParams(location.search).has('before')
  const policy = before ? BEFORE_TEAM_START_POLICY : EDIT_TEAM_START_POLICY
  return new Proxy(base, { get(target, key, receiver) {
    if (key === 'flowSource') return async () => JSON.stringify(policy)
    if (key === 'previewFrontDoor') return async (input: FrontDoorPreviewInput) => {
      const flow: FlowPolicy = JSON.parse(input.source)
      const seats: FlowPreview['seats'] = flow.roles.flatMap(role => role.kind !== 'agent' ? [] : [{
        role: role.id, index: 0, agent: role.uses[0]!, isolate: role.isolate, reviews: role.grant === 'read',
        plan: (() => {
          const candidates = (role.seats.length ? role.seats : [{ runtime: role.grant === 'read' ? runtimes[1]!.id : runtimes[0]!.id }]).map(seat => {
            const runtime = runtimes.find(one => one.id === seat.runtime)!
            const works = role.grant === 'read' || (role.grant === 'edit' && runtime.id === runtimes[0]!.id)
            return { seat, label: runtime.presentation.name, runtimeName: runtime.presentation.name, state: works ? 'taken' as const : 'passed' as const,
              reason: works ? null : { kind: 'unheld' as const, level: role.grant, detail: null, required: true as const }, fix: works ? null : { kind: 'seats' as const } }
          })
          const winner = candidates.findIndex(one => one.state === 'taken')
          return { id: role.uses[0]!, from: 'prefer' as const, winner: winner < 0 ? null : winner, blocked: null,
            ceiling: winner < 0 ? null : { level: role.grant, hold: 'held' as const }, candidates }
        })(),
      }])
      const blocked = seats.some(seat => seat.plan.winner === null)
      const preview = { source: input.source, vars: input.vars, sentence: flow.name, goal: null,
        target: { label: 'this project', base: null, head: null, dirty: false, independence: 'known' as const },
        flow: { token: blocked ? null : 'preview-edit-access', compiled: { document: { format: 'agents' as const, flow }, bindings: [], problems: [] }, // hd-secrets-ok: synthetic preview token.
          seats, commands: [], guards: [], messaging: 'board-only' as const,
          problems: blocked ? [{ level: 'error' as const, at: 'roles.fixer', text: 'Choose an agent that can enforce the writer’s access.' }] : [] },
      }
      const front = target.getSnapshot().frontDoor
      if (front) patch({ frontDoor: { ...front, preview } })
      return preview
    }
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
const Dialog = () => {
  useTheme()
  return <FrontDoor context={{ kind: 'project', root: '/work/storefront' }} initial={{ id: 'fix-and-review', origin: 'builtin' }} initialTask="Repair checkout retry" onClose={() => {}} onStarted={() => {}} />
}
const Preview = () => {
  const store = useMemo(makeStore, [])
  return <StoreProvider store={store}><Dialog /></StoreProvider>
}
createRoot(document.getElementById('root')!).render(<Preview />)
