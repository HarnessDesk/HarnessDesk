import { TeamViewFrame } from './TeamViewFrame'
import { useMemo } from 'react'
import { runtimeId, type TeamState } from '@harnessdesk/protocol'
import { TeamBoardPane } from '../components/TeamBoardPane'
import { StoreProvider } from '../state/context'
import { useTheme } from '../state/theme'
import { cardEvidence, checkView, ciView, diffView, EVIDENCE_BOARD, EVIDENCE_ROOM, EVIDENCE_TEAM, prView } from './evidence-fixture'
import { previewStore } from './harness'

/** Five jobs on the real board pane, with only synthetic identities and host facts. */
export const BoardListFrames = () => {
  useTheme()
  const store = useMemo(() => {
    const now = Date.now()
    const params = new URLSearchParams(location.search)
    const evidenceState = params.get('evidence')
    const name = params.get('assignee') === 'long' ? 'Jane Doe with a very long placeholder name' : 'Jane Doe'
    const source = EVIDENCE_TEAM.intents
    const jobs = [
      { ...source[1]!, title: 'Post the review', role: 'review', state: 'blocked' as const, blockedBy: 'hand' as const, blockedReason: 'Choose the target', updatedAt: now - 120000 },
      { ...source[2]!, title: 'Wait for retry coverage', role: 'fix', state: 'blocked' as const, blockedBy: 'graph' as const, blockedReason: null, dependsOn: [2], detail: 'Waiting for the retry test to finish.', updatedAt: now - 60000 },
      { ...source[0]!, title: 'Retry the checkout with a request change', role: 'review', state: 'done' as const, outcome: 'request-changes', files: ['src/retry/**'], note: 'Request changes on the retry proof.', updatedAt: now - 360000 },
      { ...source[3]!, title: 'packages/server/src/methods/conversation.ts::resumeAfterCompaction/checkout/retry/with-a-long-path-like-title', role: 'review', state: 'done' as const, files: ['docs/retry.md'], note: 'Recheck the checkout retry instructions. '.repeat(60), updatedAt: now - 240000 },
    ]
    if (params.get('tall') === 'todo') {
      jobs.push(...Array.from({ length: 12 }, (_, index) => ({ ...jobs[1]!, id: 100 + index, title: `Queued placeholder job ${index + 1}` })))
    }
    const board: TeamState = { ...EVIDENCE_TEAM, intents: jobs, nicknames: { 'codex\u0000c1': name, 'claude\u0000k1': 'Reviewer' }, channel: [
      ...EVIDENCE_TEAM.channel,
      ...[1, 4].map(id => ({ kind: 'signal' as const, id: `completed-${id}`, at: now - id * 60000, intent: id, title: jobs.find(one => one.id === id)!.title, signal: 'completed' as const, by: { kind: 'agent' as const, runtime: runtimeId('codex'), sessionId: 'c1', title: name } })),
    ] }
    // This geometry scene keeps its own passing card; the shared dense-evidence
    // scene deliberately uses a failure, which belongs in Needs you.
    const evidence = { ...EVIDENCE_BOARD, cards: EVIDENCE_BOARD.cards.map(card => card.card === 1
      ? cardEvidence(1, [checkView({ card: 1 }), ciView(['passed', 'passed', 'skipped'], { card: 1 }), prView('open', { card: 1 }), diffView({ card: 1 })])
      : card) }
    return previewStore({ teams: new Map([[EVIDENCE_ROOM, board]]), boardEvidence: evidenceState ? new Map() : new Map([[EVIDENCE_ROOM, evidence]]), boardEvidenceFailed: new Set(evidenceState === 'failed' ? [EVIDENCE_ROOM] : []) })
  }, [])
  return <div data-frame-id="board-list-page" className="h-screen bg-background text-foreground"><StoreProvider store={store}><TeamViewFrame room={EVIDENCE_ROOM} page="board"><TeamBoardPane room={EVIDENCE_ROOM} /></TeamViewFrame></StoreProvider></div>
}
