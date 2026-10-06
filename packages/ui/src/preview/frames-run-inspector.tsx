import { useMemo, useState } from 'react'
import { TeamRunView } from '../components/TeamRunView'
import { StoreProvider } from '../state/context'
import { RunWorkspace } from '../components/RunWorkspace'
import { runTimeline } from '../lib/run-timeline'
import { runFixture, runTeamStore } from './run-view-fixture'

export const RUN_INSPECTOR_STATES = ['run', 'card', 'check', 'check-attempts', 'check-refused', 'check-stopped', 'check-running', 'attempts-reading', 'attempts-failed', 'attempts-incomplete', 'attempts-new-check-reading', 'person', 'findings', 'findings-reading', 'findings-failed', 'empty', 'pending', 'failed', 'narrow'] as const
export type InspectorScene = typeof RUN_INSPECTOR_STATES[number]
export const RunInspectorExample = ({ scene }: { scene: InspectorScene }) => {
  // A check that ran twice, one whose Run has ended, and one whose attempts are not here yet: each is its own Run on the rig.
  const attemptsScene = scene === 'check-attempts' || scene === 'attempts-reading' || scene === 'attempts-failed' || scene === 'attempts-incomplete' || scene === 'attempts-new-check-reading'
  const source = runFixture(scene === 'person' ? 'person' : scene === 'empty' ? 'empty' : scene === 'check-stopped' ? 'stopped' : scene === 'check-refused' ? 'settled' : attemptsScene ? 'attempts' : 'running')
  const newCheckScene = scene === 'attempts-new-check-reading'
  const execution = scene === 'check-running' ? { ...source.execution,
    operations: source.execution.operations.map(one => one.kind === 'check' && one.card === 2 ? { ...one, state: 'started' as const } : one),
  } : newCheckScene ? { ...source.execution,
    operations: [...source.execution.operations, { key: 'check:5:1', kind: 'check' as const, card: 5, seat: null, state: 'started' as const }],
    rounds: [...source.execution.rounds, { n: 5, role: 'verify', cards: [5], seats: [], evidence: [], state: 'running' as const, cause: 'review-loop' }],
  } : source.execution
  const cards = newCheckScene ? [...source.cards, { ...source.cards[1]!, id: 5, title: 'Verify the repair', state: 'open' as const, outcome: null }] : source.cards
  // A card opened before its Goal's findings have been read, or when reading them failed: none is not said of either.
  const unread = scene === 'findings-reading' ? 'reading' : scene === 'findings-failed' ? 'failed' : undefined
  // A check whose attempts have not been read, or whose read failed: it ran once is not said of either.
  const attemptsRead = scene === 'attempts-reading' || newCheckScene ? 'reading' : scene === 'attempts-failed' ? 'failed' : undefined
  const incompleteAttempts = scene === 'attempts-incomplete' ? new Set([2]) : undefined
  const input = { ...source, ...(unread ? { findings: undefined } : {}), ...(incompleteAttempts ? { incompleteAttempts } : {}),
    ...(scene === 'attempts-reading' || scene === 'attempts-failed' ? { attempts: undefined } : {}),
    ...(scene === 'attempts-incomplete' ? { attempts: new Map([[2, [{ ...source.attempts!.get(2)![1]!, n: null }]]]) } : {}),
    execution: { ...execution, base: { remote: 'origin', branch: 'main', at: 'abc123' },
    ...(scene === 'run' ? { findings: { version: 1 as const, budget: { rounds: 3, withoutProgress: 2 }, closedRounds: [1, 2, 3], idleRounds: 1,
      progress: [], series: [], stopped: null, extraRound: { after: 3, count: 2, reason: 'Finish the bounded retry repair.' }, overrides: [], lastDecision: null } } : {}),
  },
    // A card's detail as the host stores it: a Flow's `detail: |` sentence keeps its last newline, and the
    // host adds its instructions after a blank line, so three newlines come before them.
    cards: cards.map(card => ({ ...card, detail: [
      'Keep the retry bounded and the last failure visible.\n',
      'Finish this with complete_claim and an outcome of exactly one of: approved, request-changes.',
      'Finish this with complete_claim\'s split as well: the agreed split of files for the "writer" round, one list of path patterns for each of its 2 cards, in card order, no two overlapping. Each of those cards will own only its own list.',
    ].join('\n\n'), handoff: card.id === 1 ? 'Added three attempts with a bounded backoff. The checkout test covers the last failure.' : card.id === 2 ? 'The check passed; this package was not handed to the reviewer.' : card.id === 3 ? 'The retry loop needs a ceiling. Keep the last failure visible to the person.' : null, dependsOn: card.id === 3 ? [1] : [] })) }
  const initial = scene === 'card' || unread ? 'card-3-3' : newCheckScene ? 'check-5-5' : scene === 'check' || scene === 'check-refused' || scene === 'check-stopped' || scene === 'check-running' || attemptsScene ? 'check-2-2' : scene === 'person' ? 'person-4-4' : scene === 'findings' ? 'findings-3' : null
  const [selected, setSelected] = useState<string | null>(initial)
  return <RunWorkspace model={runTimeline(input)} number={1} selectedRow={selected} onSelect={setSelected}
    pending={scene === 'pending' || scene === 'findings-reading'}
    problem={scene === 'failed' ? 'Review details could not be read.' : scene === 'findings-failed' ? 'The desk did not answer. Check the connection and try again.' : null}
    inspector={{ input, findingsRead: unread, ...(attemptsRead ? { attemptsRead } : {}), publication: { round: 3, state: 'local', reason: 'Posting is off for this Team.', pr: null, cards: [3] },
      seats: [{ id: 'seat-0', name: 'Alpha', override: 'Balanced · Medium', cost: { unit: 'turns', value: 4, estimated: false }, onOpen: () => {} }, { id: 'seat-1', name: 'Beta', override: 'Careful · High', cost: { unit: 'money', value: 0.42, estimated: true }, onOpen: () => {} }],
    }} />
}
const RunInspectorTeamExample = () => {
  const store = useMemo(runTeamStore, [])
  const fixture = runFixture('complete')
  const [selected, setSelected] = useState<string | null>(null)
  return <StoreProvider store={store}><TeamRunView execution={fixture.execution} origin="Started by you" onOpenSeat={() => {}}
    model={runTimeline(fixture)} number={1} selectedRow={selected} onSelect={setSelected} /></StoreProvider>
}
// A check's attempts and the control after them need more than a pane's height to be seen whole; every other scene keeps the usual one.
const frameClass = (scene: InspectorScene): string => scene === 'narrow' ? 'flex h-144 max-w-sm flex-col' : scene === 'check-attempts' || scene === 'check-refused' || scene === 'check-stopped' || scene === 'check-running' || scene === 'attempts-incomplete' ? 'flex h-224 flex-col' : 'flex h-144 flex-col'
export const RunInspectorBoard = () => <div className="flex flex-col gap-4">{RUN_INSPECTOR_STATES.map(scene =>
  <section key={scene} data-catalog-state={scene} className={frameClass(scene)}><RunInspectorExample scene={scene} /></section>)}<section data-catalog-state="team" className="flex h-144 flex-col"><RunInspectorTeamExample /></section></div>
export const RunInspectorFrames = () => <div className="flex flex-col gap-4 p-4">{RUN_INSPECTOR_STATES.map(scene =>
  <section key={scene} id={`run-inspector-${scene}`} className={frameClass(scene)}><RunInspectorExample scene={scene} /></section>)}<section id="run-inspector-team" className="flex h-144 flex-col"><RunInspectorTeamExample /></section></div>
