import type { ReactNode } from 'react'

import { RuntimeMark } from '../components/BrandIcons'
import { AlertIcon, CheckIcon, DiffIcon, FileIcon, ServerIcon, SparkIcon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import {
  Button,
  Checkbox,
  Chip,
  ListRow,
  IconTile,
  Search,
  Segmented,
  Tabs,
  TabsList,
  TabsTrigger,
  Text,
} from '../design'
import { Frame } from './main'
import { LIBRARY_AGENTS } from './library-options-fixture'

/*
 * Option E — the Library as a developer's package manager.
 *
 * A search-first list on the left (what is it, which agents have it, is
 * anything wrong) and the selected item on the right: what it does, where it
 * came from, and one checkbox per agent saying "installed here". Ticking and
 * unticking is desired state; nothing is written until the pending-change bar
 * is reviewed and applied, and the bar then becomes the receipt.
 *
 * Mockup only: fixture data, no store, no wire. Reach words follow the
 * evidence rule in docs/superpowers/specs/2026-10-01-skills-management-use-cases.md.
 */

const noop = (): void => {}

type Presence = 'loads' | 'on-disk' | 'differs' | 'rejected' | 'absent'
type Item = {
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly scope: 'User' | 'Project'
  readonly presence: readonly Presence[]
  readonly issue?: string
}

const SKILLS: readonly Item[] = [
  { name: 'brainstorming', description: 'Shape an idea into a reviewable design before implementation.', version: '4.2.1', scope: 'User', presence: ['loads', 'on-disk', 'differs', 'absent'], issue: 'Copies differ' },
  { name: 'code-review', description: 'Review a change against the repository rules.', scope: 'Project', presence: ['loads', 'on-disk', 'on-disk', 'on-disk'] },
  { name: 'deploy-check', description: 'Check a deploy plan before anything ships.', scope: 'Project', presence: ['rejected', 'on-disk', 'on-disk', 'absent'], issue: 'Rejected by one agent' },
  { name: 'pr-summary', description: 'Turn the diff and test evidence into a concise summary.', version: '2.8.0', scope: 'User', presence: ['loads', 'on-disk', 'on-disk', 'on-disk'] },
  { name: 'release-check', description: 'Check release notes, version and packaging before a tag.', scope: 'User', presence: ['loads', 'on-disk', 'absent', 'absent'] },
  { name: 'migration-map', description: 'Map old entry points to the new package layout.', scope: 'Project', presence: ['loads', 'absent', 'absent', 'absent'] },
  { name: 'test-plan', description: 'Write the test plan a change needs before it is built.', scope: 'User', presence: ['absent', 'on-disk', 'on-disk', 'absent'] },
  { name: 'ui-review', description: 'Compare a screen against the design system and report drift.', version: '1.0.3', scope: 'User', presence: ['loads', 'on-disk', 'on-disk', 'on-disk'] },
]

const SELECTED = SKILLS[0]!

const SKILL_MD = `# brainstorming

Use before any creative work — a feature, a component, a change in behaviour.

1. Read the project context first.
2. Ask one question at a time until the purpose and constraints are clear.
3. Propose two or three approaches, with trade-offs and a recommendation.
4. Write the agreed design to \`docs/specs/\` and stop for review.
`

/** One small mark per agent: full where it has the item, faint where it does not. */
const PresenceStrip = ({ presence }: { presence: readonly Presence[] }) => (
  <span className="flex items-center gap-1.5">
    {LIBRARY_AGENTS.map((agent, index) => {
      const state = presence[index] ?? 'absent'
      return (
        <span
          key={agent.id}
          title={`${agent.presentation.name}: ${PRESENCE_WORDS[state]}`}
          className={state === 'absent' ? 'opacity-25' : undefined}
        >
          <RuntimeMark runtime={agent} size={14} />
        </span>
      )
    })}
  </span>
)

const PRESENCE_WORDS: Record<Presence, string> = {
  loads: 'loads it',
  'on-disk': 'on disk, not confirmed',
  differs: 'copy differs',
  rejected: 'rejected',
  absent: 'not installed',
}

const KindTabs = () => (
  <Tabs defaultValue="skills">
    <TabsList variant="line">
      <TabsTrigger value="skills">Skills <Chip tone="neutral" size="sm" count={42} /></TabsTrigger>
      <TabsTrigger value="rules">Rules <Chip tone="neutral" size="sm" count={6} /></TabsTrigger>
      <TabsTrigger value="servers">MCP servers <Chip tone="neutral" size="sm" count={9} /></TabsTrigger>
    </TabsList>
  </Tabs>
)

const Toolbar = () => (
  <div className="flex items-center justify-between gap-4 border-b px-5 pt-4">
    <div className="flex items-end gap-6">
      <Text role="page" as="h2" className="pb-2">Library</Text>
      <KindTabs />
    </div>
    <div className="flex items-center gap-2 pb-2">
      <Button size="sm" variant="outline">Check for updates</Button>
      <Button size="sm">Add skill</Button>
    </div>
  </div>
)

const ListPane = () => (
  <div className="flex min-w-0 flex-col border-r">
    <div className="space-y-3 border-b p-4">
      <Search value="" onChange={noop} placeholder="Search skills, descriptions and content" />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Scope"
          value="all"
          options={[{ value: 'all', label: 'All' }, { value: 'user', label: 'User' }, { value: 'project', label: 'This repo' }]}
          onChange={noop}
        />
        <Button size="sm" variant="outline"><AlertIcon size={13} /> 2 issues</Button>
        <Button size="sm" variant="ghost">All agents</Button>
      </div>
    </div>
    <div className="divide-y">
      {SKILLS.map((skill) => (
        <ListRow
          key={skill.name}
          interactive
          selected={skill === SELECTED}
          className="px-4"
          lead={<IconTile size="sm"><SparkIcon size={13} /></IconTile>}
          title={
            <span className="flex items-center gap-2">
              <span>{skill.name}</span>
              {skill.issue ? <AlertIcon size={13} aria-label={skill.issue} /> : null}
            </span>
          }
          subtitle={skill.description}
          trail={<PresenceStrip presence={skill.presence} />}
        />
      ))}
    </div>
  </div>
)

type AgentLine = {
  readonly status: ReactNode
  readonly installed: boolean
  readonly pending?: boolean
  readonly action?: ReactNode
}

const AGENT_LINES: readonly AgentLine[] = [
  { status: <><CheckIcon size={13} /> Loads it · asked 2 min ago</>, installed: true },
  { status: 'On disk · this agent can’t confirm until it restarts', installed: true },
  {
    status: <><DiffIcon size={13} /> Its copy differs from 4.2.1 · edited 3 days ago</>,
    installed: true,
    action: <Button size="sm" variant="outline">Compare…</Button>,
  },
  { status: 'Not installed', installed: false, pending: true },
]

const InstalledIn = ({ applied }: { applied: boolean }) => (
  <section className="space-y-2">
    <div className="flex items-baseline justify-between">
      <Text role="section" as="h3">Installed in</Text>
      <Text role="meta">User scope · ~/.&lt;agent&gt;/skills/brainstorming</Text>
    </div>
    <div className="divide-y rounded-lg border">
      {LIBRARY_AGENTS.map((agent, index) => {
        const line = AGENT_LINES[index]!
        const checked = applied ? true : line.installed || Boolean(line.pending)
        const status = applied && line.pending
          ? 'Written · this agent can’t confirm until it restarts'
          : line.status
        return (
          <div key={agent.id} className="flex items-center gap-3 px-4 py-2.5">
            <Checkbox checked={checked} aria-label={`Installed in ${agent.presentation.name}`} />
            <RuntimeMark runtime={agent} size={16} />
            <Text role="row" className="w-32 shrink-0">{agent.presentation.name}</Text>
            <Text role="muted" className="flex min-w-0 flex-1 items-center gap-1.5">{status}</Text>
            {!applied && line.pending ? <Chip size="sm" tone="info">Will install</Chip> : null}
            {line.action ?? null}
          </div>
        )
      })}
    </div>
  </section>
)

const PendingBar = () => (
  <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
    <Text role="row">1 change · install for {LIBRARY_AGENTS[3]?.presentation.name} at user scope</Text>
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost">Discard</Button>
      <Button size="sm">Review and apply…</Button>
    </div>
  </div>
)

const ReceiptBar = () => (
  <div className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3">
    <span className="flex items-center gap-2">
      <CheckIcon size={14} />
      <Text role="row">Written for {LIBRARY_AGENTS[3]?.presentation.name} · it will pick it up on its next restart</Text>
    </span>
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost">Undo</Button>
      <Button size="sm" variant="outline">Restart it now</Button>
    </div>
  </div>
)

const DetailPane = ({ applied }: { applied: boolean }) => (
  <div className="min-w-0 space-y-6 p-6">
    <header className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <IconTile size="lg"><SparkIcon size={18} /></IconTile>
        <div className="min-w-0 space-y-1">
          <Text role="page" as="h2">{SELECTED.name}</Text>
          <Text role="muted" as="p">{SELECTED.description}</Text>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Chip tone="neutral" size="sm">community-kit · 4.2.1</Chip>
            <Chip size="sm" tone="info">4.3.0 available</Chip>
            <Text role="meta">github.com/acme/community-kit · pinned to v4.2.1</Text>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline">Update to 4.3.0…</Button>
        <Button size="sm" variant="ghost">Remove…</Button>
      </div>
    </header>

    <InstalledIn applied={applied} />
    {applied ? <ReceiptBar /> : <PendingBar />}

    <section className="space-y-3">
      <Tabs defaultValue="readme">
        <TabsList variant="line">
          <TabsTrigger value="readme"><FileIcon size={13} /> SKILL.md</TabsTrigger>
          <TabsTrigger value="files">Files <Chip tone="neutral" size="sm" count={3} /></TabsTrigger>
          <TabsTrigger value="usage"><SparkIcon size={13} /> Usage</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="rounded-lg border p-5">
        <Markdown text={SKILL_MD} document />
      </div>
      <Text role="meta" as="p">
        Seen in 14 conversations this desk stored · last 2 days ago · about 60 tokens per turn in each agent’s catalogue · runs no scripts
      </Text>
    </section>
  </div>
)

const DevLibrary = ({ applied = false }: { applied?: boolean }) => (
  <div className="flex min-h-0 flex-col">
    <Toolbar />
    <div className="grid grid-cols-5">
      <div className="col-span-2 min-w-0"><ListPane /></div>
      <div className="col-span-3 min-w-0"><DetailPane applied={applied} /></div>
    </div>
  </div>
)

/** The same shape on the MCP tab: status replaces "loads it", and sign-in is the verb. */
const ServerStrip = () => (
  <div className="flex items-center gap-3 border-t px-5 py-3">
    <ServerIcon size={14} />
    <Text role="muted">MCP servers use the same list and pane: “Installed in” shows Configured · Available · Needs sign-in per agent, with Sign in and Reload beside it.</Text>
  </div>
)

export const LibraryDevFrames = () => (
  <>
    <Frame id="library-option-e" title="Option E — developer: list + detail, tick the agents, review and apply">
      <DevLibrary />
      <ServerStrip />
    </Frame>
    <Frame id="library-option-e-applied" title="Option E — after Apply: the bar becomes the receipt">
      <DevLibrary applied />
    </Frame>
  </>
)
