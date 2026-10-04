import { approvalId, runtimeId, sessionKey, sessionId, turnId, type SessionId } from '@harnessdesk/protocol'

import type { AppSnapshot } from '../state/store'
import { PREVIEW_ROOM } from './harness'
import { PREVIEW_GOAL } from './goal-fixture'
import { PREVIEW_ROOT, previewHistory, previewSession } from './sidebar-fixture'

/** Real rows for the sidebar geometry board and the narrow-window fixture. */
const sidebarNeedApproval = (id: string) => ({
  id: approvalId(`sidebar-row-approval-${id}`),
  sessionId: sessionId(id),
  type: 'command',
  kind: 'command',
  command: 'pnpm test',
  cwd: PREVIEW_ROOT,
  requestedAt: Date.now(),
  reason: 'The row geometry fixture is waiting for review.',
  actions: [{ type: 'unknown', command: 'pnpm test' }],
  options: [
    { id: 'allow', label: 'Allow', intent: 'approve' },
    { id: 'deny', label: 'Deny', intent: 'deny' },
  ],
} as const)
export const sidebarGeometryFixture = (sidebarSnapshot: AppSnapshot): AppSnapshot => ({
  ...sidebarSnapshot,
  history: sidebarSnapshot.history.map((entry) => ['s0', 's1', 's2'].includes(entry.id) && entry.runtime === runtimeId('codex')
    ? { ...entry, status: { type: 'active' } }
    : entry),
  listPrefs: {
    ...sidebarSnapshot.listPrefs,
    pinned: [PREVIEW_ROOT],
    // A gone-folder conversation remains visible when pinned; keep its rail case.
    pinnedSessions: [String(sessionKey(runtimeId('codex'), 's2' as SessionId))],
    collapsed: ['/work/harnessdesk-mobile'],
  },
  approvals: ['s0', 'c1'].map((id) => ({
    key: sessionKey(runtimeId('codex'), id as SessionId),
    approval: sidebarNeedApproval(id),
  })) as AppSnapshot['approvals'],
  sessions: new Map(sidebarSnapshot.sessions).set(
    sessionKey(runtimeId('codex'), 's0' as SessionId),
    {
      ...previewSession,
      id: 's0' as SessionId,
      title: previewHistory[0]!.title,
      cwd: previewHistory[0]!.cwd,
      status: { type: 'active' },
      git: previewHistory[0]!.git,
    } as never,
  ).set(sessionKey(runtimeId('codex'), 's2' as SessionId), { ...previewSession, ...previewHistory[2]!, id: 's2' as SessionId, status: { type: 'active' }, turns: [{ id: turnId('sidebar-working'), status: 'inProgress', items: [] }] } as never)
    .set(sessionKey(runtimeId('codex'), 's1' as SessionId), { ...previewSession, ...previewHistory[1]!, id: 's1' as SessionId, status: { type: 'active' }, turns: [{ id: turnId('sidebar-working'), status: 'inProgress', items: [] }] } as never),
  goals: new Map([
    ...sidebarSnapshot.goals,
    [PREVIEW_ROOM, { ...PREVIEW_GOAL, goal: { ...PREVIEW_GOAL.goal, id: PREVIEW_ROOM } }],
  ]),
  teams: new Map(sidebarSnapshot.teams).set('goal-working', {
    ...sidebarSnapshot.teams.get('goal-working')!,
    members: sidebarSnapshot.teams.get(PREVIEW_ROOM)!.members.slice(1),
    channel: sidebarSnapshot.teams.get(PREVIEW_ROOM)!.channel.filter((entry) => entry.kind === 'message' && entry.state === 'held'),
  }),
  foldersGone: new Map([
    [previewHistory[2]!.cwd, 'This worktree folder is no longer available.'],
    ['/work/harnessdesk-site', 'This project folder is no longer available.'],
  ]),
})
