import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { FlowStepRow, GroupLine, ListRows, TimelineItem, type Tint } from '../design'
import { flowModel } from '../lib/flow-model'
import { flowOverlay, stepForRow } from '../lib/flow-overlay'
import { runTimeline, type RunTimelineInput } from '../lib/run-timeline'
import { groupRunSteps } from '../lib/run-step-groups'
import { wordOf } from '../lib/agents'

export interface RunStepsProps {
  recent?: number
  timeline?: boolean
  seatNames?: ReadonlyMap<string, { name: string }>
  input: RunTimelineInput
  selectedRow: string | null
  selectedStep?: string | null
  faces?: ReadonlyMap<string, ReactNode>
  faceTints?: ReadonlyMap<string, Tint>
  attemptsRead?: 'reading' | 'failed'
  onSelect: (row: string) => void
  onSelectStep?: (step: string) => void
  /** The Timeline renders original round records and every action on expansion. */
  renderRound?: (round: number) => ReactNode
}

export const RunSteps = ({ input, selectedRow, selectedStep, faces, faceTints, attemptsRead, onSelect, onSelectStep, renderRound, timeline = false, seatNames, recent }: RunStepsProps) => {
  const { execution } = input
  const model = flowModel(execution.document.flow), rows = runTimeline(input).rows
  const rounds = [...execution.rounds].sort((a, b) => a.n - b.n)
  const chosen = rows.find(one => one.id === selectedRow)?.round ?? null
  const step = selectedStep ?? stepForRow(execution, rows, selectedRow)
  const future = model.steps.filter(one => !rounds.some(round => round.role === one.id))
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (execution.state !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [execution.state])
  const normalized = rounds.map(round => {
    const run = flowOverlay({ execution: { ...execution, rounds: [round] }, model, cards: input.cards, sessions: input.sessions,
      waitingSeats: input.waitingSeats,
      attempts: input.attempts ? new Map([...input.attempts].map(([id, attempts]) => [id, {
        attempts, complete: !attemptsRead && !input.incompleteAttempts?.has(id),
      }])) : undefined }).steps.get(round.role)
    const records = rows.filter(one => one.round === round.n && one.kind !== 'round')
    const cards = round.cards.map(id => input.cards.find(one => one.id === id))
    const role = execution.document.flow.roles.find(one => one.id === round.role)
    const checkCommand = role?.kind === 'check' ? role.check?.run : undefined
    const results = round.cards.map(id => input.evidence?.cards.find(one => one.card === id)?.facts
      .filter(one => !one.record.restored && one.record.round === round.n && one.record.fact.kind === 'check'
        && one.record.fact.name === round.role && one.record.fact.run === checkCommand)
      .sort((a, b) => b.record.observedAt - a.record.observedAt)[0])
    const unsafe = records.some(one => one.attention || one.publication?.needsYou || one.working || /fail|refused|blocked|unknown|unavailable|request[- ]changes/i.test(one.status ?? ''))
      || Boolean(input.evidence?.unreadable)
      || round.cards.some(id => input.incompleteAttempts?.has(id)
        || input.attempts?.get(id)?.some(one => one.exit === null || one.exit !== 0 || one.timedOut))
      || cards.some(one => !one || one.state !== 'done' || !one.outcome?.trim())
      || role?.kind === 'check' && (Boolean(attemptsRead) || results.some(one => one?.record.fact.kind !== 'check' || one.record.fact.exit === null || one.record.fact.exit !== 0 || one.record.fact.timedOut))
    // Compare recorded text and results before sanitizing for display. Identity
    // prefixes, card ids and observation times distinguish visits, not outcomes.
    const signature = JSON.stringify({
      cards: cards.map(one => one ? { title: one.title, detail: one.detail, outcome: one.outcome, note: one.note, handoff: one.handoff } : null),
      records: records.map(one => ({ kind: one.kind, title: one.card !== null && ['card', 'person'].includes(one.kind)
        ? input.cards.find(card => card.id === one.card)?.title : one.title, detail: one.detail, status: one.status, summary: one.summary,
        publication: one.publication, attempt: one.attempt, on: one.on, keep: one.keep, change: one.change,
        pick: one.pick ? { revision: one.pick.revision, attempts: one.pick.attempts.map(({ card: _card, ...attempt }) => attempt) } : null,
        attempts: one.card === null ? null : input.attempts?.get(one.card)?.map(attempt => ({ n: attempt.n, commit: attempt.commit, exit: attempt.exit, timedOut: attempt.timedOut, outcome: attempt.outcome, tail: attempt.tail })),
      })),
      results: results.map(one => one?.record.fact.kind === 'check' ? { exit: one.record.fact.exit, timedOut: one.record.fact.timedOut,
        dirty: one.record.fact.dirty, at: one.record.fact.at, tail: one.record.fact.tail, checkout: one.record.checkout ?? null } : null),
    })
    const record = records.find(one => ['card', 'check', 'person'].includes(one.kind))
    const fallback = { state: record?.status === 'Stopping' ? 'stopping' as const : record?.status === 'Stopped' ? 'stopped' as const : record?.working ? 'working' as const : record?.attention ? 'blocked' as const : round.state === 'closed' ? 'done' as const : 'blocked' as const,
      runs: 1, durationMs: record?.durationMs ?? null, since: record?.since ?? null, line: record?.status ?? null, seats: round.seats }
    return { round, run: run ?? fallback, step: round.role, state: round.state === 'closed' && !unsafe && records.length > 0
      && rows.find(one => one.kind === 'round' && one.round === round.n)?.complete === true && run?.state === 'done' ? 'done' : 'blocked', signature }
  })
  const primary = (one: typeof normalized[number]) => rows.find(row => row.round === one.round.n && ['card', 'check', 'person'].includes(row.kind))
  const runOf = (one: typeof normalized[number]) => {
    const row = primary(one)
    if (row?.kind === 'check' && row.attention) return { ...one.run, line: row.status ?? one.run.line }
    // A review kept on this desk keeps its verdict. A posted review still names
    // its recorded destination, and an uncertain posting keeps its warning.
    const posted = input.findingRun?.rounds.some(round => round.round === one.round.n && round.state === 'posted')
    return row?.pick ? { ...one.run, line: 'Picked' } : row?.publication && (row.publication.needsYou || posted) ? { ...one.run, line: row.publication.label } : one.run
  }
  const select = (one: typeof normalized[number]) => timeline ? primary(one)?.id ?? `round-${one.round.n}` : `round-${one.round.n}`
  const roundFacts = (n: number) => {
    const row = rows.find(one => one.kind === 'round' && one.round === n)
    return [row?.asked != null && row.asked > 1 ? row.detail : null, row?.blind ? 'Blind until the round closes' : null].filter(Boolean).join(' · ')
  }
  const renderOne = (one: typeof normalized[number]) => renderRound ? renderRound(one.round.n) : <FlowStepRow timeline={timeline} activity={Boolean(recent)} seatNames={seatNames} rowId={primary(one)?.id} rowKind={primary(one)?.kind}
    step={model.steps.find(step => step.id === one.step)
      ?? { id: one.step, kind: 'agent', name: wordOf(one.step), line: '', count: 1, agents: [] }}
    run={runOf(one)} faces={faces} faceTints={faceTints} now={now} subtitle={recent ? (() => {
      const record = rows.find(row => row.kind === 'round' && row.round === one.round.n)
      return `Round ${one.round.n}${record?.asked != null && record.asked > 1 && record.answered != null ? ` · ${record.answered} of ${record.asked} complete` : ''}`
    })() : `Round ${one.round.n}${timeline && roundFacts(one.round.n) ? ` · ${roundFacts(one.round.n)}` : ''}`}
    selected={step === one.step} onSelect={() => onSelect(select(one))} />
  if (recent) return <ListRows>{normalized.slice(-recent).map(one => <Fragment key={one.round.n}>{renderOne(one)}</Fragment>)}</ListRows>
  const taken = groupRunSteps(recent ? normalized.slice(-recent) : normalized).map(group => {
    const first = group[0]!
    if (group.length === 1) return <Fragment key={first.round.n}>{renderOne(first)}</Fragment>
    const open = expanded.has(first.round.n) || group.some(one => one.round.n === chosen)
    const toggle = () => setExpanded(was => {
      const next = new Set(was)
      if (next.has(first.round.n)) next.delete(first.round.n); else next.add(first.round.n)
      return next
    })
    const row = <FlowStepRow timeline={timeline} seatNames={seatNames} repeated rowId={primary(group.at(-1)!)?.id} rowKind={primary(group.at(-1)!)?.kind} roundGroup={timeline ? first.round.n : undefined} step={model.steps.find(one => one.id === first.step)
      ?? { id: first.step, kind: 'agent', name: wordOf(first.step), line: '', count: 1, agents: [] }}
      run={{ ...runOf(first), runs: group.length }} now={now} faces={faces} faceTints={faceTints}
      subtitle={`Rounds ${first.round.n}–${group.at(-1)!.round.n}`} selected={step === first.step} onSelect={timeline ? () => onSelect(select(group.at(-1)!)) : toggle} />
    if (timeline) return <Fragment key={first.round.n}>{row}</Fragment>
    return renderRound ? <Fragment key={first.round.n}>
      <TimelineItem section state="done" title={null} data-round-group={first.round.n} data-expanded={open}>{row}</TimelineItem>
      {open && group.map(one => <Fragment key={one.round.n}>{renderOne(one)}</Fragment>)}
    </Fragment> : <div key={first.round.n} data-round-group={first.round.n} data-expanded={open}>
      {row}{open && group.map(one => <Fragment key={one.round.n}>{renderOne(one)}</Fragment>)}
    </div>
  })
  const unreached = (recent ? [] : future).map(one => {
    const row = <FlowStepRow timeline={timeline} seatNames={seatNames} step={one} run={{ state: 'future', runs: 0, durationMs: null, since: null, line: null, seats: [] }}
      selected={step === one.id} onSelect={onSelectStep} />
    return <Fragment key={one.id}>{row}</Fragment>
  })
  if (timeline) return <>
    <TimelineItem section state="pending" title={`Taken ${rounds.length}`} />{taken}
    {future.length > 0 && <><TimelineItem section state="pending" title={`Not reached ${future.length}`} />{unreached}</>}
  </>
  return renderRound ? <>
    <TimelineItem section state="pending" title={`Taken ${rounds.length}`} />{taken}
    {future.length > 0 && <TimelineItem section state="pending" title={`Not reached ${future.length}`}>{unreached}</TimelineItem>}
  </> : <div data-slot="run-steps" className="min-w-0">
    <GroupLine left={`Taken ${rounds.length}`} />{taken}
    {future.length > 0 && <><GroupLine left={`Not reached ${future.length}`} />{unreached}</>}
  </div>
}
