import { useMemo } from 'react'

import { cacheHealthOf } from '../lib/cache-health'
import {
  describeContext,
  formatCost,
  formatTokens,
  type ContextFill,
} from '../lib/context-usage'
import { describeLimits, formatReset } from '../lib/limits'
import { formatResetCountdown } from '../lib/usage'
import { useActiveSession, useRuntime, useSnapshot } from '../state/context'
import { ComposerTrack } from './ComposerControls'
import { Button, InfoCard, ProgressRing, type InfoFact, type Tone } from '../design'

/**
 * The ring beside the model: how full the context window is, for whichever
 * agent this pane is talking to. Design: docs/context-usage.md.
 *
 * Everything drawn here is read off `session.usage` and `snapshot.limits`.
 * The ring divides `contextUsed` by `contextWindow` and nothing else — the
 * runtime decided what "in context" means for its model, and an agent that
 * did not say gets a dashed ring and a sentence, never an estimate.
 */
export const ContextUsage = () => {
  const session = useActiveSession()
  const snapshot = useSnapshot()
  // The ring is about the session, so the runtime is the session's own —
  // the pane's runtime is the same thing inside a pane, and outside one it
  // would be the active runtime, which may not be who this session talks to.
  const paneRuntime = useRuntime()
  const runtime = (session && snapshot.runtimes.find((entry) => entry.id === session.runtime)) || paneRuntime
  const agent = runtime.presentation.name
  const usage = session?.usage
  const view = useMemo(() => describeContext(usage, agent), [usage, agent])
  const cache = useMemo(() => cacheHealthOf(view?.last), [view])

  // Plan windows are the active runtime's, like the sidebar footer: a pane on
  // another agent must not show this agent's allowance as its own.
  const metered = runtime.capabilities.metered && runtime.id === snapshot.activeRuntime
  const limits = metered ? describeLimits(snapshot.limits) : null

  if (!view) return <ComposerTrack name="context"><InfoCard title="No usage yet" side="top" align="end" trigger={<Button variant="ghost" size="icon-sm" data-info-source="context"><Ring fill={null} size={16} label="No usage yet" /></Button>} rows={[{ id: 'usage', label: 'Usage', value: 'No usage yet' }]} /></ComposerTrack>
  const { fill, last, total, cost, delegated, composition } = view

  const facts: InfoFact[] = [
    ...(fill ? [{ id: 'context', label: 'Context', value: `${formatTokens(fill.used)} of ${formatTokens(fill.size)} tokens` }, { id: 'full', label: 'Full', value: `${fill.percent}%` }] : [{ id: 'context', label: 'Context', value: 'Window size unknown', note: `${agent} does not report its context window size.` }]),
    ...(last ? [{ id: 'input', label: 'Input', value: formatTokens(last.inputTokens), note: cache?.label }, { id: 'output', label: 'Output', value: formatTokens(last.outputTokens) }, ...(last.reasoningOutputTokens > 0 ? [{ id: 'thinking', label: 'Thinking', value: formatTokens(last.reasoningOutputTokens) }] : [])] : []),
    ...(total ? [{ id: 'tokens', label: 'Session tokens', value: formatTokens(total.totalTokens), note: total.outputTokens > 0 ? `${formatTokens(total.outputTokens)} out` : undefined }] : []),
    ...(cost ? [{ id: 'cost', label: 'Cost', value: formatCost(cost) }] : []),
    ...(delegated && total ? [{ id: 'delegated', label: 'Delegated', value: formatTokens(delegated.totalTokens), note: total.totalTokens > 0 ? `${Math.round(delegated.totalTokens / total.totalTokens * 100)}% of the session` : undefined }] : []),
    ...(composition ? composition.segments.map(segment => ({ id: `composition:${segment.id}`, label: segment.label, value: `${formatTokens(segment.tokens)} · ${segment.percent}%`, note: segment.count != null ? `${segment.count} items` : undefined })) : []),
    ...(limits ? limits.windows.map(window => {
      const left = Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)))
      return { id: `limit:${window.label}`, label: window.label, tone: toneOf(left <= 0 ? 'bad' : left < 20 ? 'warn' : 'good'), value: `${left}% left`, note: window.resetsAt === null ? undefined : `${formatResetCountdown(window.resetsAt - Date.now())} · resets ${formatReset(window.resetsAt)}` }
    }) : []),
  ]
  const compositionData = composition ? {
    label: 'What is in context', source: composition.source,
    measured: formatTokens(composition.measured), approximate: composition.approximate,
    parts: composition.segments.map(segment => ({ id: segment.id, label: segment.label, value: segment.percent, reading: formatTokens(segment.tokens), meta: `${segment.percent}%`, detail: segment.count != null ? `(${segment.count})` : undefined })),
  } : undefined
  const contextMeter = fill ? { label: 'Context window', value: fill.percent, max: 100, tone: toneOf(fill.tone), reading: `${fill.percent}% full` } : undefined
  return <ComposerTrack name="context"><InfoCard title={view.title} side="top" align="end"
    trigger={<Button variant="ghost" size="icon-sm" data-info-source="context"><Ring fill={fill} size={16} label={view.title} /></Button>}
    rows={facts} meter={contextMeter} composition={compositionData} notes={[...(cache ? [cache.title] : []), `Reported by ${agent}.`]} /></ComposerTrack>
}

/**
 * The ring itself: a conic gradient over a masked disc. Drawn in CSS rather
 * than as vector markup because it is a meter, not a glyph — the icon rule
 * keeps every glyph in Icons.tsx, and a meter that animates between values
 * wants a custom property, not a path.
 */
const toneOf = (tone: ContextFill['tone'] | 'none' | undefined): Tone =>
  tone === 'warn' ? 'warning' : tone === 'bad' ? 'danger' : tone === 'good' ? 'brand' : 'neutral'

export const Ring = ({ fill, size, label }: { fill: ContextFill | null; size: number; label?: string }) => (
  <ProgressRing
    value={fill ? fill.percent : null}
    size={size}
    tone={toneOf(fill?.tone)}
    {...(label ? { label } : {})}
  />
)
