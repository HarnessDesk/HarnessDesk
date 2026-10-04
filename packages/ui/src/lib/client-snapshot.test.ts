import { expect, it } from 'vitest'
import type { BoardEvidence, FindingRunView, FindingView, FlowExecution, WireNotification } from '@harnessdesk/protocol'
import { runTimeline, runTimelineOf, teamOverviewOf } from '@harnessdesk/client/views'
import replay from '../../../../e2e/fixtures/client-views-stream.json'
import { AppStore } from '../state/store'
import { clientSnapshot } from './client-snapshot'

it('replays the same scripted Team stream used by status and run show through the window store', () => {
  const store = new AppStore('ws://localhost:0/')
  const emit = (notification: WireNotification) => (store.transport as unknown as {
    handlers: { onNotification(notification: WireNotification): void }
  }).handlers.onNotification(notification)
  for (const notification of replay.stream) emit(notification as unknown as WireNotification)
  const held = clientSnapshot(store.getSnapshot())
  const execution = held.runs[0]!
  const extras = { evidence: replay.evidence as unknown as BoardEvidence, findings: replay.findings as FindingView[], findingRun: replay.findingRun as FindingRunView }
  const model = runTimelineOf(held, execution, extras)
  expect(model).toEqual(runTimeline({ ...extras, execution, cards: held.boards[0]!.intents,
    signals: held.boards[0]!.channel.filter(one => one.kind === 'signal'), origin: 'Started by you', publicationOn: false }))
  expect(model.rows.map(row => [row.title, row.status, row.publication?.label, row.detail,
    row.durationMs === null ? null : `${row.durationMs}ms`].filter(value => value != null).join('  '))).toEqual(replay.expectedRows)
  const overview = teamOverviewOf(held, execution.goal, { report: null, runtimes: [] })
  expect(overview.seats).toMatchObject([{ seat: 'writer-seat', name: 'Writer', done: true, state: 'idle' }])
  expect(overview.needsYou).toMatchObject([{ kind: 'card', card: 4, summary: 'Choose the next step' }])
  expect(overview.run).toMatchObject({ run: 'demo-run', state: 'running', round: 4, role: 'person' })
  // Unread state is local to the window; the host's runtime:session key still reaches its Seat id.
  const local = teamOverviewOf(held, execution.goal, { report: null, runtimes: [], seats: held.teams[0]!.members.map(record => ({
    record, name: 'Writer', runtime: null, session: null, unreadSince: 450, approvals: [],
  })) })
  expect(local.seats[0]).toMatchObject({ seat: 'writer-seat', state: 'unread', since: 450 })
  const ended: FlowExecution = { ...execution, state: 'stopped', currentEndedAt: 500, end: { kind: 'stopped', by: 'person' }, reason: 'Pause the demo.' }
  emit({ method: 'flow/execution-changed', params: { execution: ended } })
  expect(runTimelineOf(clientSnapshot(store.getSnapshot()), ended, extras).rows.at(-1)).toMatchObject({ title: 'Stopped by you', detail: 'Pause the demo.', since: 500 })
})
