import { useMemo } from 'react'
import { runtimeId, type TeamState } from '@harnessdesk/protocol'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM } from './evidence-fixture'
import { previewStore } from './harness'

/** Five jobs on the real board pane, with only synthetic identities and host facts. */
export const BoardListFrames = () => {
  useTheme()
  const store = useMemo(() => {
    const now = Date.now()
    const evidenceState = new URLSearchParams(location.search).get('evidence')
    const source = EVIDENCE_TEAM.intents
    const jobs = [
      { ...source[1]!, title: 'Post the review', role: 'review', state: 'blocked' as const, blockedBy: 'hand' as const, blockedReason: 'Choose the target', updatedAt: now - 120000 },
      { ...source[2]!, title: 'Wait for retry coverage', role: 'fix', state: 'blocked' as const, blockedBy: 'graph' as const, blockedReason: null, dependsOn: [2], detail: 'Waiting for the retry test to finish.', updatedAt: now - 60000 },
      { ...source[0]!, title: 'Retry the checkout with a request change', role: 'review', state: 'done' as const, outcome: 'request-changes', files: ['src/retry/**'], note: 'Request changes on the retry proof.', updatedAt: now - 360000 },
      { ...source[3]!, title: 'packages/server/src/methods/conversation.ts::resumeAfterCompaction/checkout/retry/with-a-long-path-like-title', role: 'review', state: 'done' as const, files: ['docs/retry.md'], note: 'Recheck the checkout retry instructions. '.repeat(60), updatedAt: now - 240000 },
    ]
    const board: TeamState = { ...EVIDENCE_TEAM, intents: jobs, nicknames: { 'codex\u0000c1': 'Jane Doe', 'claude\u0000k1': 'Reviewer' }, channel: [
      ...EVIDENCE_TEAM.channel,
      ...[1, 4].map(id => ({ kind: 'signal' as const, id: `completed-${id}`, at: now - id * 60000, intent: id, title: jobs.find(one => one.id === id)!.title, signal: 'completed' as const, by: { kind: 'agent' as const, runtime: runtimeId('codex'), sessionId: 'c1', title: 'Jane Doe' } })),
    ] }
    return previewStore({ teams: new Map([[EVIDENCE_ROOM, board]]), boardEvidence: evidenceState ? new Map() : new Map([[EVIDENCE_ROOM, EVIDENCE_BOARD]]), boardEvidenceFailed: new Set(evidenceState === 'failed' ? [EVIDENCE_ROOM] : []) })
  }, [])
  return <div data-frame-id="board-list-page" className="h-screen bg-background text-foreground"><StoreProvider store={store}><TeamBoardPane room={EVIDENCE_ROOM} /></StoreProvider></div>
}
