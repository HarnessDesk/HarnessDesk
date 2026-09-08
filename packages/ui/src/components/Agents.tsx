import { useEffect, useMemo } from 'react'

import { allItems, type SessionId, type SubagentItem, type TokenUsage } from '@harnessdesk/protocol'

import { defaultTint } from '../lib/accounts'
import { formatTokensWithFloor } from '../lib/context-usage'
import { useActiveSession, useSnapshot, useStore } from '../state/context'
import type { ReportFoot } from './Details'
import { RuntimeMark } from './BrandIcons'
import { AgentIcon } from './Icons'
import { kit } from '../design/primitives/Kit'
import { PanelEmpty, PanelRow, RunDot } from './Panel'

/**
 * Every sub-agent this session started, in one place.
 *
 * Nested runs appear inline where they happened, but by the time there are
 * several the transcript is the wrong place to answer "which agents are
 * running and what did I ask them". This is that answer.
 *
 * A sub-agent wears the mark of the runtime that started it — that is what it
 * is — ringed in a colour of its own, so three runs of the same agent are
 * three rows you can tell apart at a glance rather than three identical
 * glyphs.
 */

interface Entry {
  readonly sessionId: string
  readonly nickname: string
  readonly role: string | null
  readonly state: string | null
  readonly prompt: string | null
  readonly model: string | null
  /** What this child spent, where the runtime attributes it. Null otherwise. */
  readonly usage: TokenUsage | null
  /** False where the child's id is a handle rather than a conversation. */
  readonly openable: boolean
}

const RUNNING = new Set(['running', 'active', 'started', 'working'])

export const Agents = ({ query, onFoot }: { query: string; onFoot: ReportFoot }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const session = useActiveSession()
  const info = snapshot.runtimes.find((entry) => entry.id === session?.runtime) ?? null

  const agents = useMemo(() => {
    if (!session) return []
    const byId = new Map<string, Entry>()
    for (const item of allItems(session)) {
      if (item.type !== 'subagent') continue
      const call = item as SubagentItem
      for (const member of call.members) {
        // Later calls carry fresher state, so a repeat overwrites rather than
        // duplicating the same agent.
        const before = byId.get(member.sessionId)
        byId.set(member.sessionId, {
          sessionId: member.sessionId,
          nickname: member.nickname ?? member.sessionId.slice(0, 8),
          role: member.role ?? null,
          state: member.state ?? null,
          prompt: call.prompt ?? before?.prompt ?? null,
          // The child's own model where the runtime names one per child, and
          // the call's otherwise. All three runtimes now let one delegation
          // address children on different models, so the call's model is a
          // default and not the answer.
          model: member.model ?? call.model ?? before?.model ?? null,
          usage: member.usage ?? call.usage ?? before?.usage ?? null,
          openable: member.openable !== false,
        })
      }
    }
    return [...byId.values()]
  }, [session])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      needle.length === 0
        ? agents
        : agents.filter(
            (agent) =>
              agent.nickname.toLowerCase().includes(needle) ||
              (agent.prompt ?? '').toLowerCase().includes(needle) ||
              (agent.role ?? '').toLowerCase().includes(needle),
          ),
    [agents, needle],
  )

  const running = agents.filter((agent) => RUNNING.has(agent.state ?? '')).length

  useEffect(() => {
    onFoot(
      running > 0 ? `${running} running` : `${agents.length} started`,
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

  return (
    <>
      {shown.map((agent) => (
        <PanelRow
          key={agent.sessionId}
          mark={
            <span
              className={`${kit.avatar} ${kit.avatarSm}`}
              data-tint={defaultTint(agent.sessionId)}
            >
              {info ? <RuntimeMark runtime={info} size={12} /> : <AgentIcon size={12} />}
            </span>
          }
          title={
            <>
              {agent.nickname}
              {RUNNING.has(agent.state ?? '') && <RunDot />}
            </>
          }
          {...(agent.prompt ? { ask: agent.prompt } : {})}
          meta={[
            agent.state,
            // Codex names a child's role; the ACP extension puts the asked-for
            // model here when it differs from what actually ran. Both are the
            // same slot: what this child was meant to be.
            agent.role,
            agent.model,
            // What it cost, where the runtime attributes spend to a child.
            // Absent rather than zeroed for the runtimes that cannot: a
            // sub-agent shown as having spent nothing is a claim, and one
            // that is usually false.
            agent.usage && agent.usage.totalTokens > 0 ? `${formatTokensWithFloor(agent.usage)} tokens` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          // A child with a conversation of its own opens; one that ran inside
          // this session has none, and gets a row rather than a press that
          // fails. Codex gives its children threads; Claude Code does not.
          {...(agent.openable
            ? {
                tooltip: `Open ${agent.sessionId}`,
                // A sub-agent runs under the agent that started it, so this
                // session's runtime is the one that can read it. Without that,
                // the id goes to whichever agent happens to be active.
                onClick: () => {
                  if (session) void store.openSession(agent.sessionId as SessionId, { runtime: session.runtime })
                },
              }
            : { tooltip: 'Ran inside this conversation; it has none of its own to open.' })}
        />
      ))}
    </>
  )
}
