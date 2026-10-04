import { useEffect, useMemo, useRef, useState } from 'react'
import { TeamRoomPane } from '../src/components/TeamRoomPane'
import { AgentIcon, CheckIcon, DevToolsIcon } from '../src/components/Icons'
import { Button, Chip, FlowGraph, PaneColumn, Text } from '../src/design'
import { flowModel, ceilingsOfRun, stepName } from '../src/lib/flow-model'
import { flowOverlay } from '../src/lib/flow-overlay'
import { formatDuration } from '../src/components/TurnTail'
import { StoreProvider, useSnapshot } from '../src/state/context'
import { useTheme } from '../src/state/theme'
import { RUN_TEAM, RUN_STAGES, StagedRun, runTimeSegments, type RunStage } from './fake-run'
import './run-demo.css'

const FACES = new Map([['alpha', <DevToolsIcon />], ['beta', <AgentIcon />], ['gamma', <CheckIcon />]])

/** A poster composes the real graph; only its surrounding page and time bar belong to the site. */
const Poster = ({ run }: { run: StagedRun }) => {
  const snapshot = useSnapshot()
  const { execution, cards, attempts, now } = run.read()
  const seats = snapshot.goals.get(RUN_TEAM)!.members
  const model = useMemo(() => flowModel(execution.document.flow, { ceilings: ceilingsOfRun(execution.rounds, seats) }), [execution, seats])
  const overlay = useMemo(() => flowOverlay({ execution, cards, attempts, model, sessions: snapshot.sessions }), [execution, cards, attempts, model, snapshot.sessions])
  const segments = runTimeSegments(execution, cards, now)
  const total = segments.reduce((sum, one) => sum + one.ms, 0)
  return <PaneColumn inset="reading" data-slot="site-poster" className="site-poster">
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <span className="flex flex-wrap items-center gap-3"><Text role="subject">Write, review, fix</Text><Chip tone={run.stage === 'you' ? 'warning' : 'neutral'}>{run.stage === 'you' ? 'Needs you' : execution.state === 'settled' ? 'Settled' : 'Running'}</Chip></span>
      <Text role="meta">Run 1 · Round {execution.rounds.length} · revision {execution.revision}</Text>
    </div>
    <div className="site-poster-graph"><FlowGraph model={model} overlay={overlay} now={now} faces={FACES}
      doing={new Map([['alpha', 'Editing src/checkout/retry.ts']])} /></div>
    <div data-slot="run-time-bar" role="img" aria-label={`Run time: ${segments.map(one => `${stepName(one.role)} ${formatDuration(one.ms)}`).join(', ')}`} className="flex min-w-0 gap-1">
      {segments.map(one => <div key={one.round} data-round={one.round} data-ms={one.ms} className="min-w-0" style={{ flex: `${one.ms} 1 0%` }}>
        <div className={`h-1.5 rounded-sm bg-primary ${one.live ? '' : 'opacity-50'}`} />
        <Text role="meta" as="div" className="mt-1 break-words">{stepName(one.role)} {formatDuration(one.ms)}</Text>
      </div>)}
    </div>
    <Text role="meta" className="self-end" numeric>{formatDuration(total)} elapsed</Text>
  </PaneColumn>
}

export const RunDemo = ({ run, poster, frozen = false }: { run: StagedRun; poster: boolean; frozen?: boolean }) => {
  useTheme()
  useSnapshot()
  const box = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(frozen || poster)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => setReduced(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    if (poster || paused || reduced || !box.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) run.play()
      else run.pause()
    }, { threshold: 0.3 })
    observer.observe(box.current)
    return () => { observer.disconnect(); run.pause() }
  }, [run, poster, paused, reduced])
  const finished = run.stage === 'you' || run.stage === 'done'
  return <div ref={box} data-slot="site-run-demo" data-stage={run.stage} className={`site-run-demo ${poster ? 'site-run-poster' : ''}`}>
    <PaneColumn inset="reading" className="flex flex-wrap items-center justify-between gap-2">
      <Text role="meta">The numbers are staged; the surface is not.</Text>
      {!poster && !finished && <span className="flex gap-2">
        {!reduced && <Button size="sm" variant="outline" onClick={() => setPaused(was => !was)}>{paused ? 'Play demo' : 'Pause demo'}</Button>}
        <Button size="sm" variant="outline" onClick={() => { setPaused(true); run.pause(); run.next() }}>Next step</Button>
      </span>}
    </PaneColumn>
    {poster ? <Poster run={run} /> : <div className="site-run-pane"><TeamRoomPane room={RUN_TEAM} /></div>}
  </div>
}

/** The same scene in preview.html, for publishable frames without a real desk. */
const StagedScene = ({ preview }: { preview: boolean }) => {
  const knobs = new URLSearchParams(window.location.search)
  const poster = knobs.get(preview ? 'site-run' : 'view') === 'poster'
  const run = useMemo(() => {
    const stage = knobs.get('stage') as RunStage
    const run = new StagedRun(RUN_STAGES.includes(stage) ? stage : poster ? 'fix' : 'write')
    const theme = knobs.get('theme')
    if (theme === 'light' || theme === 'dark') run.store.setTheme(theme)
    return run
  }, [])
  useEffect(() => {
    if (!preview) (window as unknown as { __hdStore?: typeof run.store }).__hdStore = run.store
    const changed = (event: MessageEvent) => {
      const data = event.data as { hdTheme?: string } | null
      if (data?.hdTheme === 'light' || data?.hdTheme === 'dark') run.store.setTheme(data.hdTheme)
    }
    const dispose = () => run.dispose()
    window.addEventListener('message', changed)
    window.addEventListener('pagehide', dispose)
    return () => { window.removeEventListener('message', changed); window.removeEventListener('pagehide', dispose) }
  }, [run, preview])
  return <StoreProvider store={run.store}><RunDemo run={run} poster={poster} frozen={knobs.has('stage')} /></StoreProvider>
}
export const SiteRunPreview = () => <StagedScene preview />
export const SiteRunDemo = () => <StagedScene preview={false} />
