import { useEffect } from 'react'

import type { AgentEntry } from '@harnessdesk/protocol'

import { agentName, bySection, firstReason, originWords, projectName, seatTaken } from '../lib/agents'
import { useSnapshot, useStore } from '../state/context'
import { AppWindow, WindowGroup, WindowNav, WindowNavItem, WindowNavStateMark, WindowPage } from './AppWindow'
import { BriefIcon } from './Icons'
import { Dot, PageHead } from '../design'
import { AgentsRosterSection } from './AgentRoster'

/**
 * The Agents window — the owner's left-menu decision: the roster lives in its
 * own top-level screen, in the same full-window shell Settings and Usage
 * share, never inside Settings.
 *
 * The rail is the roster: *All Agents* first (the overview, `focus === null`),
 * then the three sections precedence reads in, one row per Agent in force. A
 * row that cannot be seated here wears a state mark; Task 15 fills in what a
 * selected row's own page says.
 */
export const AgentsWindow = ({
  focus,
  onClose,
  onFocus,
}: {
  /** The selected Agent's id, or null for the overview. Owned by the caller, like Settings' `section`. */
  readonly focus: string | null
  readonly onClose: () => void
  readonly onFocus: (id: string | null) => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()

  // Read once, here, for every page this window ever shows: the overview and
  // (from Task 15) a selected Agent's own page both read the same copy
  // rather than each asking again.
  useEffect(() => {
    void store.loadAgents()
  }, [store])

  const agents = snapshot.agents ?? []
  const project = projectName(snapshot.workspace)
  const sections = bySection(agents)
  const selected = focus ? (agents.find((one) => one.id === focus) ?? null) : null

  return (
    <AppWindow label="Agents">
      <WindowNav onBack={onClose}>
        <WindowNavItem
          icon={<BriefIcon size={14} />}
          label="All Agents"
          selected={focus === null}
          onClick={() => onFocus(null)}
        />
        {(['project', 'user', 'builtin'] as const)
          .filter((origin) => origin !== 'project' || snapshot.workspace !== null)
          .map((origin) => {
            const rows = sections[origin]
            if (rows.length === 0) return null
            return (
              <WindowGroup key={origin} label={originWords(origin, project)}>
                {rows.map((entry) => (
                  <AgentNavRow key={entry.id} entry={entry} selected={focus === entry.id} onClick={() => onFocus(entry.id)} />
                ))}
              </WindowGroup>
            )
          })}
      </WindowNav>
      <WindowPage>{selected ? <AgentPagePlaceholder entry={selected} /> : <AgentsRosterSection />}</WindowPage>
    </AppWindow>
  )
}

/** One Agent's row in the rail: a state mark when it cannot be seated here. */
const AgentNavRow = ({
  entry,
  selected,
  onClick,
}: {
  readonly entry: AgentEntry
  readonly selected: boolean
  readonly onClick: () => void
}) => {
  const snapshot = useSnapshot()
  const broken = !entry.definition
  const plan = snapshot.agentPlans.get(entry.id)
  const refused = !broken && plan !== undefined && seatTaken(plan) === null
  const reason = refused ? firstReason(plan!) : null
  return (
    <WindowNavItem
      icon={<BriefIcon size={14} />}
      label={agentName(entry)}
      selected={selected}
      onClick={onClick}
      {...(broken
        ? { trail: <WindowNavStateMark><Dot state="broken" /></WindowNavStateMark> }
        : refused
          ? {
              trail: (
                <WindowNavStateMark>
                  <span title={reason ?? undefined}>
                    <Dot state="signin" />
                  </span>
                </WindowNavStateMark>
              ),
            }
          : {})}
    />
  )
}

/** A selected Agent's page — a placeholder naming it, until Task 15 builds the real one. */
const AgentPagePlaceholder = ({ entry }: { readonly entry: AgentEntry }) => (
  <PageHead
    title={agentName(entry)}
    blurb={entry.definition?.description ?? 'Its page — what it is for, its files and its seats — is next.'}
  />
)
