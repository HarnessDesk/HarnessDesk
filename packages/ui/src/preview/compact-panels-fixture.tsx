import { itemId } from '@harnessdesk/protocol'
import type { BackgroundTask, SeatAttachmentsRecord, SeatId, SubagentItem } from '@harnessdesk/protocol'

import { BackgroundTasksView } from '../components/BackgroundTasks'
import { ProjectChecksView } from '../components/ProjectChecks'
import { SeatAttachments } from '../components/SeatAttachments'
import { SeatRecordBlock } from '../components/SeatRecordBlock'
import { PanelBody, PanelFrame } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { PluginPanelTableExample } from './plugin-panel-table'
import { PREVIEW_SESSION_KEY, previewStore, store } from './harness'
import { Frame } from './main'
import { PREVIEW_CHECKS, PREVIEW_SEAT } from './evidence-fixture'

const session = store.getSnapshot().sessions.get(PREVIEW_SESSION_KEY)!
const delegation: SubagentItem = {
  id: itemId('compact-delegation'), type: 'subagent', action: 'spawn', status: 'completed',
  prompt: 'Review the shared check declarations and report any commands that need approval before they can run. '.repeat(16),
  members: [
    { sessionId: 'compact-reviewer', nickname: 'Reviewer', role: 'review', model: 'alpha-max', state: 'working', openable: false },
    { sessionId: 'compact-auditor', nickname: 'Auditor', role: 'audit', model: 'alpha-max', state: 'working', openable: false },
    { sessionId: 'compact-tester', nickname: 'Tester', role: 'test', model: 'alpha-max', state: 'completed', openable: false },
  ],
}

/** The real Agents inspector, populated without changing the other session frames. */
export const compactAgentsStore = previewStore({
  home: '/preview',
  sessions: new Map([[PREVIEW_SESSION_KEY, {
    ...session, cwd: '/preview/code/project',
    turns: session.turns.map((turn, index) => index === 0 ? { ...turn, items: [...turn.items, delegation] } : turn),
  }]]),
})
// Its Seat record has a separate frame already; this frame shows the rows beside it.
compactAgentsStore.seatRecord = async () => null

/** A closed turn with two edits gives the Changes inspector real file rows. */
export const compactChangesStore = previewStore({
  home: '/preview',
  sessions: new Map([[PREVIEW_SESSION_KEY, {
    ...session, cwd: '/preview/code/project',
    turns: session.turns.map((turn, index) => index === session.turns.length - 1 ? {
      ...turn,
      diff: 'diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1 +1 @@\n-const ready = false\n+const ready = true\ndiff --git a/test/review.test.ts b/test/review.test.ts\n--- a/test/review.test.ts\n+++ b/test/review.test.ts\n@@ -1 +1 @@\n-expect(ready).toBe(false)\n+expect(ready).toBe(true)\n',
    } : turn),
  }]]),
})

const seat = 'compact-seat' as SeatId
const skill = { kind: 'skill' as const, name: 'review', digest: 'a'.repeat(64), source: 'library' as const, pathLabel: '~/.skills/review' }
const server = { kind: 'mcp' as const, name: 'search', digest: 'b'.repeat(64), source: 'library' as const, pathLabel: '~/.mcp/search' }
const reason = 'This attachment could not be loaded for this Seat. Review its declaration before starting again. Refused attachment: attachment_with_a_long_unbroken_catalogue_identifier_that_must_remain_readable_in_a_narrow_inspector.'
const longChecks = {
  ...PREVIEW_CHECKS,
  project: '/preview/code/project',
  file: '/preview/code/project/.harnessdesk/checks.yml',
  checks: PREVIEW_CHECKS.checks.map(check => check.name === 'lint' ? {
    ...check,
    run: 'pnpm lint --max-warnings 0 --filter ./packages/project-with-a-long-name/src/checks-and-declarations --reporter verbose',
  } : check),
}
const attachments: SeatAttachmentsRecord = {
  version: 1, seat, agentDigest: 'd'.repeat(64), runtime: String(session.runtime), build: '1.0.0', epoch: 0,
  observedAt: 1, skillsMode: 'allowlist', mcpMode: 'allowlist', restored: false,
  declarations: [
    { kind: 'skill', name: 'review', identity: skill, problem: null },
    { kind: 'mcp', name: 'search', identity: server, problem: reason },
  ],
  results: [
    { identity: skill, status: 'loaded', reason: null },
    { identity: server, status: 'not-loaded', reason },
  ],
}
const startedAt = Date.now() - 65_000
const tasks: readonly BackgroundTask[] = [
  { id: 'compact-tests', label: 'Run the focused project checks', kind: 'command', state: 'running', startedAt, stoppable: true, command: 'pnpm test', output: 'Checking project declarations…' },
  { id: 'compact-types', label: 'Check the row types', kind: 'command', state: 'completed', startedAt, endedAt: startedAt + 30_000, stoppable: false, command: 'pnpm typecheck', output: 'Types checked.' },
]
const panelStore = previewStore({ home: '/preview', tasks: new Map([[PREVIEW_SESSION_KEY, tasks]]) })
panelStore.readSeatAttachments = async () => attachments
panelStore.seatRecord = async () => ({
  ...PREVIEW_SEAT, id: seat,
  checkout: { ...PREVIEW_SEAT.checkout, cwd: '/preview/code/project', project: '/preview/code/project' },
})
panelStore.refreshTasks = async () => {}

export const CompactPanelFrames = () => (
  <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
    <Frame id="project-checks-long-command" title="Project — long check commands">
      <div className="w-[380px] p-4">
        <StoreProvider store={panelStore}><ProjectChecksView checks={longChecks} /></StoreProvider>
      </div>
    </Frame>
    <Frame id="panel-background-tasks" title="Side panel — Background tasks">
      <div className="h-[420px]">
        <StoreProvider store={panelStore}>
          <PaneProvider scope={{ paneId: 'compact-tasks' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never, sessionKey: PREVIEW_SESSION_KEY }}>
            <BackgroundTasksView />
          </PaneProvider>
        </StoreProvider>
      </div>
    </Frame>
    <Frame id="panel-seat-attachments" title="Side panel — Seat attachments">
      <div className="h-[420px] w-[380px]">
        <StoreProvider store={panelStore}><PanelFrame><PanelBody><SeatAttachments seat={seat} /></PanelBody></PanelFrame></StoreProvider>
      </div>
    </Frame>
    <Frame id="panel-seat-record" title="Side panel — Seat record">
      <div className="w-[380px]">
        <StoreProvider store={panelStore}>
          <PaneProvider scope={{ paneId: 'compact-seat-record' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY } as never, sessionKey: PREVIEW_SESSION_KEY }}>
            <PanelFrame><PanelBody><SeatRecordBlock /></PanelBody></PanelFrame>
          </PaneProvider>
        </StoreProvider>
      </div>
    </Frame>
    <Frame id="plugin-panel-table" title="Plugin panel — Table">
      <div className="p-4"><PluginPanelTableExample /></div>
    </Frame>
  </div>
)
