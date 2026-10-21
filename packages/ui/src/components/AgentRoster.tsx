import { useEffect, useState, type ReactNode } from 'react'

import type { AgentEntry, AgentOrigin, AuthoringPending } from '@harnessdesk/protocol'

import {
  agentName,
  bySection,
  firstReason,
  seatTaken,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { DestinationBar, useDestinationPage } from '../panels/destination-page'
import { AgentFace } from './AgentFace'
import { AgentNew } from './AgentNew'
import { AgentPage } from './AgentPage'
import { CeilingChip } from './CeilingChip'
import { AgentCatalogue, AgentCatalogueCard, AgentCatalogueSources, Button, Chip, EmptyState, MiddleTruncate, Note, PageExplanation, PageOptions, Row, RowButton, RowValue, Rows, Section } from '../design'

/** Reusable roles in precedence order; source files and shadowed copies remain inspectable in one disclosure. */
const ORDER: readonly AgentOrigin[] = ['project', 'user', 'builtin']
const SOURCE_LABEL: Readonly<Record<AgentOrigin, string>> = { project: 'Project', user: 'Yours', builtin: 'Built in' }

const EMPTY: Readonly<Record<AgentOrigin, string>> = {
  project: 'No Agents in this project',
  user: 'None of your own yet',
  builtin: 'None ship with this build',
}
/** The checkout actually read, never the main checkout a linked worktree belongs to. */
const footnote = (origin: AgentOrigin, folder: string | null, home: string | null): ReactNode => {
  if (origin === 'builtin') return 'Ships with HarnessDesk, and changes only when HarnessDesk does.'
  const fullPath = folder ? `${folder}/agents` : null
  const where = fullPath ? shortPath(fullPath, home) : 'the Agents folder'
  if (origin === 'user') {
    if (!fullPath) return `Read from ${where} — yours, on this Mac only.`
    return <>
      <span>Read from</span>
      <MiddleTruncate title={fullPath} aria-label={fullPath}>{where}</MiddleTruncate>
      <span>— yours, on this Mac only.</span>
    </>
  }
  if (!folder) return `Read from ${where}, and committed with the code: everyone who clones it has these.`
  const suffix = where.split(/[\\/]/u).filter(Boolean).slice(-3).join('/')
  return <>
    <span>Read from</span>
    <MiddleTruncate prefix="…/" title={fullPath ?? undefined} aria-label={fullPath ?? undefined}>{suffix}</MiddleTruncate>
    <span>, and committed with the code: everyone who clones it has these.</span>
  </>
}

export const AgentsRosterSection = ({
  focus, onFocus,
}: {
  readonly focus: string | null
  readonly onFocus: (id: string | null) => void
}) => {
  const snapshot = useSnapshot()
  const store = useStore()
  const { active } = useDestinationPage()
  const open = focus, setOpen = onFocus
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [originFilter, setOriginFilter] = useState('all')
  useEffect(() => { if (!active) setCreating(false) }, [active])

  const agents = snapshot.agents ?? []
  const needle = query.trim().toLocaleLowerCase()
  const scopedOrigin = snapshot.workspace || originFilter !== 'project' ? originFilter : 'all'
  const visible = agents.filter(entry => (scopedOrigin === 'all' || entry.origin === scopedOrigin) &&
    (!needle || [entry.id, agentName(entry), entry.definition?.description, seatTaken(snapshot.agentPlans.get(entry.id))?.label,
      snapshot.agentPlans.has(entry.id) ? firstReason(snapshot.agentPlans.get(entry.id)!, snapshot.runtimes) : null].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle)))
  const sections = bySection(visible)
  const opened = open ? agents.find((one) => one.id === open) : undefined
  // The folder is named only for the roster on screen. While the one read for the workspace open before is still shown
  // (the new load in flight, or failed), the open workspace's folder would name files these rows were not read from.
  const projectFolder = snapshot.workspace && snapshot.agentsProject === snapshot.workspace.path
    ? `${snapshot.workspace.checkoutRoot ?? snapshot.workspace.path}/.harnessdesk`
    : null
  if (opened) {
    return (
      <AgentPage
        key={opened.id}
        entry={opened}
        onBack={() => {
          setOpen(null)
        }}
      />
    )
  }

  return (
    <>
      <DestinationBar place="Agents" />
      <PageOptions title="Agents" action={{ label: 'New Agent…', run: () => setCreating(true) }}
        choices={[{ id: 'origin', label: 'Agent origin', value: scopedOrigin,
          items: [{ value: 'all', label: 'All origins' }, ...(snapshot.workspace ? [{ value: 'project', label: 'Project' }] : []),
            { value: 'user', label: 'Yours' }, { value: 'builtin', label: 'Built in' }], change: setOriginFilter }]}
        search={{ label: 'Search Agents', value: query, change: setQuery }} />
      <PageExplanation>Reusable roles for your Teams.</PageExplanation>
      <AuthoringPendingSection />
      {visible.length === 0 && (needle || scopedOrigin !== 'all')
        ? <EmptyState title="No matching Agents" description="Try another search or origin." />
        : ORDER.filter(origin => (origin !== 'project' || snapshot.workspace !== null) && (scopedOrigin === 'all' || scopedOrigin === origin))
          .filter(origin => !needle || sections[origin].length > 0).map(origin => (
            <Section level="heading" key={origin} title={SOURCE_LABEL[origin]}>
              {sections[origin].length === 0
                ? <EmptyState variant="row" title={EMPTY[origin]} />
                : <AgentCatalogue>{sections[origin].map(entry => <RosterCard key={entry.id} entry={entry} onOpen={() => setOpen(entry.id)} />)}</AgentCatalogue>}
            </Section>
          ))}
      {snapshot.agentPlansFailed && <Note tone="warn">Seats could not be checked. <Button variant="ghost" size="sm" onClick={() => void store.loadAgents()}>Retry</Button></Note>}
      <AgentCatalogueSources>
        <Note>Project Agents come first, then yours, then built in. Copies with the same ID use that order.</Note>
        {ORDER.filter(origin => origin !== 'project' || snapshot.workspace !== null).map(origin => {
          const shadowed = agents.flatMap(winner => winner.shadows.filter(one => one.origin === origin).map(one => ({ winner, path: one.path })))
          return <Section level="heading" key={origin} title={`Sources: ${SOURCE_LABEL[origin]}`}>
            <Note ink="muted" inset="row" {...((origin === 'project' && projectFolder) || (origin === 'user' && snapshot.stateDir) ? { layout: 'inline' as const } : {})}>
              {footnote(origin, origin === 'user' ? snapshot.stateDir : projectFolder, snapshot.home)}
            </Note>
            {shadowed.length > 0 && <Rows>{shadowed.map(({ winner, path }) => <Row key={path}
              reserveChevronSlot kind="record" face={<AgentFace entry={winner} />} title={agentName(winner)}
              desc={`Shadowed by ${winner.origin === 'user' ? 'yours' : 'the project copy'}. This copy is not used.`}
              control={<Chip tone="neutral">Shadowed</Chip>} />)}</Rows>}
          </Section>
        })}
      </AgentCatalogueSources>
      {active && creating && (
        <AgentNew
          root={projectRootOf(snapshot.workspace) ?? undefined}
          onClose={() => setCreating(false)}
          onCreated={(entry) => {
            setCreating(false)
            setOpen(entry.id)
          }}
        />
      )}
    </>
  )
}

/** The catalogue keeps seating facts separate from the role's own purpose. */
const RosterCard = ({ entry, onOpen }: { readonly entry: AgentEntry; readonly onOpen: () => void }) => {
  const snapshot = useSnapshot()
  const definition = entry.definition
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const invalid = !definition
  const parseProblem = entry.problems.find(one => one.level === 'error')
  const problem = invalid
    ? parseProblem ? `${parseProblem.at} — ${parseProblem.text}` : 'Its file could not be read.'
    : plan && !seat ? firstReason(plan, snapshot.runtimes) ?? 'Its seats could not be read.' : null
  const status = invalid ? 'Will not parse'
    : !plan ? snapshot.agentPlansFailed ? 'Seats not checked' : 'Checking seats…'
      : !seat ? "Can't seat here" : null
  return <AgentCatalogueCard name={agentName(entry)} description={definition?.description ?? 'Open this Agent to inspect its file.'}
    face={<AgentFace entry={entry} />} runtime={seat?.label} status={status} problem={problem} broken={invalid}
    ceiling={definition && seat ? <CeilingChip ceiling={plan?.ceiling ?? { level: definition.ceiling, hold: 'asked' }} /> : undefined}
    onOpen={onOpen} />
}

/** One Agent in force, or one whose file will not parse — each a way into its page. */
export const AgentRow = ({ entry, onOpen, hideCeiling = false }: {
  readonly entry: AgentEntry
  readonly onOpen: () => void
  readonly hideCeiling?: boolean
}) => {
  const snapshot = useSnapshot()
  const definition = entry.definition
  if (!definition) {
    const problem = entry.problems.find((one) => one.level === 'error')
    return (
      <RowButton
        kind="record"
        face={<AgentFace entry={entry} />}
        title={entry.id}
        desc={problem ? `${problem.at} — ${problem.text}` : 'Its file could not be read.'}
        control={<Chip state="broken" label="Will not parse" />}
        onClick={onOpen}
      />
    )
  }
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const reason = plan ? firstReason(plan) : null
  const desc = [definition.description, seat?.label, !seat && reason].filter(Boolean).join(' · ')
  const ceiling = plan?.ceiling ?? { level: definition.ceiling, hold: 'asked' as const }
  return (
    <RowButton
      kind="record"
      face={<AgentFace entry={entry} />}
      title={definition.name}
      {...(desc ? { desc } : {})}
      control={
        !seat && plan ? <Chip tone="warning">Can't seat here</Chip>
          : !plan ? <RowValue>{snapshot.agentPlansFailed ? 'Its seats could not be checked' : 'Checking seats…'}</RowValue>
          : !hideCeiling && <CeilingChip ceiling={ceiling} />
      }
      onClick={onOpen}
    />
  )
}

/**
 * A save that began and did not finish — a crash, a killed process, a lost
 * power — read once when this window opens. `AgentFields` and `AgentNew`
 * write through the same journaled transaction (Task 2's `AuthoringPlane`),
 * so a restart offers exactly this: resume it, which checks each file on
 * disk before writing what is missing, or discard the record, which leaves
 * every file as it is. Nothing here resumes on its own.
 */
const AuthoringPendingSection = () => {
  const store = useStore()
  const { active } = useDestinationPage()
  const [pending, setPending] = useState<readonly AuthoringPending[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let live = true
    store.authoringPending().then(
      (next) => {
        if (live) setPending(next)
      },
      () => {
        if (live) setPending([])
      },
    )
    return () => {
      live = false
    }
  }, [active, store])

  if (!pending || pending.length === 0) return null

  const resume = async (id: string): Promise<void> => {
    setBusyId(id)
    setProblem(null)
    try {
      const preview = await store.resumeAuthoringSave(id)
      if (!preview.token) {
        setProblem(preview.issues[0]?.text ?? 'This save could not be resumed.')
        return
      }
      const result = await store.applyAuthoringSave(preview.token)
      if (result.state !== 'applied') {
        setProblem(result.message)
        return
      }
      setPending(await store.authoringPending())
      void store.loadAgents()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  const discard = async (id: string): Promise<void> => {
    setBusyId(id)
    setProblem(null)
    try {
      setPending(await store.discardAuthoringSave(id))
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyId(null)
    }
  }

  /** Where an unfinished save is — a title, not the sentence that belongs under it, and never a raw path. */
  const placeWords = (one: AuthoringPending): string => {
    if (one.scope !== 'project' || !one.root) return 'On this Mac'
    const name = one.root.split('/').filter(Boolean).at(-1)
    return `In ${name ?? 'a project'}`
  }

  return (
    <Section level="heading" title="Unfinished saves">
      <Rows>
        {pending.map((one) => (
          <Row
            key={one.id}
            title={placeWords(one)}
            desc={one.message}
            control={
              <>
                <Button size="sm" variant="outline" disabled={busyId === one.id} onClick={() => void resume(one.id)}>
                  {busyId === one.id ? 'Resuming…' : 'Resume'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busyId === one.id} onClick={() => void discard(one.id)}>
                  Discard
                </Button>
              </>
            }
          />
        ))}
      </Rows>
      {problem && <Note tone="bad">{problem}</Note>}
    </Section>
  )
}
