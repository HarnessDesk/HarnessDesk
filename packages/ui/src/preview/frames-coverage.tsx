import { useState } from 'react'

import { runtimeId } from '@harnessdesk/protocol'

import { AgentPageSections, FieldEditDialog, PreferFieldDialog } from '../components/AgentFields'
import { HandoffSheet, ModeControl, MoreControl, PermissionControl } from '../components/ComposerControls'
import { FlowStart } from '../components/FlowStart'
import { TroubleNote } from '../components/GitAskAgent'
import { ConfirmDialog } from '../components/GitDialogs'
import { AddWorktreeDialog } from '../components/GitWorktrees'
import { PlanSteps, StepNameScope } from '../components/Items'
import { ImportDialog, LibraryFlows, LibraryHistory, PlanDialog, ResolveDialog } from '../components/LibraryActions'
import { Notices, NoticeStripOutlet, SidebarNotices } from '../components/Notices'
import { Publication } from '../components/Publication'
import { Deliverables, JobsBar } from '../components/SessionBars'
import { AddAgents, PlanSection, UsageMeter, UsageSection } from '../components/SettingsAgents'
import { AsleepAlert, Runway } from '../components/usage/shared'
import { UncommittedFiles, WorktreeProblem } from '../components/WorktreeAlerts'
import { Boundary } from './boundary'
import { Dial, Frame } from './main'
import { libraryColumnsFor, LIBRARY, PREVIEW_AGENTS, PREVIEW_SESSION_KEY, previewStore, store } from './harness'
import { PREVIEW_ROOT, previewUsage } from './sidebar-fixture'
import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'

const COLUMNS = libraryColumnsFor(LIBRARY.runtimes)
const base = store.getSnapshot()
const active = base.sessions.get(PREVIEW_SESSION_KEY)!
const coverageStore = previewStore({
  ...base,
  status: 'reconnecting',
  goalMigrationPending: true,
  notices: [{ id: 'coverage-toast', level: 'warning', message: 'Preview notice fixture', action: null }] as never,
  sessions: new Map([[PREVIEW_SESSION_KEY, {
    ...active,
    turns: [...active.turns, { status: 'inProgress', items: [{ id: 'coverage-command', type: 'command', status: 'inProgress', command: 'pnpm verify', startedAt: Date.now() - 12_000, actions: [] }] }],
  } as never]]),
})
const DIALOGS = ['off', 'edit agent', 'prefer agent', 'handoff', 'confirm', 'worktree', 'import', 'resolve', 'plan', 'library flow', 'add agents'] as const
type Dialog = (typeof DIALOGS)[number]

/**
 * State-gated exports get a truthful fixture here rather than a file-wide
 * pass from a sibling. Dialogs begin closed and the coverage test sweeps the
 * same dial a person uses, so the ordinary preview remains a useful screen.
 */
export const CoverageFrames = () => {
  const [dialog, setDialog] = useState<Dialog>('off')
  const entry = PREVIEW_AGENTS[0]!
  const target = { kind: 'agent', origin: 'project', id: entry.id } as const
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="coverage state" value={dialog} options={DIALOGS} onChange={setDialog} />
      </div>
      <Boundary>
        {dialog === 'edit agent' && <FieldEditDialog fieldKey="ceiling" target={target} digest={entry.digest ?? 'preview-agent'} initial="read" onOpenFile={() => {}} onClose={() => setDialog('off')} onSaved={() => setDialog('off')} />}
        {dialog === 'prefer agent' && <PreferFieldDialog entry={entry} target={target} digest={entry.digest ?? 'preview-agent'} initial={entry.definition?.prefer ?? []} onOpenFile={() => {}} onClose={() => setDialog('off')} onSaved={() => setDialog('off')} />}
        {dialog === 'handoff' && <HandoffSheet from="Alpha" to="Beta" onCancel={() => setDialog('off')} onConfirm={() => setDialog('off')} />}
        {dialog === 'confirm' && <ConfirmDialog title="Confirm this change" body="Review the change before continuing." confirmLabel="Continue" act={async () => null} onDone={() => setDialog('off')} />}
        {dialog === 'worktree' && <AddWorktreeDialog root={PREVIEW_ROOT} refs={null} onDone={() => setDialog('off')} />}
        {dialog === 'import' && <ImportDialog library={LIBRARY as never} columns={COLUMNS} onClose={() => setDialog('off')} onPlan={() => setDialog('plan')} />}
        {dialog === 'resolve' && <ResolveDialog entry={LIBRARY.entries[0]! as never} columns={COLUMNS} onClose={() => setDialog('off')} onPlan={() => setDialog('plan')} />}
        {dialog === 'plan' && <PlanDialog title="Preview library change" intents={[]} columns={COLUMNS} cwd={PREVIEW_ROOT} onClose={() => setDialog('off')} onApplied={() => setDialog('off')} />}
        {dialog === 'library flow' && <LibraryFlows flow={{ type: 'import' }} setFlow={() => setDialog('off')} library={LIBRARY as never} columns={COLUMNS} cwd={PREVIEW_ROOT} onApplied={() => setDialog('off')} />}
        {dialog === 'add agents' && <AddAgents onBack={() => setDialog('off')} onDone={() => setDialog('off')} />}
      </Boundary>
      <Frame title="Agent — editable field sections">
        <div className="p-4"><AgentPageSections entry={entry}><StepNameScope items={[]} root={PREVIEW_ROOT}><PlanSteps todos={[{ label: 'Read the Agent file', done: true }, { label: 'Preview the saved edit', done: false }] as never} /></StepNameScope></AgentPageSections></div>
      </Frame>
      <Frame title="Composer — permission, mode and more controls">
        <div className="flex items-center gap-2 p-4"><PermissionControl /><ModeControl /><MoreControl /></div>
      </Frame>
      <Frame title="Goal — choose a flow">
        <div className="p-4"><FlowStart root={PREVIEW_ROOT} disabled={false} onChange={() => {}} /></div>
      </Frame>
      <Frame title="Session — background work and deliverables">
        <StoreProvider store={coverageStore}><div className="p-4"><JobsBar /><Deliverables /></div></StoreProvider>
      </Frame>
      <Frame title="Rows — usage and worktree alerts">
        <div className="p-4">
          <UsageSection limits={null} name="Preview" />
          <UsageMeter window={{ label: 'Weekly', usedPercent: 50, windowMinutes: 10_080, resetsAt: Date.now() + 3_600_000 }} />
          <PlanSection runtime={previewUsage[0]!.runtime} account={previewUsage[0]!.account!} report={previewUsage[0]} isKey />
          <Runway reports={previewUsage} now={Date.now()} accountsByRuntime={{}} accountPrefs={{}} />
          <AsleepAlert silent={{ info: { id: runtimeId('cursor'), presentation: { name: 'Gamma' } }, reason: 'Its usage file has not appeared yet.' } as never} />
          <UncommittedFiles changes={{ files: ['src/example.ts'] } as never} title="Uncommitted changes">Commit or stash these files first.</UncommittedFiles>
          <WorktreeProblem>This checkout could not be updated.</WorktreeProblem>
          <TroubleNote message="This checkout needs attention." trouble={null} onAsk={() => {}} />
        </div>
      </Frame>
      <Frame title="Publication — a reviewable pull request">
        <div className="p-4"><Publication root={PREVIEW_ROOT} item={{ reference: { kind: 'pullRequest', repo: 'acme/storefront', number: 42, url: 'https://example.com/acme/storefront/pull/42', state: 'open', title: 'Keep preview coverage honest', author: 'Jane Doe', files: 2, additions: 14, deletions: 3, excerpt: 'Adds coverage fixtures.' } } as never} /></div>
      </Frame>
      <Frame title="Notices — strip, inbox and toast">
        <StoreProvider store={coverageStore}>
          <div className="p-4"><Notices /><NoticeStripOutlet host /><SidebarNotices /></div>
        </StoreProvider>
      </Frame>
      <Frame title="Library — changes made from here">
        <div className="p-4"><LibraryHistory refreshedAt={0} home="/home/u" onFlow={() => {}} /></div>
      </Frame>
      <Frame title="Panel actions context">
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <div className="p-4">Panel actions are available here.</div>
        </ShellProvider>
      </Frame>
    </>
  )
}
