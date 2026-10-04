import { useMemo } from 'react'
import { approvalId, sessionId, sessionKey, turnId, type Session, type SessionSummary, type TeamState } from '@harnessdesk/protocol'
import { SessionTree } from '../components/SessionTree'
import { RailSection } from '../design'
import { StoreProvider } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { previewStore, store } from './harness'
import { previewSession } from './sidebar-fixture'

/** One public fixture for the project / Team / Seat hierarchy and row states. */
export const sidebarStructureFixture = (seed: AppSnapshot): AppSnapshot => {
  const roots = ['/work/atlas', '/work/beacon', '/work/compass']
  const history: SessionSummary[] = ['Writer', 'Reviewer', 'Tester', 'Release notes', 'Check build', 'Update guide', 'Pinned plan', 'Runner'].map((title, index) => ({
    id: sessionId(`structure-${index}`), runtime: previewSession.runtime, title, preview: null,
    cwd: roots[index < 5 ? 0 : index === 5 || index === 7 ? 1 : 2]!, status: { type: index === 0 || index === 4 || index === 7 ? 'active' : 'idle' },
    createdAt: 1, updatedAt: 100 - index, git: null, repo: null,
  }))
  const sessions = new Map(history.map((summary, index) => [sessionKey(summary.runtime, summary.id), {
    ...previewSession, ...summary, turns: index === 0 || index === 4 || index === 7
      ? [{ id: turnId(`structure-turn-${index}`), status: 'inProgress', items: [] }] : [],
  } as Session]))
  const team: TeamState = {
    id: 'structure-team', name: 'Ship checkout retry', root: roots[0]!, updatedAt: 101,
    members: history.slice(0, 3).map(one => sessionKey(one.runtime, one.id)),
    intents: [], channel: [], messaging: true,
  }
  return { ...seed, workspace: { path: roots[0]!, name: 'atlas', lastOpenedAt: 1 },
    workspaces: roots.map(path => ({ path, name: path.split('/').at(-1)!, lastOpenedAt: 1 })),
    history, sessions, activeSessionKey: null, teams: new Map([[team.id, team], ['structure-running-team', { ...team, id: 'structure-running-team', name: 'Check release notes', root: roots[1]!, members: [sessionKey(history[7]!.runtime, history[7]!.id)] }]]), goals: new Map(), flowExecutions: new Map(),
    foldersGone: new Map(), tasks: new Map(), queues: new Map(), inbox: [],
    approvals: [{ key: sessionKey(history[1]!.runtime, history[1]!.id), approval: {
      id: approvalId('structure-approval'), sessionId: history[1]!.id, type: 'command', command: 'pnpm test',
      cwd: roots[0]!, requestedAt: 1,
    } } as AppSnapshot['approvals'][number]],
    listPrefs: { ...seed.listPrefs, pinned: roots.slice(0, 2), pinnedSessions: [String(sessionKey(history[6]!.runtime, history[6]!.id))], collapsed: [], othersOpen: true },
  }
}

export const SidebarStructureExample = () => {
  const fixture = useMemo(() => previewStore(sidebarStructureFixture(store.getSnapshot())), [])
  return <section id="sidebar-structure" className="w-80 bg-sidebar py-4">
    <StoreProvider store={fixture}><RailSection stretch="list"><SessionTree now={1000} /></RailSection></StoreProvider>
  </section>
}
