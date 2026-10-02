import { useEffect, useRef, useState } from 'react'

import { runtimeId, type FlowPreview, type UsageReport } from '@harnessdesk/protocol'

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
import { libraryColumnsFor, LIBRARY, PREVIEW_AGENTS, PREVIEW_ROOM, PREVIEW_SESSION_KEY, previewStore, store } from './harness'
import { PREVIEW_ROOT, previewUsage } from './sidebar-fixture'
import { GEMINI_UNTRUSTED_PREVIEW, REVIEWER_REASONS_PREVIEW } from './flow-fixture'
import { ShellProvider } from '../panels/views'
import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import type { LayoutNode } from '../state/layout'
import { emptyWorkbench } from '../state/workbench'
import { Workbench } from '../panels/Workbench'

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
const noticeBase = store.getSnapshot()
const noticeWorkbench = (() => {
  const workbench = emptyWorkbench()
  return {
    ...workbench,
    main: {
      root: { kind: 'pane' as const, id: 'notice-pane', view: { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY } },
      focused: 'notice-pane',
      expanded: null,
    },
    right: {
      ...workbench.right,
      root: {
        kind: 'stack' as const,
        id: 'notice-overlay',
        views: [{ id: 'notice-overlay-view', view: { kind: 'activity' as const } }],
        active: 'notice-overlay-view',
      },
    },
  }
})()
const noticePace: UsageReport = {
  runtime: runtimeId('codex'),
  account: null,
  plan: null,
  lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 90, windowMinutes: 10_080, resetsAt: Date.now() + 3.5 * 24 * 60 * 60_000, usageKnown: true }],
  credits: null,
  spend: null,
  reached: null,
  source: { kind: 'api', label: 'from the preview fixture' },
  fetchedAt: Date.now(),
  staleAfterMs: 60_000,
  error: null,
}
const noticeLayoutStore = (id: string, options: {
  readonly view?: Extract<LayoutNode, { kind: 'pane' }>['view']
  readonly narrow?: boolean
  readonly zoom?: 'sidebar' | 'right' | 'bottom' | null
  readonly split?: boolean
  readonly splitBoardFocus?: boolean
  readonly folderGone?: boolean
  readonly stripSurface?: boolean
  readonly pendingRoomApproval?: boolean
  readonly narrowRoom?: boolean
} = {}) => {
  const paneId = `${id}-pane`
  const view = options.view ?? { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY }
  const second = options.split ? {
    kind: 'pane' as const,
    id: `${id}-other`,
    view: options.splitBoardFocus ? { kind: 'activity' as const } : { kind: 'conversation' as const, session: PREVIEW_SESSION_KEY },
  } : null
  const root = second ? {
    kind: 'split' as const, id: `${id}-split`, direction: 'row' as const, ratio: 0.5,
        first: { kind: 'pane' as const, id: paneId, view }, second,
  } : { kind: 'pane' as const, id: paneId, view }
  const workbench = {
    ...noticeWorkbench,
    main: { root, focused: second ? second.id : paneId, expanded: null },
    ...(options.zoom === 'sidebar' ? {
      sidebar: {
        ...noticeWorkbench.sidebar,
        root: { kind: 'stack' as const, id: `${id}-sidebar`, views: [{ id: `${id}-sidebar-view`, view: { kind: 'activity' as const } }], active: `${id}-sidebar-view` },
      },
    } : {}),
    ...(options.zoom === 'right' ? { zoom: { area: 'right' as const, scope: 'window' as const } } : {}),
    ...(options.zoom === 'sidebar' ? { zoom: { area: 'sidebar' as const, scope: 'window' as const } } : {}),
  }
  const active = noticeBase.sessions.get(PREVIEW_SESSION_KEY)!
  const approvalKey = noticeBase.teams.get(PREVIEW_ROOM)?.members[0] ?? PREVIEW_SESSION_KEY
  const result = previewStore({
    ...noticeBase,
    status: options.stripSurface ? 'reconnecting' : 'open',
    activeRuntime: runtimeId('codex'),
    activeSessionKey: PREVIEW_SESSION_KEY,
    account: null,
    accountsByRuntime: {},
    agentNotices: [],
    preferencesLoaded: true,
    noticePolicy: { muted: [], records: {}, seen: [], surfaces: {}, kept: [] },
    narrowWindow: options.narrow ?? false,
    usage: [noticePace],
    workbench,
    ...(options.pendingRoomApproval ? { approvals: [{ key: approvalKey, approval: { id: 'preview-room-approval', type: 'command', kind: 'shell', command: 'pnpm test', cwd: PREVIEW_ROOT } }] as never } : {}),
    layout: { ...noticeBase.layout, root, focused: second ? second.id : paneId, expanded: null },
    sessions: new Map([[PREVIEW_SESSION_KEY, active]]),
    ...(options.folderGone ? { foldersGone: new Map([[active.cwd, 'The preview folder is unavailable.']]) } : {}),
  } as never)
  if (options.narrow) result.setNarrowWindow(true)
  return result
}

const NoticeLayoutFrame = ({ id, title, options }: { readonly id: string; readonly title: string; readonly options?: Parameters<typeof noticeLayoutStore>[1] }) => (
  <Frame id={id} title={title}>
    <div data-testid="notice-layout-canvas" className="h-[620px] min-w-0 overflow-hidden border" style={options?.narrowRoom ? { width: '900px' } : undefined}>
      <StoreProvider store={noticeLayoutStore(id, options)}>
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <Workbench sidebar={<div className="p-2">Preview sidebar</div>} />
        </ShellProvider>
      </StoreProvider>
    </div>
  </Frame>
)
const DIALOGS = ['off', 'edit agent', 'prefer agent', 'handoff', 'confirm', 'worktree', 'import', 'resolve', 'plan', 'library flow', 'add agents'] as const
type Dialog = (typeof DIALOGS)[number]

const flowSceneStore = (preview: FlowPreview): AppStore => new Proxy(store, {
  get(target, property, receiver) {
    if (property === 'flowGeneration') return () => 0
    if (property === 'flowCatalog') return async () => [{ id: 'preview-state', origin: 'project', path: 'flow.yml', name: 'Preview flow', description: null, format: 'agents', problem: null, shadows: [] }]
    if (property === 'agentsIn') return async () => PREVIEW_AGENTS
    if (property === 'flowSource') return async () => 'version: 2\n'
    if (property === 'previewFlow') return async () => preview
    const value = Reflect.get(target, property, receiver)
    return typeof value === 'function' ? value.bind(target) : value
  },
}) as AppStore

const SelectedFlowPreview = ({ preview }: { readonly preview: FlowPreview }) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => {
      const select = host.current?.querySelector<HTMLSelectElement>('select')
      if (!select || select.disabled) return
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'preview-state')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      window.clearInterval(timer)
    }, 10)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <StoreProvider store={flowSceneStore(preview)}>
      <div ref={host} className="p-4"><FlowStart root={PREVIEW_ROOT} disabled={false} onChange={() => {}} /></div>
    </StoreProvider>
  )
}

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
      <Frame id="coverage-agent-fields" title="Agent — editable field sections">
        <div className="p-4"><AgentPageSections entry={entry}><StepNameScope items={[]} root={PREVIEW_ROOT}><PlanSteps todos={[{ label: 'Read the Agent file', done: true }, { label: 'Preview the saved edit', done: false }] as never} /></StepNameScope></AgentPageSections></div>
      </Frame>
      <Frame id="coverage-composer-controls" title="Composer — permission, mode and more controls">
        <div className="flex items-center gap-2 p-4"><PermissionControl /><ModeControl /><MoreControl /></div>
      </Frame>
      <Frame id="coverage-goal-flow" title="Goal — choose a flow">
        <div className="p-4"><FlowStart root={PREVIEW_ROOT} disabled={false} onChange={() => {}} /></div>
      </Frame>
      <Frame id="coverage-flow-review-reasons" title="Flow — reviewer candidate reasons and provider warning">
        <SelectedFlowPreview preview={REVIEWER_REASONS_PREVIEW} />
      </Frame>
      <Frame id="coverage-flow-gemini-trust" title="Flow — a seat that cannot use the board in this folder">
        <SelectedFlowPreview preview={GEMINI_UNTRUSTED_PREVIEW} />
      </Frame>
      <Frame id="coverage-session-background" title="Session — background work and deliverables">
        <StoreProvider store={coverageStore}><div className="p-4"><JobsBar /><Deliverables /></div></StoreProvider>
      </Frame>
      <Frame id="coverage-row-alerts" title="Rows — usage and worktree alerts">
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
      <Frame id="coverage-publication" title="Publication — a reviewable pull request">
        <div className="p-4"><Publication root={PREVIEW_ROOT} item={{ reference: { kind: 'pullRequest', repo: 'acme/storefront', number: 42, url: 'https://example.com/acme/storefront/pull/42', state: 'open', title: 'Keep preview coverage honest', author: 'Jane Doe', files: 2, additions: 14, deletions: 3, excerpt: 'Adds coverage fixtures.' } } as never} /></div>
      </Frame>
      <Frame id="coverage-notices" title="Notices — strip, inbox and toast">
        <StoreProvider store={coverageStore}>
          <div className="p-4"><Notices /><NoticeStripOutlet host /><SidebarNotices /></div>
        </StoreProvider>
      </Frame>
      <NoticeLayoutFrame id="coverage-notice-narrow-overlay" title="Notice placement — narrow window overlay" options={{ narrow: true }} />
      <NoticeLayoutFrame id="coverage-notice-room-board" title="Notice placement — room board without a composer" options={{ view: { kind: 'room', room: PREVIEW_ROOM } as never }} />
      <NoticeLayoutFrame id="coverage-notice-room-pending-approval" title="Notice placement — room composer hidden by an approval" options={{ view: { kind: 'room', room: PREVIEW_ROOM } as never, pendingRoomApproval: true }} />
      <NoticeLayoutFrame id="coverage-notice-room-container-query" title="Notice placement — narrow room rail hides its body" options={{ view: { kind: 'room', room: PREVIEW_ROOM } as never, stripSurface: true, narrowRoom: true }} />
      <NoticeLayoutFrame id="coverage-notice-folder-gone" title="Notice placement — folder-gone conversation" options={{ folderGone: true }} />
      <NoticeLayoutFrame id="coverage-notice-zoomed-sidebar" title="Notice placement — zoomed sidebar" options={{ zoom: 'sidebar' }} />
      <NoticeLayoutFrame id="coverage-notice-zoomed-dock" title="Notice placement — zoomed dock" options={{ zoom: 'right' }} />
      <NoticeLayoutFrame id="coverage-notice-split-composers" title="Notice placement — split with two composers" options={{ split: true }} />
      <NoticeLayoutFrame id="coverage-notice-split-unfocused-composer" title="Notice placement — visible composer beside focused activity" options={{ split: true, splitBoardFocus: true }} />
      <NoticeLayoutFrame id="coverage-notice-composer-strip" title="Notice placement — dropped link above the composer" options={{ stripSurface: true }} />
      <NoticeLayoutFrame id="coverage-notice-pane-bar-strip" title="Notice placement — dropped link below a tool pane bar" options={{ view: { kind: 'activity' as const } as never, stripSurface: true }} />
      <Frame id="coverage-library" title="Library — changes made from here">
        <div className="p-4"><LibraryHistory refreshedAt={0} home="/home/u" onFlow={() => {}} /></div>
      </Frame>
      <Frame id="coverage-panel-actions" title="Panel actions context">
        <ShellProvider actions={{ chooseProject: () => {}, signIn: () => {}, openUsage: () => {}, openRuntimes: () => {}, openAgents: () => {}, reviewImports: () => {} }}>
          <div className="p-4">Panel actions are available here.</div>
        </ShellProvider>
      </Frame>
    </>
  )
}
