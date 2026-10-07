import { useMemo } from 'react'
import { turnId } from '@harnessdesk/protocol'
import { Conversation } from '../components/Conversation'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { Frame } from './main'
import { PREVIEW_SESSION_KEY, previewStore, store } from './harness'

const HeaderConversation = () => {
  useTheme()
  return <main className="bg-background p-4 text-foreground">
    <Frame id="header-status-conversation" title="Conversation status">
      <div className="h-[820px]">
        <PaneProvider scope={{ paneId: 'header-status-preview', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}>
          <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
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
      ...session, cwd,
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
