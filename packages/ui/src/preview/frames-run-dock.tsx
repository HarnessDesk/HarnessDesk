import { useMemo } from 'react'
import type { BoardEvidence, Evidence } from '@harnessdesk/protocol'
import { Sidebar } from '../components/Sidebar'
import { Workbench } from '../panels/Workbench'
import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'
import { emptyWorkbench } from '../state/workbench'
import { previewStore } from './harness'
import { runFixture, runTeamStore } from './run-view-fixture'

/** A synthetic Team in the real workbench, including the panel's own controls. */
export const runDockStore = (older = false) => {
  const source = runTeamStore('running')
  const fixture = runFixture()
  const execution = { ...fixture.execution,
    base: older ? undefined : { remote: 'origin', branch: 'main', at: 'abc123' },
    findings: older ? undefined : { version: 1 as const, budget: { rounds: 24, withoutProgress: 3 }, closedRounds: [1, 2, 3], idleRounds: 1,
      progress: [], series: [], stopped: null, extraRound: null, overrides: [], lastDecision: null },
  }
  const snapshot = source.getSnapshot()
  const goal = snapshot.goals.get(execution.goal)!
  const workbench = { ...emptyWorkbench(), main: { root: { kind: 'pane' as const, id: 'dock-team', view: { kind: 'room' as const, room: execution.goal } }, focused: 'dock-team', expanded: null } }
  const facts: Evidence[] = [{ kind: 'pr', number: 412, head: 'abc123', state: 'open', url: 'https://example.com/pull/412' },
    { kind: 'ci', at: 'abc123', checks: [{ name: 'Verify', state: 'failed', url: null }, { name: 'Build', state: 'passed', url: null }] },
    { kind: 'diff', files: 3, added: 177, removed: 82, from: 'base123', to: 'abc123' }]
  const evidence: BoardEvidence = { ...fixture.evidence, cards: [...fixture.evidence.cards, { card: 1, running: [], facts: facts.map((fact, n) => ({
    by: null, freshness: { state: 'fresh' as const }, record: { id: `dock-fact-${n}`, observedAt: Date.now(), round: 1, fact,
      checkout: { root: '/work/storefront', cwd: '/work/storefront', branch: 'fix/checkout-502', commonDir: '/work/storefront/.git', head: 'abc123' } },
  })) }] }
  const own = previewStore({ ...snapshot, workbench, layout: workbench.main, sidebarCollapsed: true,
    flowExecutions: new Map([[execution.id, execution]]), boardEvidence: new Map([[execution.goal, evidence]]),
    goals: new Map([[execution.goal, { ...goal, members: older ? [] : goal.members.map((seat, n) => ({ ...seat, seatLabel: n ? 'Careful · High' : 'Balanced · Medium' })) }]]),
  })
  return new Proxy(own, { get(target, key) {
    if (key === 'flowCatalog' || key === 'flowSource' || key === 'readGoalInsight' || key === 'teamPeers') return Reflect.get(source, key)
    if (key === 'loadTeamRuns' || key === 'loadBoardEvidence' || key === 'loadFindings' || key === 'loadFindingRun') return async () => {}
    return Reflect.get(target, key)
  } })
}
export const RunDockFrame = ({ older = false }: { older?: boolean }) => {
  const store = useMemo(() => runDockStore(older), [older])
  return <StoreProvider store={store}><ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
    <div id="run-dock-frame" className="h-screen bg-background">
      <Workbench sidebar={<Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />} />
    </div>
  </ShellProvider></StoreProvider>
}
