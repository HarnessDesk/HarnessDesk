import { useMemo, useState } from 'react'
import type { FlowEntry, FlowPolicy, FlowPreview, FrontDoorPreviewInput, ShapeLayout } from '@harnessdesk/protocol'
import { FrontDoor } from '../components/FrontDoor'
import { Sidebar } from '../components/Sidebar'
import { Usage } from '../components/Usage'
import { Button, Text } from '../design'
import { useTheme } from '../state/theme'
import { StoreProvider } from '../state/context'
import type { AppSnapshot, AppStore } from '../state/store'
import { previewStore } from './harness'
import { usagePreviewStore } from './usage-fixture'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'

const TEAM_ROOT = '/work/storefront'

const header = (source: string, key: string): string => {
  const value = source.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1] ?? ''
  return value.startsWith('"') ? JSON.parse(value) as string : value
}
const entries: readonly FlowEntry[] = Object.entries(TEAM_START_SOURCES).map(([id, source]) => {
  const policy: FlowPolicy = TEAM_START_POLICIES[id as keyof typeof TEAM_START_POLICIES]
  const frontDoor = (policy.layout as ShapeLayout | undefined)?.frontDoor
  return {
    id, name: header(source, 'name'), summary: header(source, 'summary'), description: header(source, 'description'),
    origin: 'builtin', path: `${id}.yml`, format: 'agents', problem: null, shadows: [],
    frontDoor: frontDoor ? { order: frontDoor.order ?? null, contexts: frontDoor.contexts ?? null } : null,
  }
})

const teamStartStore = (): AppStore => {
  const base = previewStore({ theme: 'system' })
  const mutable = base as unknown as { patch: (partial: Partial<AppSnapshot>) => void }
  const workspace = { ...base.getSnapshot().workspace!, path: TEAM_ROOT, checkoutRoot: TEAM_ROOT, name: 'storefront' }
  mutable.patch({ workspace, workspaces: [workspace], sessions: new Map(), history: [], historyIdentity: [], teams: new Map(), goals: new Map(), lanes: [] })
  return new Proxy(base, { get(target, key, receiver) {
    if (key === 'flowCatalog') return async () => entries
    if (key === 'flowSource') return async (_root: string, id: string) => TEAM_START_SOURCES[id] ?? ''
    if (key === 'renderShape') return async (policy: FlowPolicy) => ({ source: JSON.stringify(policy), issues: [] })
    if (key === 'previewFrontDoor') return async (input: FrontDoorPreviewInput) => {
      const id = Object.entries(TEAM_START_SOURCES).find(([, source]) => source === input.source)?.[0]
      const policy: FlowPolicy = input.source.startsWith('{') ? JSON.parse(input.source) as FlowPolicy
        : TEAM_START_POLICIES[id as keyof typeof TEAM_START_POLICIES] ?? TEAM_START_POLICIES['fix-and-review']
      const seats: FlowPreview['seats'] = policy.roles.flatMap(role => role.kind !== 'agent' ? [] : Array.from({ length: role.count ?? Math.max(role.uses.length, role.seats.length, 1) }, (_, index) => {
        const agent = role.uses[index] ?? role.uses[0] ?? 'implementer'
        const runtime = target.getSnapshot().runtimes[role.id === policy.seed.role ? index : role.id === 'judge' ? 2 : 1]!
        const seat = role.seats[index] ?? role.seats[0] ?? { runtime: runtime.id, model: 'opus', effort: 'high' }
        const presentation = target.getSnapshot().runtimes.find(one => one.id === seat.runtime)?.presentation ?? runtime.presentation
        return { role: role.id, index, agent, isolate: role.isolate, reviews: role.grant === 'read', plan: {
          id: agent, from: 'prefer' as const, winner: 0, blocked: null, ceiling: { level: role.grant, hold: 'held' as const },
          candidates: [{ seat, label: presentation.name, runtimeName: presentation.name, state: 'taken' as const, reason: null, fix: null }],
        } }
      }))
      const flow: FlowPreview = { token: 'synthetic-team-start', compiled: { document: { format: 'agents', flow: policy }, bindings: [], problems: [] }, seats, // hd-secrets-ok: invented preview token, never a host credential.
        commands: policy.roles.flatMap(role => role.kind === 'check' ? [{ role: role.id, run: role.check.run, cwd: TEAM_ROOT, timeout: role.check.timeout, permission: 'read' as const }] : []),
        guards: [], messaging: 'board-only', problems: [] }
      const preview = { flow, source: input.source, vars: input.vars, sentence: policy.name, goal: input.goal ?? null,
        target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' as const } }
      const mutable = target as unknown as { patch: (partial: Partial<AppSnapshot>) => void }
      const front = target.getSnapshot().frontDoor
      if (front) mutable.patch({ frontDoor: { ...front, preview } })
      return preview
    }
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

const TeamStartExample = ({ scene, onClose }: { readonly scene: string; readonly onClose: () => void }) => {
  useTheme()
  if (scene === 'usage') return <Usage view="projects" onClose={onClose} />
  const initial = scene === 'comparison' || scene === 'fix-and-review' ? { id: scene, origin: 'builtin' as const } : undefined
  return scene === 'menu' ? <div className="h-screen w-60"><Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onSearch={() => {}} /></div>
    : <FrontDoor context={{ kind: 'project', root: TEAM_ROOT }} initial={initial} onClose={onClose} onStarted={onClose} />
}

export const TeamStartFrames = () => {
  const scene = new URLSearchParams(location.search).get('team-start') ?? 'picker'
  const store = useMemo(() => scene === 'usage' ? usagePreviewStore() : teamStartStore(), [scene])
  const [open, setOpen] = useState(true)
  return <StoreProvider store={store}><div className="min-h-screen bg-background text-foreground">{open && <TeamStartExample scene={scene} onClose={() => setOpen(false)} />}</div></StoreProvider>
}

export const TeamStartCases = () => {
  const store = useMemo(teamStartStore, [])
  const [scene, setScene] = useState<string | null>(null)
  return <StoreProvider store={store}><div className="flex flex-wrap gap-2" data-catalog-state="default">
    <Text>Open the shipped start surface:</Text>{['picker', 'comparison', 'fix-and-review', 'menu'].map(one => <Button key={one} variant="outline" onClick={() => setScene(one)}>{one === 'comparison' ? 'Side by side' : one === 'fix-and-review' ? 'Write and review' : one === 'menu' ? 'Menu' : 'Picker'}</Button>)}
    {scene && (scene === 'menu' ? <TeamStartExample scene={scene} onClose={() => setScene(null)} />
      : <FrontDoor key={scene} context={{ kind: 'project', root: TEAM_ROOT }} initial={scene === 'picker' ? undefined : { id: scene, origin: 'builtin' }} onClose={() => setScene(null)} onStarted={() => setScene(null)} />)}
  </div></StoreProvider>
}
