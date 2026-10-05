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
    const source = EVIDENCE_TEAM.intents
    const jobs = [
      { ...source[1]!, title: 'Post the review', role: 'review', state: 'blocked' as const, blockedBy: 'hand' as const, blockedReason: 'Choose the target', updatedAt: now - 120000 },
      { ...source[3]!, title: 'Answer the review findings', role: 'fix', detail: 'Editing the checkout retry', updatedAt: now - 240000 },
      { ...source[0]!, role: 'write', note: 'Published the pull request', updatedAt: now - 360000 },
      { ...source[2]!, title: 'Review the checkout retry', role: 'review', note: 'Reading the retry tests', updatedAt: now - 1800000 },
      { ...source[4]!, title: 'Land the reviewed commit', role: 'land', detail: 'Waits for the review', updatedAt: now - 60000 },
    ]
    const board: TeamState = { ...EVIDENCE_TEAM, intents: jobs, nicknames: { 'codex\u0000c1': 'Implementer', 'claude\u0000k1': 'Reviewer' }, channel: [
      ...EVIDENCE_TEAM.channel,
      ...[1, 3].map(id => ({ kind: 'signal' as const, id: `completed-${id}`, at: now - id * 60000, intent: id, title: jobs.find(one => one.id === id)!.title, signal: 'completed' as const, by: { kind: 'agent' as const, runtime: runtimeId('codex'), sessionId: 'c1', title: 'Implementer' } })),
    ] }
    return previewStore({ teams: new Map([[EVIDENCE_ROOM, board]]), boardEvidence: new Map([[EVIDENCE_ROOM, EVIDENCE_BOARD]]) })
  }, [])
  return <div data-frame-id="board-list-page" className="h-screen bg-background text-foreground"><StoreProvider store={store}><TeamBoardPane room={EVIDENCE_ROOM} /></StoreProvider></div>
}
