import type { ReactNode } from 'react'

import { AppWindow, WindowGroup, WindowNav, WindowNavItem, WindowNavStateMark, WindowPage } from '../components/AppWindow'
import { RuntimeMark } from '../components/BrandIcons'
import { AlertIcon, BriefIcon, CheckIcon, CrossIcon, DiffIcon, FileIcon, FolderIcon, LibraryIcon, SearchIcon, ServerIcon, TodoPendingIcon, ToolIcon } from '../components/Icons'
import { Button, Chip, CodeText, Dot, Monogram, Row, RowButton, Rows, Segmented, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableCaption, Text } from '../design'
import { REACH_NAME, REACH_SENTENCE } from '../lib/reach-states'
import { Frame } from './main'
import {
  LIBRARY_AGENTS,
  LIBRARY_COMMAND,
  LIBRARY_NEEDS_YOU,
  LIBRARY_RECEIPT_TARGETS,
  LIBRARY_RULES,
  LIBRARY_RULE_FACT,
  LIBRARY_SERVER_FACTS,
  LIBRARY_SERVERS,
  LIBRARY_SKILLS,
  type SkillFact,
} from './library-options-fixture'

const noop = (): void => {}
const TIER_B_AGENT = LIBRARY_AGENTS.find((agent) => agent.support.catalogueRefresh === 'restart' && agent.support.folderEvidence === 'build') ?? LIBRARY_AGENTS[1]!
const AgentCapabilityChips = () => TIER_B_AGENT.support.reportsCatalogue
  ? <><Chip tone="neutral">Reports its catalogue</Chip><Chip tone="neutral">Has a switch</Chip><Chip tone="neutral">Re-reads live</Chip></>
  : <><Chip tone="neutral">Commands only</Chip><Chip tone="neutral">No switch</Chip><Chip tone="neutral">Re-reads on restart</Chip><Chip tone="neutral">Folders: build</Chip></>

const FactMark = ({ fact, label }: { fact: SkillFact; label: string }) => {
  const mark = fact.kind === 'asked-loads'
    ? <Dot state="ready" />
    : fact.kind === 'copies-differ'
      ? <DiffIcon size={13} />
      : fact.kind === 'rejected'
        ? <AlertIcon size={13} />
        : fact.kind === 'not-measured'
          ? <TodoPendingIcon size={10} />
          : fact.kind === 'build-unconfirmed'
            ? <Dot />
            : <ToolIcon size={13} />
  return <span role="img" aria-label={`${label}: ${fact.words}; ${fact.basis}`} title={`${fact.words} · ${fact.basis}`} className="inline-flex items-center justify-center">{mark}</span>
}

const ReachMarks = ({ facts, name }: { facts: readonly SkillFact[]; name: string }) => (
  <span className="flex items-center gap-2">
    {LIBRARY_AGENTS.map((agent, index) => (
      <span key={agent.id} className="inline-flex size-5 items-center justify-center" title={`${agent.presentation.name}: ${facts[index]?.words ?? 'Not measured'}`}>
        <FactMark fact={facts[index] ?? { kind: 'not-measured', basis: 'Table · no observation', words: 'Not measured' }} label={`${name} · ${agent.presentation.name}`} />
      </span>
    ))}
  </span>
)

const StaticSkillRows = ({ count = LIBRARY_SKILLS.length }: { count?: number }) => (
  <Rows>
    {LIBRARY_SKILLS.slice(0, count).map((skill) => (
      <RowButton
        key={`${skill.name}:${skill.source}`}
        data-slot="library-option-skill-row"
        onClick={noop}
        mark={<Monogram>{skill.name.slice(0, 2).toUpperCase()}</Monogram>}
        title={<><span>{skill.name}</span><Text role="muted" ink="muted"><CodeText as="code">/{skill.name}</CodeText></Text></>}
        desc={skill.description}
        control={<div className="flex flex-col items-end gap-1"><Text role="meta">{skill.note}</Text><ReachMarks facts={skill.facts} name={skill.name} /></div>}
      />
    ))}
  </Rows>
)

const AttentionStrip = () => (
  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
    <div className="flex items-center gap-2">
      <AlertIcon size={15} />
      <Text role="row">Copies differ · build facts need confirmation · 3 source updates</Text>
    </div>
    <Button size="sm" variant="outline">Review</Button>
  </div>
)

const PlaceSwitch = () => (
  <Segmented
    label="Where"
    value="mac"
    options={[{ value: 'mac', label: 'This Mac' }, { value: 'repository', label: 'This repository' }]}
    onChange={noop}
  />
)

const SettingsRail = () => (
  <aside className="border-r bg-sidebar p-4">
    <Text role="section" as="h3" className="mb-5">Settings</Text>
    <div className="space-y-5">
      <div>
        <Text role="meta" className="mb-2 block">Agents</Text>
        <Button variant="navigation" size="navigation" className="w-full justify-start">Runtimes</Button>
        <Button variant="navigation" size="navigation" className="w-full justify-start">Models</Button>
      </div>
      <div>
        <Text role="meta" className="mb-2 block">Capabilities</Text>
        <Button variant="navigation" size="navigation" className="w-full justify-start" data-selected="">Library</Button>
        <Button variant="navigation" size="navigation" className="w-full justify-start">Plugins</Button>
      </div>
    </div>
  </aside>
)

const LibrarySheet = () => (
  <aside className="min-w-0 border-l bg-muted/30 p-4">
    <div className="flex items-start justify-between gap-3">
      <div><Text role="section" as="h3">brainstorming</Text><Text role="meta">Skill · Overview · Reach · Content · Usage · History</Text></div>
      <Button size="icon-sm" variant="ghost" aria-label="Close"><CrossIcon size={13} /></Button>
    </div>
    <div className="mt-5 border-b pb-2"><Text role="section">Reach</Text></div>
    <Text role="muted" className="mt-3 block">What each agent reported, and when.</Text>
    <Rows className="mt-3">
      {LIBRARY_AGENTS.map((agent, index) => {
        const skill = LIBRARY_SKILLS.find((candidate) => candidate.name === 'brainstorming')!
        const fact = skill.facts[index] ?? { kind: 'not-measured' as const, basis: 'Table · no observation', words: 'Not measured' }
        return (
          <Row
            key={agent.id}
            mark={<span className="inline-flex size-6 items-center justify-center"><RuntimeMark runtime={agent} size={16} /></span>}
            title={agent.presentation.name}
            desc={fact.words}
            control={<Text role="meta">{fact.basis}</Text>}
          />
        )
      })}
    </Rows>
    <div className="mt-4 rounded-md border bg-background p-3">
      <Text role="row">Basis</Text>
      <Text role="meta" className="mt-1 block">Asked directly · current build · observed table. Facts older than this build need a re-check.</Text>
    </div>
  </aside>
)

const OptionA = () => (
  <Frame id="library-option-a" title="Option A — Settings page">
    <div className="grid min-h-screen grid-cols-[1fr_5fr] bg-background">
      <SettingsRail />
      <div className="grid min-w-0 grid-cols-[3fr_2fr]">
        <main className="min-w-0 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><Text role="page" as="h2">Library</Text><Text role="muted" className="mt-1 block">Skills, rules and servers across the agents on this machine.</Text></div>
            <Button size="sm">Add</Button>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3"><PlaceSwitch /><Button size="sm" variant="outline">Agents · All ▾</Button></div>
            <Text role="meta" className="inline-flex items-center gap-2"><SearchIcon size={14} />Search library</Text>
          </div>
          <div className="mt-4"><Segmented label="Library kind" value="skills" options={[
            { value: 'skills', label: 'Skills · 42' },
            { value: 'rules', label: 'Rules · 6' },
            { value: 'servers', label: 'Servers · 9' },
            { value: 'hooks', label: 'Hooks · 3' },
          ]} onChange={noop} /></div>
          <div className="mt-4"><AttentionStrip /></div>
          <div className="mt-4 flex items-center justify-between"><Text role="section">Skills</Text><Text role="meta">List · Matrix</Text></div>
          <div className="mt-2"><StaticSkillRows /></div>
          <div className="mt-4"><Text role="section">Commands</Text><Rows><RowButton mark={<ToolIcon size={14} />} title={LIBRARY_COMMAND.name} desc={LIBRARY_COMMAND.description} control={<Text role="meta">Command</Text>} onClick={noop} /></Rows></div>
        </main>
        <LibrarySheet />
      </div>
    </div>
  </Frame>
)

const AgentHealth = ({ state }: { state: 'in-step' | 'something-to-fix' | 'not-measured' }) => {
  const label = state === 'in-step' ? 'In step' : state === 'something-to-fix' ? 'Something to fix' : 'Not measured'
  const readiness = state === 'in-step' ? 'ready' : state === 'something-to-fix' ? 'broken' : 'available'
  return <WindowNavStateMark><Dot state={readiness} variant="navigation" role="img" aria-label={label} title={label} /></WindowNavStateMark>
}

const AgentPage = () => (
  <>
    <div className="mb-5">
      <Text role="page" as="h2">{TIER_B_AGENT.presentation.name}</Text>
      <Text role="muted" className="mt-1 block">Its commands and known folders.</Text>
    </div>
    <div className="mb-5 flex flex-wrap gap-2">
      <AgentCapabilityChips />
    </div>
    <div className="mb-5"><AttentionStrip /></div>
    <OverviewMatrix />
    <div className="space-y-5">
      <section><div className="mb-2 flex items-center justify-between"><Text role="section">Skills</Text><Text role="meta">42</Text></div><StaticSkillRows count={3} /></section>
      <section><div className="mb-2 flex items-center justify-between"><Text role="section">Commands</Text><Text role="meta">Commands only</Text></div><Rows><Row mark={<ToolIcon size={14} />} title={LIBRARY_COMMAND.name} desc={LIBRARY_COMMAND.description} control={<Text role="meta">Advertised command</Text>} /></Rows></section>
      <section><div className="mb-2 flex items-center justify-between"><Text role="section">Rules</Text><Text role="meta">6</Text></div><Rows>{LIBRARY_RULES.map((rule) => <Row key={`${rule.place}-${rule.name}`} mark={<FileIcon size={15} />} title={rule.name} desc={rule.place} control={<Text role="meta">{rule.note}</Text>} />)}</Rows></section>
      <section><div className="mb-2 flex items-center justify-between"><Text role="section">Servers</Text><Text role="meta">9</Text></div><Rows>{LIBRARY_SERVERS.slice(0, 2).map((server) => <Row key={server.name} mark={<ServerIcon size={15} />} title={server.name} desc={server.note} control={<Chip state={server.status === 'Ready' ? 'ready' : 'signin'}>{server.status}</Chip>} />)}</Rows></section>
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"><Text role="section">Hooks</Text><Text role="meta">Not measured for this agent</Text></section>
      <section className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"><Text role="section">Store</Text><Button size="sm" variant="outline">Open store</Button></section>
    </div>
  </>
)

const OverviewMatrix = () => (
  <section className="mb-5 rounded-lg border bg-card p-3" aria-label="Overview reach matrix">
    <div className="mb-3 flex items-center justify-between"><Text role="section">Overview</Text><Text role="meta">Reach across agents</Text></div>
    <div className="grid grid-cols-5 items-center gap-y-2">
      <Text role="meta">Skills</Text>
      {LIBRARY_AGENTS.map((agent) => <span key={agent.id} className="flex justify-center" title={agent.presentation.name}><RuntimeMark runtime={agent} size={13} /></span>)}
      {LIBRARY_SKILLS.slice(0, 3).map((skill) => (
        <div key={skill.name} className="contents">
          <Text role="muted" truncate>{skill.name}</Text>
          {LIBRARY_AGENTS.map((agent, index) => {
            const fact = skill.facts[index] ?? { kind: 'not-measured' as const, basis: 'Table · no observation', words: 'Not measured' }
            return <span key={`${skill.name}-${agent.id}`} className="flex justify-center" title={`${agent.presentation.name}: ${fact.words} · ${fact.basis}`}><FactMark fact={fact} label={`${skill.name} · ${agent.presentation.name}`} /></span>
          })}
        </div>
      ))}
    </div>
  </section>
)

const OptionB = () => (
  <Frame id="library-option-b" title="Option B — Library window by agent">
    <div className="relative min-h-screen" style={{ transform: 'translateZ(0)' }}>
      <AppWindow label="Library">
        <WindowNav onBack={noop}>
          <WindowNavItem icon={<LibraryIcon size={14} />} label="Overview" selected={false} onClick={noop} />
          <WindowNavItem icon={<FolderIcon size={14} />} label="This repository" selected={false} onClick={noop} />
          <WindowGroup label="Agents">
            {LIBRARY_AGENTS.map((agent, index) => (
              <WindowNavItem key={agent.id} icon={<RuntimeMark runtime={agent} size={14} />} label={agent.presentation.name} count={[42, 40, 12, undefined][index]} trail={<AgentHealth state={agent.health} />} selected={agent.id === TIER_B_AGENT.id} onClick={noop} />
            ))}
          </WindowGroup>
        </WindowNav>
        <WindowPage>
          <AgentPage />
        </WindowPage>
      </AppWindow>
    </div>
  </Frame>
)

const OptionC = () => (
  <Frame id="library-option-c" title="Option C — Library window with fix queue">
    <div className="relative min-h-screen" style={{ transform: 'translateZ(0)' }}>
      <AppWindow label="Library">
        <WindowNav onBack={noop}>
          <WindowNavItem icon={<AlertIcon size={14} />} label="Needs you" count={LIBRARY_NEEDS_YOU.length} selected onClick={noop} />
          <WindowGroup label="Kit">
            <WindowNavItem icon={<BriefIcon size={14} />} label="Skills" count={42} selected={false} onClick={noop} />
            <WindowNavItem icon={<FileIcon size={14} />} label="Rules" count={6} selected={false} onClick={noop} />
            <WindowNavItem icon={<ServerIcon size={14} />} label="Servers" count={9} selected={false} onClick={noop} />
            <WindowNavItem icon={<ToolIcon size={14} />} label="Hooks" count={3} selected={false} onClick={noop} />
          </WindowGroup>
          <WindowGroup label="Places">
            <WindowNavItem icon={<FolderIcon size={14} />} label="This Mac" selected={false} onClick={noop} />
            <WindowNavItem icon={<FolderIcon size={14} />} label="storefront" selected={false} onClick={noop} />
            <WindowNavItem icon={<FileIcon size={14} />} label="What applies here" selected={false} onClick={noop} />
          </WindowGroup>
          <WindowGroup label="Agents">
            {LIBRARY_AGENTS.map((agent, index) => <WindowNavItem key={agent.id} icon={<RuntimeMark runtime={agent} size={14} />} label={agent.presentation.name} count={[42, 40, 12, undefined][index]} trail={<AgentHealth state={agent.health} />} selected={false} onClick={noop} />)}
          </WindowGroup>
        </WindowNav>
        <WindowPage>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div><Text role="page" as="h2">Needs you</Text><Text role="muted" className="mt-1 block">Five decisions to keep your kit in step.</Text></div>
            <PlaceSwitch />
          </div>
          <div className="space-y-3">
            {LIBRARY_NEEDS_YOU.map((item) => (
              <article key={item.id} className="rounded-lg border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2"><Text role="section">{item.title}</Text><Chip tone="neutral">{item.kind}</Chip></div>
                    <Text role="muted" className="block">{item.decision}</Text>
                  </div>
                  <Button size="sm" variant="outline">{item.action}</Button>
                </div>
                {'receipt' in item && item.receipt && (
                  <div className="mt-4 border-t pt-3">
                    <Text role="meta" className="mb-2 block">Receipt · 3 of 4 changed</Text>
                    <Rows>
                      {LIBRARY_RECEIPT_TARGETS.map((target) => (
                        <Row
                          key={target.name}
                          mark={target.changed ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                          title={target.name}
                          desc={target.state}
                          control={<span className="flex flex-wrap gap-2">
                            {target.recheck && <Button size="sm" variant="ghost">Have it look again</Button>}
                            {target.retry && <Button size="sm" variant="ghost">Retry</Button>}
                            {target.backup && <Button size="sm" variant="ghost">Restore</Button>}
                          </span>}
                        />
                      ))}
                    </Rows>
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="mt-5 flex items-center gap-2 rounded-md bg-success/10 px-3 py-2"><CheckIcon size={14} /><Text role="meta">When the queue is clear: Your kit is in step.</Text></div>
        </WindowPage>
      </AppWindow>
    </div>
  </Frame>
)

type MatrixFact = { readonly kind: string; readonly basis: string; readonly words: string }

const InventoryMark = ({ fact, item, agent }: { fact: MatrixFact; item: string; agent: string }) => {
  const label = `${item} — ${agent}: ${fact.words} · ${fact.basis}`
  const mark = fact.kind === 'asked-loads'
    ? <Dot state="ready" />
    : fact.kind === 'copies-differ'
      ? <DiffIcon size={13} />
      : fact.kind === 'rejected'
        ? <AlertIcon size={13} />
        : fact.kind === 'not-measured'
          ? <TodoPendingIcon size={10} />
          : fact.kind === 'build-unconfirmed'
            ? <Dot state="available" />
            : fact.kind === 'server-ready'
              ? <Dot state="ready" />
              : fact.kind === 'server-signin'
                ? <AlertIcon size={13} />
                : fact.kind === 'command'
                  ? <ToolIcon size={13} />
                  : <Text role="meta">—</Text>
  return (
    <Text role="meta" ink="muted" className="inline-flex w-full items-center justify-center">
      <span role="img" aria-label={label} title={`${fact.basis} · ${fact.words}`} className="inline-flex items-center justify-center">{mark}</span>
    </Text>
  )
}

const MatrixLegend = () => (
  <Text as="p" role="meta" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2">
    <span className="inline-flex items-center gap-1.5"><Dot state="ready" /><Text role="meta">{REACH_SENTENCE.reaches}</Text></span>
    <span className="inline-flex items-center gap-1.5"><DiffIcon size={13} /><Text role="meta">{REACH_NAME.differs}</Text></span>
    <span className="inline-flex items-center gap-1.5"><AlertIcon size={13} /><Text role="meta">{REACH_NAME.rejected}</Text></span>
    <span className="inline-flex items-center gap-1.5"><Dot state="available" /><Text role="meta">On disk — not confirmed</Text></span>
    <span className="inline-flex items-center gap-1.5"><TodoPendingIcon size={10} /><Text role="meta">Not measured</Text></span>
    <span className="inline-flex items-center gap-1.5"><ToolIcon size={13} /><Text role="meta">Command</Text></span>
    <span className="inline-flex items-center gap-1.5"><AlertIcon size={13} /><Text role="meta">Needs sign-in</Text></span>
  </Text>
)

const MatrixGroupRow = ({ children, columns }: { children: string; columns: number }) => (
  <TableRow variant="matrix" className="bg-(--hd-muted)">
    <TableCell variant="matrix" colSpan={columns} className="text-left">
      <div className="flex min-h-7 items-center px-3 py-1"><Text role="row">{children}</Text></div>
    </TableCell>
  </TableRow>
)

const MatrixName = ({ name, detail }: { name: string; detail?: string }) => (
  <span className="flex min-h-7 flex-col justify-center px-3 py-1">
    <Text role="navigation">{name}</Text>
    {detail && <Text role="meta">{detail}</Text>}
  </span>
)

const MatrixFactCell = ({ children, title }: { children: ReactNode; title: string }) => (
  <TableCell variant="matrix" title={title}><span className="flex min-h-7 items-center justify-center py-1">{children}</span></TableCell>
)

const OptionD = () => {
  const repoSkills = LIBRARY_SKILLS.filter((skill) => skill.name !== 'migration-map')
  const repositoryCopy = LIBRARY_SKILLS.find((skill) => skill.name === 'migration-map' && skill.source === 'This repository')!
  const macCopy = LIBRARY_SKILLS.find((skill) => skill.name === 'migration-map' && skill.source === 'This Mac')!
  const skillRows = [
    ...repoSkills,
    { ...repositoryCopy, name: 'migration-map — repository' },
    { ...macCopy, name: 'migration-map — this Mac' },
  ]
  return (
    <Frame id="library-option-d" title="Option D — recommended: inventory window with Needs you">
      <div className="relative min-h-screen" style={{ transform: 'translateZ(0)' }}>
        <AppWindow label="Library">
          <WindowNav onBack={noop}>
            <WindowNavItem icon={<LibraryIcon size={14} />} label="Overview" selected onClick={noop} />
            <WindowNavItem icon={<AlertIcon size={14} />} label="Needs you" count={LIBRARY_NEEDS_YOU.length} selected={false} onClick={noop} />
            <WindowGroup label="Kit">
              <WindowNavItem icon={<BriefIcon size={14} />} label="Skills" count={42} selected={false} onClick={noop} />
              <WindowNavItem icon={<FileIcon size={14} />} label="Rules" count={6} selected={false} onClick={noop} />
              <WindowNavItem icon={<ServerIcon size={14} />} label="Servers" count={9} selected={false} onClick={noop} />
              <WindowNavItem icon={<ToolIcon size={14} />} label="Hooks" count={3} selected={false} onClick={noop} />
            </WindowGroup>
            <WindowGroup label="Places">
              <WindowNavItem icon={<FolderIcon size={14} />} label="This Mac" selected={false} onClick={noop} />
              <WindowNavItem icon={<FolderIcon size={14} />} label="storefront" selected={false} onClick={noop} />
              <WindowNavItem icon={<FileIcon size={14} />} label="What applies here" selected={false} onClick={noop} />
            </WindowGroup>
            <WindowGroup label="Agents">
              {LIBRARY_AGENTS.map((agent) => (
                <WindowNavItem key={agent.id} icon={<RuntimeMark runtime={agent} size={14} />} label={agent.presentation.name} trail={<AgentHealth state={agent.health} />} selected={false} onClick={noop} />
              ))}
            </WindowGroup>
          </WindowNav>
          <WindowPage wide>
            <Text role="page" as="h2">Overview</Text>
            <div className="mt-2 mb-4 flex flex-wrap items-center gap-3">
              <PlaceSwitch />
              <Button size="sm" variant="link">5 need you →</Button>
              <Button size="sm" className="ml-auto">Add</Button>
            </div>
            <div>
              <Table variant="framed">
                <TableCaption variant="sr-only">Inventory rows by item and columns by agent. Each mark has its evidence and age in its accessible title.</TableCaption>
                <TableHeader>
                  <TableRow variant="matrix">
                    <TableHead variant="matrix" pinned scope="col" className="min-w-64 px-3"><Text role="muted">Name</Text></TableHead>
                    {LIBRARY_AGENTS.map((agent) => <TableHead key={agent.id} variant="matrix" align="center" scope="col" className="w-40"><Text role="muted" className="inline-flex items-center justify-center gap-1.5" title={agent.presentation.name} truncate><RuntimeMark runtime={agent} size={13} />{agent.presentation.name}</Text></TableHead>)}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <MatrixGroupRow columns={LIBRARY_AGENTS.length + 1}>Skills</MatrixGroupRow>
                  {skillRows.map((skill) => (
                    <TableRow key={`${skill.name}-${skill.source}`} variant="matrix">
                      <TableHead variant="row" pinned scope="row"><MatrixName name={skill.name} /></TableHead>
                      {LIBRARY_AGENTS.map((agent, index) => <MatrixFactCell key={agent.id} title={`${skill.facts[index]?.basis ?? 'Table · no observation'} · ${skill.facts[index]?.words ?? 'Not measured'}`}><InventoryMark fact={skill.facts[index] ?? { kind: 'not-measured', basis: 'Table · no observation', words: 'Not measured' }} item={skill.name} agent={agent.presentation.name} /></MatrixFactCell>)}
                    </TableRow>
                  ))}
                  <MatrixGroupRow columns={LIBRARY_AGENTS.length + 1}>Rules</MatrixGroupRow>
                  {LIBRARY_RULES.map((rule) => (
                    <TableRow key={`${rule.place}-${rule.name}`} variant="matrix">
                      <TableHead variant="row" pinned scope="row"><MatrixName name={rule.name} detail={rule.place === 'Repository root' ? undefined : rule.place} /></TableHead>
                      {LIBRARY_AGENTS.map((agent, index) => <MatrixFactCell key={agent.id} title={`${LIBRARY_RULE_FACT[index]?.basis ?? 'Table'} · ${LIBRARY_RULE_FACT[index]?.words ?? 'Not measured'}`}><InventoryMark fact={LIBRARY_RULE_FACT[index] ?? { kind: 'not-measured', basis: 'Table', words: 'Not measured' }} item={rule.name} agent={agent.presentation.name} /></MatrixFactCell>)}
                    </TableRow>
                  ))}
                  <MatrixGroupRow columns={LIBRARY_AGENTS.length + 1}>Servers</MatrixGroupRow>
                  {LIBRARY_SERVERS.map((server, rowIndex) => (
                    <TableRow key={server.name} variant="matrix">
                      <TableHead variant="row" pinned scope="row"><MatrixName name={server.name} /></TableHead>
                      {LIBRARY_AGENTS.map((agent, index) => {
                        const fact = LIBRARY_SERVER_FACTS[rowIndex]?.[index] ?? { kind: 'not-measured', basis: 'Table · status not measured', words: 'Configured · not measured' }
                        return <MatrixFactCell key={agent.id} title={`${fact.basis} · ${fact.words}`}><InventoryMark fact={fact} item={server.name} agent={agent.presentation.name} /></MatrixFactCell>
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-2"><MatrixLegend /></div>
          </WindowPage>
        </AppWindow>
      </div>
    </Frame>
  )
}

export const LibraryOptionFrames = () => (
  <section aria-label="Library UX options" className="mt-8 space-y-6">
    <Text role="section" as="h2">Library — UX options</Text>
    <div className="grid grid-cols-1 gap-6">
      <OptionA />
      <OptionB />
      <OptionC />
      <OptionD />
    </div>
  </section>
)
