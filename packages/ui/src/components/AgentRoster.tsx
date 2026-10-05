import { useEffect, useState } from 'react'

import type { AgentEntry, AgentOrigin, AuthoringPending } from '@harnessdesk/protocol'

import {
  agentName,
  bySection,
  firstReason,
  originWords,
  projectName,
  seatTaken,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import { projectRootOf } from '../lib/projects'
import { useSnapshot, useStore } from '../state/context'
import { AgentIcon } from './Icons'
import { AgentNew } from './AgentNew'
import { AgentPage } from './AgentPage'
import { CeilingChip } from './CeilingChip'
import { Button, Chip, EmptyState, IconTile, Note, PageHead, Row, RowButton, RowValue, Rows, Section } from '../design'

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

/** The checkout actually read, never the main checkout a linked worktree belongs to. */
const footnote = (origin: AgentOrigin, folder: string | null, home: string | null): string => {
  if (origin === 'builtin') return 'Ships with HarnessDesk, and changes only when HarnessDesk does.'
  const where = folder ? shortPath(`${folder}/agents`, home) : 'the Agents folder'
  if (origin === 'user') return `Read from ${where} — yours, on this Mac only.`
  return `Read from ${where}, and committed with the code: everyone who clones it has these.`
}

export const AgentsRosterSection = ({
  focus = null,
  onLeave = () => {},
  onFocus,
}: {
  /** An Agent to open on — *Open <Agent> in Settings*, the refusal sheet's *Edit seats for this Mac*, the rail. */
  readonly focus?: string | null
  /** Closes the Agents window, for what an Agent's page opens behind it. */
  readonly onLeave?: () => void
  /**
   * Tells the caller which Agent is open now, so the rail this section is
   * shown beside (`AgentsWindow`) can keep its own selection in step with a
   * row pressed here, or with *Back*. Optional: this section owns its own
   * open/closed state either way, which is what makes it — and this file's
   * own tests — usable with no window around it at all.
   */
  readonly onFocus?: (id: string | null) => void
}) => {
  const snapshot = useSnapshot()
  const [open, setOpen] = useState<string | null>(focus)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    setOpen(focus)
  }, [focus])

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
          onFocus?.(null)
        }}
        onLeave={onLeave}
      />
    )
  }

  return (
    <>
      <PageHead
        title="Agents"
        blurb="Who does the work: a brief, the most it may do, and the seats it prefers."
        actions={<Button variant="default" onClick={() => setCreating(true)}>New Agent…</Button>}
      />
      <AuthoringPendingSection />
      {ORDER.filter((origin) => origin !== 'project' || snapshot.workspace !== null).map((origin) => {
        const heading = originWords(origin, project)
        const rows = sections[origin]
        /* Every copy a winner shadows, in the section of the tier it lives in:
           listed and marked, never hidden. */
        const shadowed = agents.flatMap((winner) =>
          winner.shadows.filter((one) => one.origin === origin).map((one) => ({ winner, path: one.path })),
        )
        return (
          <Section key={origin} title={heading}>
            <Rows>
              {rows.length === 0 && shadowed.length === 0 && <EmptyState variant="row" title={EMPTY[origin]} />}
              {rows.map((entry) => (
                <AgentRow
                  key={entry.id}
                  entry={entry}
                  onOpen={() => {
                    setOpen(entry.id)
                    onFocus?.(entry.id)
                  }}
                />
              ))}
              {shadowed.map(({ winner, path }) => (
                <Row
                  key={path}
                  kind="record"
                  face={<IconTile shape="face"><AgentIcon size={16} /></IconTile>}
                  title={agentName(winner)}
                  desc={`Shadowed by ${winner.origin === 'user' ? 'yours' : `the one in ${project ?? 'this project'}`}, which does the same job. This copy is not used.`}
                  /* A copy that is not used, said as a fact rather than a
                     warning — the way a superseded plugin's row says it. */
                  control={<RowValue>Shadowed</RowValue>}
                />
              ))}
            </Rows>
            <Note ink="muted" inset="row">{footnote(origin, origin === 'user' ? snapshot.stateDir : projectFolder, snapshot.home)}</Note>
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
            onFocus?.(entry.id)
          }}
        />
      )}
    </>
  )
}

import { flagWords } from '../lib/ceilings'

/** One Agent in force, or one whose file will not parse — each a way into its page. */
export const AgentRow = ({ entry, onOpen }: { readonly entry: AgentEntry; readonly onOpen: () => void }) => {
  const snapshot = useSnapshot()
  const definition = entry.definition
  if (!definition) {
    const problem = entry.problems.find((one) => one.level === 'error')
    return (
      <RowButton
        kind="record"
        face={<IconTile shape="face"><AgentIcon size={16} /></IconTile>}
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
  const description = [definition.description, flag].filter((part): part is string => Boolean(part)).join(' ')
  const desc = [description, seat?.label, !seat && reason].filter(Boolean).join(' · ')
  const ceiling = plan?.ceiling ?? { level: definition.ceiling, hold: 'asked' as const }
  return (
    <RowButton
      kind="record"
      face={<IconTile shape="face"><AgentIcon size={16} /></IconTile>}
      title={definition.name}
      {...(desc ? { desc } : {})}
      control={
        !seat && plan ? <Chip tone="warning">Can't seat here</Chip>
          : !plan ? <RowValue>{snapshot.agentPlansFailed ? 'Its seats could not be checked' : 'Checking seats…'}</RowValue>
          : <CeilingChip ceiling={ceiling} />
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
  const [pending, setPending] = useState<readonly AuthoringPending[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
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
  }, [store])

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
              <span className="flex gap-(--hd-space-2)">
                <Button size="sm" variant="outline" disabled={busyId === one.id} onClick={() => void resume(one.id)}>
                  {busyId === one.id ? 'Resuming…' : 'Resume'}
                </Button>
                <Button size="sm" variant="ghost" disabled={busyId === one.id} onClick={() => void discard(one.id)}>
                  Discard
                </Button>
              </span>
            }
          />
        ))}
      </Rows>
      {problem && <Note tone="bad">{problem}</Note>}
    </Section>
  )
}
