import { useEffect, useState, type ReactNode } from 'react'

import type { AgentEntry, AgentOrigin, AuthoringPending } from '@harnessdesk/protocol'

import {
  agentName,
  bySection,
  firstReason,
  markFor,
  originWords,
  projectName,
  seatTaken,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { DestinationBar, useDestinationPage } from '../panels/destination-page'
import { RuntimeMark } from './BrandIcons'
import { AgentNew } from './AgentNew'
import { AgentPage } from './AgentPage'
import { CeilingChip } from './CeilingChip'
import { Button, Chip, EmptyState, IconTile, MiddleTruncate, Monogram, Note, PageExplanation, Row, RowButton, RowValue, Rows, Section } from '../design'

/**
 * The Agents window's overview: who does the work.
 *
 * Three sections, in the order precedence reads them — this project's own,
 * yours, and the ones that ship — each footnoted with the folder it is read
 * from, because the file is the truth and the page says which file. A row is
 * an Agent's name and what it is for, with its ceiling and the seat it would
 * take here at the right. One that cannot be seated here stays, with *Can't
 * seat here* and the first reason. A copy another tier shadows is listed
 * where it lives, in the same idiom Settings › Plugins lists a superseded
 * plugin — a quiet word and a sentence, at full ink. A file that will not parse is a row whose line says why.
 */

const ORDER: readonly AgentOrigin[] = ['project', 'user', 'builtin']

const EMPTY: Readonly<Record<AgentOrigin, string>> = {
  project: 'No Agents in this project',
  user: 'None of your own yet',
  builtin: 'None ship with this build',
}
const NO_SHARED_FLAGS: ReadonlySet<string> = new Set()

/** The checkout actually read, never the main checkout a linked worktree belongs to. */
const footnote = (origin: AgentOrigin, folder: string | null, home: string | null): ReactNode => {
  if (origin === 'builtin') return 'Ships with HarnessDesk, and changes only when HarnessDesk does.'
  const fullPath = folder ? `${folder}/agents` : null
  const where = fullPath ? shortPath(fullPath, home) : 'the Agents folder'
  if (origin === 'user') return `Read from ${where} — yours, on this Mac only.`
  if (!folder) return `Read from ${where}, and committed with the code: everyone who clones it has these.`
  const suffix = where.split(/[\\/]/u).filter(Boolean).slice(-3).join('/')
  return <>
    <span>Read from</span>
    <MiddleTruncate grow prefix="…/" title={fullPath ?? undefined} aria-label={fullPath ?? undefined}>{suffix}</MiddleTruncate>
    <span>, and committed with the code: everyone who clones it has these.</span>
  </>
}

const initials = (name: string): string =>
  (name.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 2).map((part) => Array.from(part)[0] ?? '').join('').toLocaleUpperCase()

/** A seated Agent wears its runtime's mark; one without a seat gets its own initials. */
const AgentFace = ({ entry }: { readonly entry: AgentEntry }) => {
  const snapshot = useSnapshot()
  const candidate = seatTaken(snapshot.agentPlans.get(entry.id))
  return (
    <IconTile shape="face" {...(candidate ? { title: candidate.runtimeName } : {})}>
      {candidate
        ? <RuntimeMark runtime={markFor(candidate, snapshot.runtimes)} size={16} />
        : <Monogram>{initials(entry.definition?.name ?? entry.id)}</Monogram>}
    </IconTile>
  )
}

export const AgentsRosterSection = ({
  focus, onFocus,
}: {
  readonly focus: string | null
  readonly onFocus: (id: string | null) => void
}) => {
  const snapshot = useSnapshot()
  const open = focus, setOpen = onFocus
  const [creating, setCreating] = useState(false)

  const agents = snapshot.agents ?? []
  const project = projectName(snapshot.workspace)
  const sections = bySection(agents)
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
      <DestinationBar place="Agents" verb={{ label: 'New Agent…', run: () => setCreating(true) }} />
      <PageExplanation>Who does the work: a brief, the most it may do, and the seats it prefers.</PageExplanation>
      <AuthoringPendingSection />
      {ORDER.filter((origin) => origin !== 'project' || snapshot.workspace !== null).map((origin) => {
        const heading = originWords(origin, project)
        const rows = sections[origin]
        /* Every copy a winner shadows, in the section of the tier it lives in:
           listed and marked, never hidden. */
        const shadowed = agents.flatMap((winner) =>
          winner.shadows.filter((one) => one.origin === origin).map((one) => ({ winner, path: one.path })),
        )
        const flagCounts = new Map<string, number>()
        const ceilingCounts = new Map<string, number>()
        for (const entry of rows) {
          if (!entry.definition) continue
          const flag = flagWords(entry.definition)
          if (flag) flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1)
          const plan = snapshot.agentPlans.get(entry.id)
          if (!plan || !seatTaken(plan)) continue
          const ceiling = plan.ceiling ?? { level: entry.definition.ceiling, hold: 'asked' as const }
          const key = `${ceiling.level}:${ceiling.hold}`
          ceilingCounts.set(key, (ceilingCounts.get(key) ?? 0) + 1)
        }
        const sharedFlags = new Set([...flagCounts].filter(([, count]) => count > 1).map(([flag]) => flag))
        const mostCommon = [...ceilingCounts].sort((left, right) => right[1] - left[1])
        const sharedCeiling = mostCommon[0] && mostCommon[0][1] > 1 && mostCommon[0][1] > (mostCommon[1]?.[1] ?? 0)
          ? mostCommon[0][0]
          : null
        return (
          <Section key={origin} title={heading}>
            <Rows>
              {rows.length === 0 && shadowed.length === 0 && <EmptyState variant="row" title={EMPTY[origin]} />}
              {rows.map((entry) => {
                const plan = snapshot.agentPlans.get(entry.id)
                const candidate = seatTaken(plan)
                const ceiling = entry.definition
                  ? plan?.ceiling ?? { level: entry.definition.ceiling, hold: 'asked' as const }
                  : null
                const hideCeiling = Boolean(sharedCeiling && plan && candidate && ceiling && `${ceiling.level}:${ceiling.hold}` === sharedCeiling)
                return <AgentRow
                  key={entry.id}
                  entry={entry}
                  sharedFlags={sharedFlags}
                  hideCeiling={hideCeiling}
                  onOpen={() => {
                    setOpen(entry.id)
                  }}
                />
              })}
              {shadowed.map(({ winner, path }) => (
                <Row
                  key={path}
                  kind="record"
                  face={<AgentFace entry={winner} />}
                  title={agentName(winner)}
                  desc={`Shadowed by ${winner.origin === 'user' ? 'yours' : `the one in ${project ?? 'this project'}`}, which does the same job. This copy is not used.`}
                  /* A copy that is not used, said as a fact rather than a
                     warning — the way a superseded plugin's row says it. */
                  control={<RowValue>Shadowed</RowValue>}
                />
              ))}
            </Rows>
            {sharedFlags.size > 0 && [...sharedFlags].map((flag) => <Note key={flag} ink="muted" inset="row">{flag}</Note>)}
            <Note
              ink="muted"
              inset="row"
              {...(origin === 'project' && projectFolder ? { layout: 'inline' as const } : {})}
            >
              {footnote(origin, origin === 'user' ? snapshot.stateDir : projectFolder, snapshot.home)}
            </Note>
          </Section>
        )
      })}
      {creating && (
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

import { flagWords } from '../lib/ceilings'

/** One Agent in force, or one whose file will not parse — each a way into its page. */
export const AgentRow = ({ entry, onOpen, sharedFlags = NO_SHARED_FLAGS, hideCeiling = false }: {
  readonly entry: AgentEntry
  readonly onOpen: () => void
  readonly sharedFlags?: ReadonlySet<string>
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
  const flag = flagWords(definition)
  const description = [definition.description, flag && !sharedFlags.has(flag) ? flag : null].filter((part): part is string => Boolean(part)).join(' ')
  const desc = [description, seat?.label, !seat && reason].filter(Boolean).join(' · ')
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
    <Section title="Unfinished saves">
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
