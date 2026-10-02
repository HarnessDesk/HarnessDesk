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
import { LIBRARY_AGENTS, LIBRARY_SKILLS, type SkillFact } from './library-options-fixture'

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

type Item = (typeof LIBRARY_SKILLS)[number]
const SKILLS: readonly Item[] = LIBRARY_SKILLS
const SELECTED = SKILLS.find((skill) => skill.name === 'brainstorming')!

const SKILL_MD = `# brainstorming

Use before any creative work — a feature, a component, a change in behaviour.

1. Read the project context first.
2. Ask one question at a time until the purpose and constraints are clear.
3. Propose two or three approaches, with trade-offs and a recommendation.
4. Write the agreed design to \`docs/specs/\` and stop for review.
`

/** One mark per agent, derived from the shared evidence fixture. */
const PresenceStrip = ({ facts }: { facts: readonly SkillFact[] }) => (
  <span className="flex items-center gap-1.5">
    {LIBRARY_AGENTS.map((agent, index) => {
      const fact = facts[index] ?? { kind: 'not-measured' as const, basis: 'Table · no observation', words: 'Not measured' }
      return (
        <span
          key={agent.id}
          title={`${agent.presentation.name}: ${fact.words} · ${fact.basis}`}
          className={fact.kind === 'absent' ? 'opacity-25' : undefined}
        >
          {fact.kind === 'absent' ? null : <RuntimeMark runtime={agent} size={14} />}
        </span>
      )
    })}
  </span>
)

const factLine = (fact: SkillFact): string => {
  switch (fact.kind) {
    case 'asked-loads': return `Loads it · ${fact.basis}`
    case 'build-unconfirmed': return `On disk · can't confirm until it restarts · ${fact.basis}`
    case 'copies-differ': return `Its copy differs · ${fact.basis}`
    default: return `${fact.words} · ${fact.basis}`
  }
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
          key={`${skill.name}:${skill.source}`}
          interactive
          selected={skill === SELECTED}
          className="px-4"
          lead={<IconTile size="sm"><SparkIcon size={13} /></IconTile>}
          title={
            <span className="flex items-center gap-2">
              <span>{skill.name}</span>
              {skill.facts.some((fact) => fact.kind === 'copies-differ' || fact.kind === 'rejected')
                ? <AlertIcon size={13} aria-label={skill.note} />
                : null}
            </span>
          }
          subtitle={skill.description}
          trail={<PresenceStrip facts={skill.facts} />}
        />
      ))}
    </div>
  </div>
)

const InstalledIn = ({ applied }: { applied: boolean }) => (
  <section className="space-y-2">
    <div className="flex items-baseline justify-between">
      <Text role="section" as="h3">Installed in</Text>
      <Text role="meta">{SELECTED.scope} scope · ~/.&lt;agent&gt;/skills/{SELECTED.name}</Text>
    </div>
    <div className="divide-y rounded-lg border">
      {LIBRARY_AGENTS.map((agent, index) => {
        const fact = SELECTED.facts[index]!
        const pending = fact.kind === 'absent'
        const checked = applied || !pending
        const status = applied && pending
          ? agent.support.reportsCatalogue ? 'Written · load confirmation pending' : "Written · this agent can't confirm"
          : factLine(fact)
        return (
          <div key={agent.id} className="flex items-center gap-3 px-4 py-2.5">
            <Checkbox checked={checked} aria-label={`Installed in ${agent.presentation.name}`} />
            <RuntimeMark runtime={agent} size={16} />
            <Text role="row" className="w-32 shrink-0">{agent.presentation.name}</Text>
            <Text role="muted" className="flex min-w-0 flex-1 items-center gap-1.5">
              {fact.kind === 'asked-loads' ? <CheckIcon size={13} /> : null}
              {fact.kind === 'copies-differ' ? <DiffIcon size={13} /> : null}
              {status}
            </Text>
            {!applied && pending ? <Chip size="sm" tone="info">Will install</Chip> : null}
            {fact.kind === 'copies-differ' ? <Button size="sm" variant="outline">Compare…</Button> : null}
          </div>
        )
      })}
    </div>
  </section>
)

const PendingBar = () => (
  <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-3">
    <Text role="row">1 change · install for {LIBRARY_AGENTS[SELECTED.facts.findIndex((fact) => fact.kind === 'absent')]?.presentation.name} at {SELECTED.scope.toLowerCase()} scope</Text>
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
      <Text role="row">Written for {LIBRARY_AGENTS[SELECTED.facts.findIndex((fact) => fact.kind === 'absent')]?.presentation.name} · this agent can't confirm</Text>
    </span>
    <div className="flex items-center gap-2">
      <Button size="sm" variant="ghost">Undo</Button>
      {LIBRARY_AGENTS[SELECTED.facts.findIndex((fact) => fact.kind === 'absent')]?.support.catalogueRefresh === 'restart'
        ? <Button size="sm" variant="outline">Restart it now</Button>
        : null}
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
            <Chip tone="neutral" size="sm">{SELECTED.sourceVersion ? `${SELECTED.source.split('@')[0]} · ${SELECTED.sourceVersion}` : SELECTED.source}</Chip>
            <Chip size="sm" tone="info">4.3.0 available</Chip>
            <Text role="meta">{SELECTED.source} · pinned{SELECTED.sourceVersion ? ` to v${SELECTED.sourceVersion}` : ''}</Text>
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
