import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AgentIcon, CheckIcon } from '../../components/Icons'
import type { FlowStepState } from '../../lib/flow-overlay'
import type { Tint } from './tone'
import { IconTile } from './icon-tile'
import { Card } from './card'
import { Chip, Text } from '../patterns/Settings'
import styles from './flow-step.module.css'

/** State marks on a Flow's measured node box. Its geometry belongs to the graph, and its surface to the system. */
export const FlowStepSurface = ({ state, selected, children, duration, runs, onClick }: {
  state?: FlowStepState; selected?: boolean; children: ReactNode
  duration: string | null; runs?: number | null; onClick?: () => void
}) => (
  <>
    {(state === 'working' || state === 'waiting') && <span data-slot="flow-ring" data-state={state}
      className={`absolute -inset-1 rounded-lg ${styles.ring} ${state === 'waiting' ? 'ring-4 ring-(--hd-warning)/20' : 'ring-4 ring-(--hd-accent)/20'}`} />}
    <Card variant="raised" spacing="compact" onClick={onClick}
      className={`absolute inset-0 flex-row items-center ${onClick ? 'cursor-pointer' : ''} ${selected ? 'outline-2 outline-offset-4 outline-(--hd-accent)' : ''} ${
        state === 'future' ? 'border-dashed' : state === 'working' ? 'border-(--hd-accent) ring-1 ring-(--hd-accent)' : state === 'waiting' ? 'border-(--hd-warning) ring-1 ring-(--hd-warning)' : state === 'done' ? 'border-(--hd-accent)/40' : ''}`}>
      {children}
    </Card>
    {state === 'done' && <span data-slot="flow-complete" className="absolute -right-2 -top-2 inline-flex size-6 items-center justify-center rounded-full bg-(--hd-accent) text-(--hd-accent-foreground) ring-2 ring-(--hd-background)"><CheckIcon size={14} /></span>}
    {(state === 'working' || state === 'waiting' || state === 'blocked') && <span data-slot="flow-state" className="absolute right-2 top-2 pointer-events-none"><Chip size="sm" tone={state === 'waiting' ? 'warning' : state === 'working' ? 'info' : 'neutral'}>{state === 'waiting' ? 'Needs you' : state === 'working' ? 'Working' : 'Waiting'}</Chip></span>}
    {(duration !== null || (runs !== undefined && runs !== null && runs > 1)) && <span data-slot="flow-duration" className="absolute bottom-0 left-3 translate-y-1/2 pointer-events-none"><Chip size="sm" tone="neutral">{[duration, runs !== undefined && runs !== null && runs > 1 ? `×${runs}` : null].filter(Boolean).join(' · ')}</Chip></span>}
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

/** The marks of the actual Seats occupying a graph node, overlapping when the round fans out. */
export const FlowFaces = ({ seats, faces, tints, size, fallback }: { seats?: readonly string[]; faces?: ReadonlyMap<string, ReactNode>; tints?: ReadonlyMap<string, Tint>; size?: 'sm'; fallback: ReactNode }) =>
  seats?.length ? <span data-slot="flow-faces" className="flex shrink-0 -space-x-2">{seats.map(id =>
    <IconTile key={id} shape="face" size={size ?? (seats.length > 1 ? 'sm' : 'default')} tint={tints?.get(id) ?? 'violet'} className="ring-2 ring-(--hd-card)">{faces?.get(id) ?? <AgentIcon />}</IconTile>)}</span> : fallback

/** A travelled loop's count has an opaque ground, so the curve never crosses its words. */
export const FlowRouteLabel = ({ travelled, children }: { travelled: boolean; children: ReactNode }) =>
  <span className={travelled ? styles.route : undefined}><Chip size="sm" tone="neutral" variant={travelled ? 'outline' : 'default'} emphasis={travelled}>{children}</Chip></span>

/** A doing sentence stays readable where a route passes beneath the current card. */
export const FlowDoingLine = ({ text }: { text: string }) =>
  <span className="inline-block max-w-full bg-(--hd-background) px-1"><Text role="meta" tone="brand" align="center" truncate className="block" title={text}>{text}</Text></span>
