import { useMemo } from 'react'
import { isBusy, turnId } from '@harnessdesk/protocol'
import { Bar, Chip, HeaderStatusGroup, HeaderStatusReading, Menu, MenuItem, Popover, Text } from '../design'
import { BranchIcon } from '../components/Icons'
import { PlanMeters } from '../components/PlanMeters'
import { PaneProvider, StoreProvider, useActiveSession } from '../state/context'
import { useTheme } from '../state/theme'
import { Frame } from './main'
import { PREVIEW_SESSION_KEY, previewStore, store } from './harness'

/** The retained primitive, independently of Conversation's canonical TopBar.
 * Real grouped Popovers and PlanMeters keep the hover/focus/menu contract live. */
const HeaderStatusSpecimen = () => {
  const session = useActiveSession()
  const running = session !== null && isBusy(session)
  return <div className="[container-name:hd-header] [container-type:inline-size]">
    <Bar as="header" rule="bottom">
      <Text role="subject" truncate className="min-w-0 flex-1">Status specimen</Text>
      <HeaderStatusGroup>
        <HeaderStatusReading label="Status" detail={running ? 'Working' : 'Idle'}>
          <Chip variant="quiet" tone="neutral" dotTone="neutral" dotPulse={running} dotShape={running ? 'square' : 'round'} autoTitle={false} />
        </HeaderStatusReading>
        <HeaderStatusReading label="Branch" detail="feat/worktrees — /work/project" value="feat/worktrees" note="/work/project" notePath>
          <Popover title="feat/worktrees — /work/project" label={<BranchIcon size={16} />}>
            {close => <Menu close={close}><MenuItem label="Changes" onSelect={close} /></Menu>}
          </Popover>
        </HeaderStatusReading>
        <PlanMeters onOpen={() => {}} onSignIn={() => {}} />
      </HeaderStatusGroup>
    </Bar>
  </div>
}

const HeaderConversation = () => {
  useTheme()
  return <main className="bg-background p-4 text-foreground">
    <Frame id="header-status-conversation" title="Conversation status">
      <div className="h-[820px]">
        <PaneProvider scope={{ paneId: 'header-status-preview', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}>
          <HeaderStatusSpecimen />
        </PaneProvider>
      </div>
    </Frame>
  </main>
}

/** One isolated, placeholder-only conversation for public header frames. */
export const HeaderStatusFrames = () => {
  const seeded = useMemo(() => {
    const query = new URLSearchParams(window.location.search)
    const snapshot = store.getSnapshot()
    const session = snapshot.sessions.get(PREVIEW_SESSION_KEY)!
    const cwd = '/work/project'
    const sessions = new Map(snapshot.sessions)
    sessions.set(PREVIEW_SESSION_KEY, {
      ...session, cwd, deskCopy: query.has('desk-copy'),
      turns: query.has('running') ? [...session.turns, { id: turnId('header-running'), status: 'inProgress', items: [] }] : session.turns,
      settings: { ...session.settings, cwd, model: session.settings?.model ?? 'model-a' },
    })
    const usage = snapshot.usage.map((original) => {
      const report = { ...original, account: 'dev@example.com' }
      return report.runtime === session.runtime ? report : {
      ...report,
      reached: report.lanes[0]?.id ?? null,
      lanes: report.lanes.map((lane) => ({ ...lane, usedPercent: 100, resetsAt: Date.now() + 6 * 3_600_000 })),
      }
    })
    return previewStore({
      sessions, usage,
      workspace: { path: cwd, name: 'Project', lastOpenedAt: 1, git: { branch: 'feat/worktrees' } },
      worktrees: [{ path: cwd, branch: 'feat/worktrees', managed: false, isMain: false, head: 'a1b2c3d' }],
      theme: query.get('theme') === 'dark' ? 'dark' : 'light',
    })
  }, [])
  return <StoreProvider store={seeded}><HeaderConversation /></StoreProvider>
}
