import type { AgentEntry, AgentOrigin } from '@harnessdesk/protocol'

import {
  agentName,
  bySection,
  ceilingMeaning,
  ceilingWords,
  firstReason,
  markFor,
  originWords,
  projectName,
  seatTaken,
} from '../lib/agents'
import { shortPath } from '../lib/paths'
import type { AppSnapshot } from '../state/store'
import { useSnapshot } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { Chip, Note, PageHead, Row, RowValue, Rows, SectionHead } from '../design'
import styles from './AgentRoster.module.css'

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
 * plugin — a chip and a sentence, never a muted title the app draws nowhere
 * else. A file that will not parse is a row whose line says why.
 */

const ORDER: readonly AgentOrigin[] = ['project', 'user', 'builtin']

const EMPTY: Readonly<Record<AgentOrigin, string>> = {
  project: 'No Agents in this project',
  user: 'None of your own yet',
  builtin: 'None ship with this build',
}

/**
 * The folder a project's Agents are read from: the top of the checkout the
 * open folder sits in, or a linked worktree's own top — the same folder
 * `agent/list` reads (Task 12's `projectOf`), read here from an entry's own
 * path when the roster already has one, or from `checkoutRoot` otherwise
 * (`projectName`'s own rule, `lib/agents.ts`) — never `workspace.repo.root`,
 * which deliberately names the *main* checkout for a linked worktree.
 */
const projectFolder = (snapshot: AppSnapshot): string | null => {
  const first = (snapshot.agents ?? []).find((one) => one.origin === 'project')
  if (first) return first.path.split('/').slice(0, -2).join('/')
  const workspace = snapshot.workspace
  if (!workspace) return null
  const root = workspace.checkoutRoot ?? workspace.path
  return `${root}/.harnessdesk/agents`
}

const footnote = (origin: AgentOrigin, snapshot: AppSnapshot): string => {
  if (origin === 'builtin') return 'Ships with HarnessDesk, and changes only when HarnessDesk does.'
  if (origin === 'user') {
    const folder = snapshot.stateDir ? shortPath(`${snapshot.stateDir}/agents`, snapshot.home) : 'agents in HarnessDesk’s folder'
    return `Read from ${folder} — yours, on this Mac only.`
  }
  const folder = projectFolder(snapshot)
  return `Read from ${folder ? shortPath(folder, snapshot.home) : 'the project'}, and committed with the code: everyone who clones it has these.`
}

export const AgentsRosterSection = () => {
  const snapshot = useSnapshot()

  const agents = snapshot.agents ?? []
  const project = projectName(snapshot.workspace)
  const sections = bySection(agents)

  return (
    <>
      <PageHead title="Agents" blurb="Who does the work: a brief, the most it may do, and the seats it prefers." />
      {ORDER.filter((origin) => origin !== 'project' || snapshot.workspace !== null).map((origin) => {
        const heading = originWords(origin, project)
        const rows = sections[origin]
        /* Every copy a winner shadows, in the section of the tier it lives in:
           listed and marked, never hidden. */
        const shadowed = agents.flatMap((winner) =>
          winner.shadows.filter((one) => one.origin === origin).map((one) => ({ winner, path: one.path })),
        )
        return (
          <section key={origin} aria-label={heading}>
            <SectionHead name={heading} />
            <Rows>
              {rows.length === 0 && shadowed.length === 0 && <Row title={EMPTY[origin]} />}
              {rows.map((entry) => (
                <AgentRow key={entry.id} entry={entry} />
              ))}
              {shadowed.map(({ winner, path }) => (
                <Row
                  key={path}
                  title={agentName(winner)}
                  desc={`Shadowed by ${winner.origin === 'user' ? 'yours' : `the one in ${project ?? 'this project'}`}, which does the same job. This copy is not used.`}
                  control={<RowValue className={styles.refused}>Shadowed</RowValue>}
                />
              ))}
            </Rows>
            <Note>{footnote(origin, snapshot)}</Note>
          </section>
        )
      })}
    </>
  )
}

/** One Agent in force, or one whose file will not parse. */
const AgentRow = ({ entry }: { readonly entry: AgentEntry }) => {
  const snapshot = useSnapshot()
  const definition = entry.definition
  if (!definition) {
    const problem = entry.problems.find((one) => one.level === 'error')
    return (
      <Row
        title={entry.id}
        desc={problem ? `${problem.at} — ${problem.text}` : 'Its file could not be read.'}
        control={<Chip state="broken" label="Will not parse" />}
      />
    )
  }
  const plan = snapshot.agentPlans.get(entry.id)
  const seat = seatTaken(plan)
  const reason = plan ? firstReason(plan) : null
  return (
    <Row
      title={definition.name}
      {...(definition.description ? { desc: definition.description } : {})}
      control={
        <span className={styles.facts}>
          <span title={ceilingMeaning(definition.permission)}>{ceilingWords(definition.permission)}</span>
          {seat ? (
            <span className={styles.seat}>
              <RuntimeMark runtime={markFor(seat, snapshot.runtimes)} size={12} />
              {seat.label}
            </span>
          ) : plan ? (
            <span className={styles.refused}>Can't seat here{reason ? ` · ${reason}` : ''}</span>
          ) : snapshot.agentPlansFailed ? (
            <span className={styles.refused}>Its seats could not be checked</span>
          ) : (
            <span>Checking seats…</span>
          )}
        </span>
      }
    />
  )
}
