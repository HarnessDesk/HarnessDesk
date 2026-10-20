import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { CheckIcon } from '../../components/Icons'
import type { FlowStepState } from '../../lib/flow-overlay'
import { Card } from './card'
import { Chip, Text } from '../patterns/Settings'
import styles from './flow-step.module.css'

/** State marks on a Flow's measured node box. Its geometry belongs to the graph, and its surface to the system. */
export const FlowStepSurface = ({ state, selected, children, duration, runs, onClick, custom = false }: {
  state?: FlowStepState; selected?: boolean; children: ReactNode; custom?: boolean
  duration: string | null; runs?: number | null; onClick?: () => void
}) => (
  <>
    {(state === 'working' || state === 'waiting') && <span data-slot="flow-ring" data-state={state}
      className={`absolute -inset-1 rounded-lg ${styles.ring} ${state === 'waiting' ? 'ring-2 ring-(--hd-warning)/20' : 'ring-2 ring-(--hd-accent)/20'}`} />}
    <Card variant="raised" spacing="compact" onClick={onClick}
      className={`absolute inset-0 flex flex-col gap-3 p-4 ${onClick ? 'cursor-pointer' : ''} ${selected ? 'outline-2 outline-offset-2 outline-(--hd-border-strong)' : ''} ${
        state === 'future' ? 'border-dashed' : state === 'working' ? 'border-(--hd-accent)' : state === 'waiting' ? 'border-(--hd-warning)' : state === 'done' ? 'border-(--hd-accent)/40' : ''}`}>
      <div data-slot="flow-step-content" className={custom ? 'min-h-0 min-w-0 flex-1' : 'grid grid-cols-[auto_minmax(0,1fr)] auto-rows-min items-center gap-x-3 gap-y-2'}>{children}</div>
      {(state === 'done' || state === 'working' || state === 'waiting' || state === 'blocked' || duration !== null || (runs !== undefined && runs !== null && runs > 1)) &&
        <div className="mt-auto flex min-w-0 items-center justify-between gap-2">
          {state === 'done' && <span data-slot="flow-complete" aria-label="Done" className="inline-flex size-4 items-center justify-center rounded-full bg-(--hd-accent) text-(--hd-accent-foreground)"><CheckIcon size={12} /></span>}
          {(state === 'working' || state === 'waiting' || state === 'blocked') && <span data-slot="flow-state"><Chip size="sm" tone={state === 'waiting' ? 'warning' : state === 'working' ? 'info' : 'neutral'}>{state === 'waiting' ? 'Waiting for you' : state === 'working' ? 'Working' : 'Waiting'}</Chip></span>}
          {(duration !== null || (runs !== undefined && runs !== null && runs > 1)) && <span data-slot="flow-duration" className="ml-auto"><Text role="meta">{[duration, runs !== undefined && runs !== null && runs > 1 ? `×${runs}` : null].filter(Boolean).join(' · ')}</Text></span>}
        </div>}
    </Card>
  </>
)

/** A single baton keeps its phase across snapshots. A new curve waits for the old curve's faded end. */
export const FlowBaton = ({ path }: { path: string }) => {
  const [drawn, setDrawn] = useState(path)
  const pending = useRef(path)
  pending.current = path
  const reduced = useRef(false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => { reduced.current = media.matches; if (media.matches) setDrawn(pending.current) }
    change()
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  useEffect(() => { if (reduced.current) setDrawn(path) }, [path])
  return <span data-slot="flow-baton" data-path={drawn} aria-hidden="true" className={styles.baton}
    style={{ offsetPath: `path("${drawn}")` } as CSSProperties}
    onAnimationIteration={() => setDrawn(pending.current)}>
    <span className="absolute right-0 top-0 size-2 rounded-full bg-(--hd-accent) ring-4 ring-(--hd-accent)/20" />
  </span>
}

/** A travelled loop's count has an opaque ground, so the curve never crosses its words. */
export const FlowRouteLabel = ({ travelled, children }: { travelled: boolean; children: ReactNode }) =>
  <span className={travelled ? styles.route : undefined}><Chip size="sm" tone="neutral" variant={travelled ? 'outline' : 'default'} emphasis={travelled}>{children}</Chip></span>

/** A doing sentence stays readable where a route passes beneath the current card. */
export const FlowDoingLine = ({ text }: { text: string }) =>
  <span className="inline-block max-w-full bg-(--hd-background) px-1"><Text role="meta" tone="brand" align="center" truncate className="block" title={text}>{text}</Text></span>
