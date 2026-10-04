import { useMemo } from 'react'
import type { NoticeItem } from '@harnessdesk/protocol'
import { Conversation } from '../components/Conversation'
import { TeamRoomPane } from '../components/TeamRoomPane'
import { MountProvider } from '../panels/mount'
import { PaneProvider, StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { Frame } from './main'
import { PREVIEW_ROOM, previewStore } from './harness'
import { SIDE_BY_SIDE_KEYS, sideBySideStore } from './side-by-side-fixture'

/** `before` uses the unmarked notice shape existing seated transcripts carry. */
const BRIEF: NoticeItem = {
  id: 'agent-brief' as never,
  type: 'notice',
  ...(new URLSearchParams(window.location.search).get('agent-brief') === 'before' ? {} : { kind: 'agentBrief' as const }),
  text: `# Implementer

You build the change you are given, and hand it over in a state somebody else can review.

## Before you write code

- Read the task and everything it names.
- Read the repository's instructions and follow them.
- Look at how the surrounding code already does this kind of thing.

## While you build

- Work on a branch of your own.
- Make the smallest change that does the whole job.
- Write the test first, see it fail, then make it pass.
- Run the project's checks before you call the work done.

## How to report

Say what you changed and why, what you ran to check it, and anything left undone.

End with one line: **Verdict:** and the outcome the task asks for.

## Seat environment

- Working folder: \`/workspace/demo-client\`
- Browser profile: \`preview-agent\``,
}

const BriefFrames = () => {
  useTheme()
  return <main className="p-4 grid gap-4">
    <Frame id="brief-conversation" title="Freshly seated conversation">
      <div className="h-[820px]">
        <PaneProvider scope={{ paneId: 'brief-preview' as never, view: { kind: 'conversation', session: SIDE_BY_SIDE_KEYS[0]! }, sessionKey: SIDE_BY_SIDE_KEYS[0]! }}>
          <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
        </PaneProvider>
      </div>
    </Frame>
    <Frame id="brief-side-by-side" title="Team — Side by side">
      <div className="h-[820px]">
        <MountProvider scope={{ area: 'main', id: 'brief-room', view: { kind: 'room', room: PREVIEW_ROOM, sideBySide: { tiles: SIDE_BY_SIDE_KEYS.slice(0, 2), focused: SIDE_BY_SIDE_KEYS[0]! } } }}>
          <TeamRoomPane room={PREVIEW_ROOM} />
        </MountProvider>
      </div>
    </Frame>
  </main>
}

/** Real conversation and tile surfaces, with a newly seated brief and placeholder identities. */
export const AgentBriefFrames = () => {
  const store = useMemo(() => {
    const snapshot = sideBySideStore({ noGoal: true }).getSnapshot()
    const sessions = new Map([...snapshot.sessions].map(([key, session]) => [key, {
      ...session, status: { type: 'active' as const },
      turns: [{ id: `${session.id}-brief` as never, status: 'inProgress' as const, items: [BRIEF, { id: `${session.id}-work` as never, type: 'assistantMessage' as const, phase: 'commentary' as const, text: 'I’ll read the task and surrounding code, then add a regression test.' }] }],
    }]))
    const theme = new URLSearchParams(window.location.search).get('theme') === 'dark' ? 'dark' : 'light'
    return previewStore({ ...snapshot, sessions, theme })
  }, [])
  return <StoreProvider store={store}><BriefFrames /></StoreProvider>
}
