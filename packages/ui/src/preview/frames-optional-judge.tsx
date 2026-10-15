import { useMemo } from 'react'
import type { AgentEntry, FlowPolicy, FlowPreview } from '@harnessdesk/protocol'
import { RaceStart } from '../components/RaceStart'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import type { AppSnapshot, AppStore } from '../state/store'
import { previewStore, runtime } from './harness'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'

/** The shipped race form with synthetic providers and the actual comparison template. */
const raceStore = (): AppStore => {
  const base = previewStore({ theme: new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light' })
  const mutable = base as unknown as { patch: (partial: Partial<AppSnapshot>) => void }
  const runtimes = [runtime('alpha', 'Runtime 1'), runtime('beta', 'Runtime 2')]
  mutable.patch({ runtimes })
  const agent: AgentEntry = { id: 'implementer', origin: 'builtin', path: 'implementer/AGENT.md', digest: 'preview', problems: [], shadows: [],
    definition: { id: 'implementer', name: 'Implementer', ceiling: 'edit', ceilingFrom: 'ceiling', answers: [], produces: ['diff'], skills: [], mcp: [], prefer: [], brief: 'Build the attempt.' } }
  const candidates = runtimes.map(one => ({ seat: { runtime: one.id }, label: one.presentation.name, runtimeName: one.presentation.name, state: 'taken' as const, reason: null, fix: null }))
  return new Proxy(base, { get(target, key, receiver) {
    if (key === 'flowCatalog') return async () => [{ id: 'comparison', origin: 'builtin', name: 'Side by side', path: 'comparison.yml', format: 'agents', problem: null, shadows: [] }]
    if (key === 'flowSource') return async () => TEAM_START_SOURCES.comparison
    if (key === 'agentsIn') return async () => [agent]
    if (key === 'plansIn') return async () => [{ id: 'implementer', from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'edit', hold: 'held' }, candidates }]
    if (key === 'renderShape') return async (policy: FlowPolicy) => ({ source: JSON.stringify(policy), issues: [] })
    if (key === 'previewFlow') return async (_root: string, source: string): Promise<FlowPreview> => {
      const listed = source.match(/^\s+seats: (\[.+\])$/m)?.[1]
      const seats = listed ? (JSON.parse(listed) as string[]).map(runtime => ({ runtime })) : null
      const flow: FlowPolicy = source.startsWith('{') ? JSON.parse(source) : { ...TEAM_START_POLICIES.comparison,
        roles: TEAM_START_POLICIES.comparison.roles.map(role => role.id === 'competitor' && seats ? { ...role, seats, count: undefined } : role) }
      return { token: 'synthetic-race-preview', // hd-secrets-ok: invented preview token, never a host credential.
 compiled: { document: { format: 'agents', flow }, bindings: [], problems: [] },
        seats: flow.roles.flatMap(role => role.kind !== 'agent' ? [] : Array.from({ length: role.count ?? Math.max(1, role.seats.length) }, (_, index) => {
          const seat = role.seats[index] ?? candidates[0]!.seat
          const candidate = candidates.find(one => one.seat.runtime === seat.runtime) ?? candidates[0]!
          return { role: role.id, index, agent: role.uses[0]!, isolate: role.isolate, reviews: role.id === 'judge',
            plan: { id: role.uses[0]!, from: 'prefer' as const, winner: 0, blocked: null, ceiling: { level: role.grant, hold: 'held' as const }, candidates: [{ ...candidate, seat }] } }
        })), commands: [], guards: [], messaging: 'board-only', problems: [] }
    }
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

const RaceFrame = () => {
  useTheme()
  return <RaceStart root="/work/storefront" task="Fix the cart total" onClose={() => {}} />
}

export const OptionalJudgeFrame = () => {
  const store = useMemo(raceStore, [])
  return <StoreProvider store={store}><RaceFrame /></StoreProvider>
}
