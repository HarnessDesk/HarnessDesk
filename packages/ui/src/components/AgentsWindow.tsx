import { useEffect } from 'react'

import type { AgentEntry } from '@harnessdesk/protocol'

import { agentName, bySection, firstReason, originWords, projectName, seatTaken } from '../lib/agents'
import { useSnapshot, useStore } from '../state/context'
import { AppWindow, WindowGroup, WindowNav, WindowNavItem, WindowNavStateMark, WindowPage } from './AppWindow'
import { BriefIcon } from './Icons'
import { Dot } from '../design'
import { AgentsRosterSection } from './AgentRoster'

/**
 * The Agents window — the owner's left-menu decision: the roster lives in its
 * own top-level screen, in the same full-window shell Settings and Usage
 * share, never inside Settings.
 *
 * The rail is the roster: *All Agents* first (the overview, `focus === null`),
 * then the three sections precedence reads in, one row per Agent in force. A
 * row that cannot be seated here wears a state mark. `AgentsRosterSection`
 * owns whether the page shows the overview or a selected Agent's own page —
 * `focus` only tells it where to start, and `onFocus` is how a row pressed
 * there (or *Back*) keeps this rail's own selection in step.
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
      <WindowPage>
        <AgentsRosterSection focus={focus} onLeave={onClose} onFocus={onFocus} />
      </WindowPage>
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
