import { CurrentPagePreview } from './page-preview'
import { useMemo, useState } from 'react'
import type { FlowEntry, FlowPolicy, FlowPreview, FlowPreviewSeat, FrontDoorPreviewInput, ShapeLayout } from '@harnessdesk/protocol'
import { FrontDoor } from '../components/FrontDoor'
import { Sidebar } from '../components/Sidebar'
import { Button, Text } from '../design'
import { useTheme } from '../state/theme'
import { StoreProvider } from '../state/context'
import type { AppSnapshot, AppStore } from '../state/store'
import { previewStore, runtime as previewRuntime } from './harness'
import { usagePreviewStore } from './usage-fixture'
import { TEAM_START_POLICIES, TEAM_START_SOURCES } from './team-start-fixture'

const TEAM_ROOT = '/work/storefront'

/**
 * What a seat's Agent declares beyond its brief, as the host dry-runs it
 * (#1582) — invented here so the Start frames show every line the seats
 * section draws: the seed Agent's skill and server all load, the reviewer's
 * Agent declares one skill that would not load, and an Agent that declares
 * nothing shows its runtime's defaults, the one place a defaults line appears.
 * Names are fixture personas.
 */
type SeatAttachments = NonNullable<FlowPreviewSeat['attachments']>
export const SEAT_ATTACHMENTS: Readonly<Record<'all' | 'wont' | 'defaults', SeatAttachments>> = {
  all: {
    skillsMode: 'allowlist', mcpMode: 'allowlist',
    declarations: [
      { kind: 'skill', name: 'review-checklist', identity: null, problem: null },
      { kind: 'skill', name: 'checkout-retries', identity: null, problem: null },
      { kind: 'mcp', name: 'browser', identity: null, problem: null },
    ],
    refusal: null,
  },
  wont: {
    skillsMode: 'allowlist', mcpMode: 'allowlist',
    declarations: [
      { kind: 'skill', name: 'review-checklist', identity: null, problem: null },
      { kind: 'skill', name: 'frontend-design', identity: null, problem: 'Review this content before loading it.' },
      { kind: 'mcp', name: 'browser', identity: null, problem: null },
    ],
    refusal: null,
  },
  defaults: { skillsMode: 'runtime-defaults', mcpMode: 'runtime-defaults', declarations: [], refusal: null },
}

const header = (source: string, key: string): string => {
  const value = source.match(new RegExp(`^${key}: (.+)$`, 'm'))?.[1] ?? ''
  return value.startsWith('"') ? JSON.parse(value) as string : value
}
const entries: readonly FlowEntry[] = Object.entries(TEAM_START_SOURCES).map(([id, source]) => {
  const policy: FlowPolicy = TEAM_START_POLICIES[id as keyof typeof TEAM_START_POLICIES]
  const frontDoor = (policy.layout as ShapeLayout | undefined)?.frontDoor
  return {
    id, name: header(source, 'name'), summary: header(source, 'summary'), description: header(source, 'description'),
    origin: 'builtin', path: `${id}.yml`, format: 'agents', problem: null, shadows: [], policy,
    frontDoor: frontDoor ? { order: frontDoor.order ?? null, contexts: frontDoor.contexts ?? null } : null,
  }
})

export const teamStartStore = (): AppStore => {
  const requestedTheme = new URLSearchParams(location.search).get('theme')
  const base = previewStore({ theme: requestedTheme === 'light' || requestedTheme === 'dark' ? requestedTheme : 'system' })
  const mutable = base as unknown as { patch: (partial: Partial<AppSnapshot>) => void }
  const workspace = { ...base.getSnapshot().workspace!, path: TEAM_ROOT, checkoutRoot: TEAM_ROOT, name: 'storefront' }
  const runtimes = [previewRuntime('codex', 'Runtime 1'), previewRuntime('claude-code', 'Runtime 2'), previewRuntime('windsurf', 'Runtime 3')].map(one => ({ ...one, ceilings: one.id === 'codex' ? { read: { settings: [], how: 'Native guard' } } : {} }))
  mutable.patch({ workspace, workspaces: [workspace], runtimes, accountsByRuntime: Object.fromEntries(['codex', 'claude-code', 'windsurf'].map(id => [id, { accounts: [{ kind: 'opaque', label: 'Signed in', anonymous: true }], signInMethods: [] }])), sessions: new Map(), history: [], historyIdentity: [], teams: new Map(), goals: new Map(), lanes: [] })
  return new Proxy(base, { get(target, key, receiver) {
    if (key === 'flowCatalog') return async () => entries
    if (key === 'flowSource') return async (_root: string, id: string) => TEAM_START_SOURCES[id] ?? ''
    if (key === 'renderShape') return async (policy: FlowPolicy) => ({ source: JSON.stringify(policy), issues: [] })
    if (key === 'previewFrontDoor') return async (input: FrontDoorPreviewInput, options: { readonly publish?: boolean } = {}) => {
      const id = Object.entries(TEAM_START_SOURCES).find(([, source]) => source === input.source)?.[0]
      const policy: FlowPolicy = input.source.startsWith('{') ? JSON.parse(input.source) as FlowPolicy
        : TEAM_START_POLICIES[id as keyof typeof TEAM_START_POLICIES] ?? TEAM_START_POLICIES['fix-and-review']
      const seats: FlowPreview['seats'] = policy.roles.flatMap(role => role.kind !== 'agent' ? [] : Array.from({ length: role.count ?? Math.max(role.uses.length, role.seats.length, 1) }, (_, index) => {
        const agent = role.uses[index] ?? role.uses[0] ?? 'implementer'
        if (id === 'fix-and-review' && (role.id === 'fixer' || role.id === 'reviewer')) {
          const runtimeName = role.id === 'fixer' ? 'Claude' : 'Windsurf'
          const runtime = role.id === 'fixer' ? 'claude-code' : 'windsurf'
          const reason = role.id === 'fixer' ? { kind: 'notInstalled' as const, added: false } : { kind: 'signedOut' as const }
          const fix = role.id === 'fixer' ? { kind: 'add' as const, runtime } : { kind: 'signIn' as const, runtime }
          return { role: role.id, index, agent, isolate: role.isolate, reviews: role.grant === 'read', plan: {
            id: agent, from: 'prefer' as const, winner: null, blocked: null, ceiling: null,
            candidates: [{ seat: { runtime }, label: runtimeName, runtimeName, state: 'passed' as const, reason, fix }],
          } }
        }
        const runtime = target.getSnapshot().runtimes[role.id === policy.seed.role ? index : role.id === 'judge' ? 2 : 1]!
        const seat = role.seats[index] ?? role.seats[0] ?? { runtime: runtime.id, model: 'opus', effort: 'high' }
        const presentation = target.getSnapshot().runtimes.find(one => one.id === seat.runtime)?.presentation ?? runtime.presentation
        // The seed Agent's declarations all load; the reviewer's declare one skill that would not; anything else shows runtime defaults.
        const attachments = role.id === policy.seed.role ? SEAT_ATTACHMENTS.all : role.id === 'reviewer' ? SEAT_ATTACHMENTS.wont : SEAT_ATTACHMENTS.defaults
        if (new URLSearchParams(location.search).has('unheld-read') && role.grant === 'read' && !runtimes.find(one => one.id === seat.runtime)?.ceilings.read) return { role: role.id, index, agent, isolate: role.isolate, reviews: true, plan: {
          id: agent, from: 'prefer' as const, winner: null, blocked: null, ceiling: null,
          candidates: [{ seat, label: presentation.name, runtimeName: presentation.name, state: 'passed' as const, reason: { kind: 'unheld' as const, level: 'read', required: true, detail: null }, fix: { kind: 'seats' as const } }],
        } }
        return { role: role.id, index, agent, isolate: role.isolate, reviews: role.grant === 'read', attachments, plan: {
          id: agent, from: 'prefer' as const, winner: 0, blocked: null, ceiling: { level: role.grant, hold: 'held' as const },
          candidates: [{ seat, label: presentation.name, runtimeName: presentation.name, state: 'taken' as const, reason: null, fix: null }],
        } }
      }))
      // The problems list repeats a declaration's own sentence with where it is about, as the host writes both (#1582).
      const problems: FlowPreview['problems'] = seats.flatMap(seat => (seat.attachments?.declarations ?? [])
        .filter(one => one.problem !== null).map(one => ({
          level: 'warning' as const, at: `roles.${seat.role}.seat`,
          text: `${seat.role}[${seat.index + 1}] ${one.kind === 'mcp' ? 'server' : 'skill'} “${one.name}”: ${one.problem}`,
        })))
      const flow: FlowPreview = { token: 'synthetic-team-start', compiled: { document: { format: 'agents', flow: policy }, bindings: [], problems: [] }, seats, // hd-secrets-ok: invented preview token, never a host credential.
        commands: policy.roles.flatMap(role => role.kind === 'check' ? [{ role: role.id, run: role.check.run, cwd: TEAM_ROOT, timeout: role.check.timeout, permission: 'read' as const }] : []),
        guards: [], messaging: 'board-only', problems }
      const preview = { flow, source: input.source, vars: input.vars, sentence: policy.name, goal: input.goal ?? null,
        target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' as const } }
      const mutable = target as unknown as { patch: (partial: Partial<AppSnapshot>) => void }
      const front = target.getSnapshot().frontDoor
      if (front && options.publish !== false) mutable.patch({ frontDoor: { ...front, preview } })
      return preview
    }
    const value = Reflect.get(target, key, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

const TeamStartExample = ({ scene, onClose }: { readonly scene: string; readonly onClose: () => void }) => {
  useTheme()
  if (scene === 'usage') return <CurrentPagePreview page={{kind:'dashboard',view:'projects',scope:null}} />
  const initial = scene === 'comparison' || scene === 'fix-and-review' ? { id: scene, origin: 'builtin' as const } : undefined
  return scene === 'menu' ? <div className="h-screen w-60"><Sidebar onOpenSettings={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onSearch={() => {}} /></div>
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
