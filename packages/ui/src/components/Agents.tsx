import { Fragment, useEffect, useMemo } from 'react'

import { allItems, type Session, type SessionId } from '@harnessdesk/protocol'

import { defaultTint } from '../lib/accounts'
import { PHASE_WORDS, type ChildPhase, type ChildRow } from '../lib/subagent-flow'
import { useActiveSession, useStore } from '../state/context'
import type { ReportFoot } from './Details'
import { AgentIcon } from './Icons'
import { IconTile } from '../design'
import { GroupLine, PanelEmpty, PanelRow, RunDot } from './Panel'
import { childFacts, SubagentLanes, useChildren, useNow } from './SubagentFlow'

/**
 * Every sub-agent this session started, in one place.
 *
 * Nested runs appear inline where they happened, but by the time there are
 * several the transcript is the wrong place to answer "which agents are
 * running and what did I ask them". This is that answer.
 *
 * A sub-agent wears the robot with its delegation badge, tinted in a colour of its own, so three runs of the same agent are
 * three rows you can tell apart at a glance rather than three identical
 * glyphs.
 */

export const hasSessionAgents = (session: Session | null): boolean => Boolean(session && allItems(session).some(item => item.type === 'subagent' && item.members.length > 0))

/** Working first, then failures that want a look, then the rest. */
const GROUPS: readonly { readonly label: string; readonly phases: readonly ChildPhase[] }[] = [
  { label: 'Working', phases: ['working'] },
  { label: 'Failed', phases: ['failed'] },
  { label: 'Finished', phases: ['done', 'stopped', 'ended'] },
]

export const Agents = ({ query, onFoot }: { query: string; onFoot: ReportFoot }) => {
  const store = useStore()
  const session = useActiveSession()
  const agents = useChildren(session)
  const now = useNow(agents.some(agent => agent.phase === 'working'))

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      needle.length === 0
        ? agents
        : agents.filter(
            (agent) =>
              agent.name.toLowerCase().includes(needle) ||
              (agent.prompt ?? '').toLowerCase().includes(needle) ||
              (agent.role ?? '').toLowerCase().includes(needle),
          ),
    [agents, needle],
  )

  const running = agents.filter((agent) => agent.phase === 'working').length
  const open = (agent: ChildRow) => {
    // A sub-agent runs under the agent that started it, so this session's
    // runtime is the one that can read it. Without that, the id goes to
    // whichever agent happens to be active.
    if (session) void store.openSession(agent.id as SessionId, { runtime: session.runtime })
  }

  useEffect(() => {
    onFoot(
      agents.length === 0 ? '' : running > 0 ? `${running} running` : `${agents.length} started`,
      agents.length > 0 ? `${agents.length} in this session` : '',
    )
  }, [running, agents.length, onFoot])

  if (agents.length === 0) {
    return (
      <PanelEmpty>
        This session has not delegated to any sub-agents. When it does, they appear here
        with what they were asked and how they are doing.
      </PanelEmpty>
    )
  }

  if (shown.length === 0) return <PanelEmpty>No sub-agents match that filter.</PanelEmpty>

  const groups = GROUPS.map(group => ({ ...group, rows: shown.filter(agent => group.phases.includes(agent.phase)) })).filter(group => group.rows.length > 0)

  return (
    <>
      {needle.length === 0 && <SubagentLanes onPick={open} />}
      {groups.map(group => (
        <Fragment key={group.label}>
          {groups.length > 1 && <GroupLine left={`${group.label} · ${group.rows.length}`} />}
          {group.rows.map((agent) => (
            <PanelRow
              key={agent.id}
              mark={
                <IconTile size="sm" shape="face" tint={defaultTint(agent.id)} badge="↳" title={`Sub-agent of ${session?.title || 'this conversation'}`}>
                  <AgentIcon size={12} />
                </IconTile>
              }
              title={
                <>
                  {agent.name}
                  {agent.phase === 'working' && <RunDot />}
                </>
              }
              {...(agent.prompt ? { ask: agent.prompt } : {})}
              meta={[
                agent.phase === 'working' ? null : PHASE_WORDS[agent.phase],
                // Codex names a child's role; the ACP extension puts the
                // asked-for model here when it differs from what actually ran.
                // Both are the same slot: what this child was meant to be.
                agent.role,
                // Model, time and tokens. Tokens are absent rather than zeroed
                // for the runtimes that cannot attribute spend to a child: a
                // sub-agent shown as having spent nothing is a claim, and one
                // that is usually false.
                childFacts(agent, now) || null,
              ]
                .filter(Boolean)
                .join(' · ')}
              // A child with a conversation of its own opens; one that ran
              // inside this session has none, and gets a row rather than a
              // press that fails. Codex gives its children threads; Claude
              // Code does not.
              {...(agent.openable
                ? { tooltip: [`Open ${agent.id}`, agent.prompt].filter(Boolean).join('\n\n'), onClick: () => open(agent) }
                : { tooltip: ['Ran inside this conversation; it has none of its own to open.', agent.prompt].filter(Boolean).join('\n\n') })}
            />
          ))}
        </Fragment>
      ))}
    </>
  )
}
