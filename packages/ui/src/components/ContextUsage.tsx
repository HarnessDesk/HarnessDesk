import { useMemo, type CSSProperties, type ReactNode } from 'react'

import type { UsageWindow } from '@harnessdesk/protocol'

import { cacheHealthOf } from '../lib/cache-health'
import {
  describeContext,
  formatCost,
  formatTokens,
  type ContextComposition,
  type ContextFill,
} from '../lib/context-usage'
import { describeLimits, formatReset } from '../lib/limits'
import { useActiveSession, useRuntime, useSnapshot } from '../state/context'
import styles from './ContextUsage.module.css'
import { Menu, MenuLabel, MenuNote } from './Menu'
import { Popover } from './Popover'

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

  if (!view) return null
  const { fill, last, total, cost, delegated, composition } = view

  return (
    <Popover title={view.title} drop="up" align="right" label={<Ring fill={fill} size={16} label={view.title} />}>
      {(close) => (
        <Menu close={close}>
          <div className={styles.panel}>
            <div className={styles.head}>
              <Ring fill={fill} size={28} />
              <div className={styles.headText}>
                <div className={styles.headline} data-tone={fill?.tone ?? 'none'}>
                  {fill ? `${fill.percent}% full` : 'Context window unknown'}
                </div>
                <div className={styles.subline}>
                  {fill
                    ? `${formatTokens(fill.used)} of ${formatTokens(fill.size)} tokens in context`
                    : `${agent} does not report its context window size.`}
                </div>
              </div>
            </div>
            {fill && (
              <div
                className={styles.track}
                role="progressbar"
                aria-valuenow={fill.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Context window"
              >
                <div className={styles.fill} data-tone={fill.tone} style={{ width: `${Math.max(1, fill.percent)}%` }} />
              </div>
            )}

            {composition && <Composition composition={composition} />}

            {last && (
              <>
                <MenuLabel>Last turn</MenuLabel>
                {/* The hint is a cache *verdict* where the agent reports both
                    halves, and the share it can vouch for where it reports
                    only hits — see `lib/cache-health.ts` for why those must
                    not read the same. */}
                <Row
                  label="Input"
                  value={formatTokens(last.inputTokens)}
                  hint={cache ? <span title={cache.title}>{cache.label}</span> : null}
                />
                <Row label="Output" value={formatTokens(last.outputTokens)} />
                {last.reasoningOutputTokens > 0 && <Row label="Thinking" value={formatTokens(last.reasoningOutputTokens)} />}
              </>
            )}

            {(total || cost) && (
              <>
                <MenuLabel>This session</MenuLabel>
                {total && (
                  <Row
                    label="Tokens"
                    value={formatTokens(total.totalTokens)}
                    hint={total.outputTokens > 0 ? `${formatTokens(total.outputTokens)} out` : null}
                  />
                )}
                {cost && <Row label="Cost" value={formatCost(cost)} />}
                {/* Delegated spend is a *split* of the tokens above and never
                    an addition to them: the runtimes that attribute a child's
                    usage have already folded it into the session's own
                    counts. Shown as a share so a session that handed most of
                    its work away says so. */}
                {delegated && total && (
                  <Row
                    label="Delegated"
                    value={formatTokens(delegated.totalTokens)}
                    hint={
                      total.totalTokens > 0
                        ? `${Math.round((delegated.totalTokens / total.totalTokens) * 100)}% of the session`
                        : null
                    }
                  />
                )}
              </>
            )}

            {limits && limits.windows.length > 0 && (
              <>
                <MenuLabel>Plan usage</MenuLabel>
                {limits.windows.map((window) => (
                  <WindowRow key={window.label} window={window} />
                ))}
              </>
            )}

            <MenuNote>Reported by {agent}.</MenuNote>
          </div>
        </Menu>
      )}
    </Popover>
  )
}

/**
 * What the context is made of, for the agents that can say.
 *
 * Deliberately *not* drawn as segments of the ring above it. The ring is
 * anchored to what the provider charged; these are the agent's own pricing of
 * the parts, and when they are approximate the two do not reconcile — the
 * agent said so, and stacking one inside the other would quietly overrule it.
 * So this is its own bar, sharing the parts against each other, with its own
 * total and its own footnote naming who measured it.
 */
const Composition = ({ composition }: { composition: ContextComposition }) => (
  <>
    <MenuLabel>What is in context</MenuLabel>
    <div className={styles.stack} aria-hidden>
      {composition.segments.map((segment, index) => (
        <span
          key={segment.id}
          className={styles.stackPart}
          data-part={index % 4}
          style={{ width: `${Math.max(1, segment.percent)}%` }}
        />
      ))}
    </div>
    {composition.segments.map((segment, index) => (
      <div key={segment.id} className={styles.row}>
        <span className={styles.swatch} data-part={index % 4} aria-hidden />
        <span className={styles.rowLabel}>
          {segment.label}
          {segment.count != null && <span className={styles.rowCount}> ({segment.count})</span>}
        </span>
        <span className={styles.rowValue}>{formatTokens(segment.tokens)}</span>
        <span className={styles.rowHint}>{segment.percent}%</span>
      </div>
    ))}
    <MenuNote>
      {composition.approximate
        ? `${formatTokens(composition.measured)} tokens, as ${composition.source} estimates them — a composition, not a total, so it will not match the figure above.`
        : `${formatTokens(composition.measured)} tokens, measured by ${composition.source}.`}
    </MenuNote>
  </>
)

/**
 * The ring itself: a conic gradient over a masked disc. Drawn in CSS rather
 * than as vector markup because it is a meter, not a glyph — the icon rule
 * keeps every glyph in Icons.tsx, and a meter that animates between values
 * wants a custom property, not a path.
 */
export const Ring = ({ fill, size, label }: { fill: ContextFill | null; size: number; label?: string }) => {
  const style = {
    '--ring-size': `${size}px`,
    '--ring-fill': `${(fill?.ratio ?? 0) * 100}%`,
    '--ring-stroke': `${Math.max(2, Math.round(size / 8))}px`,
  } as CSSProperties
  return (
    <span
      className={styles.ring}
      data-tone={fill?.tone ?? 'none'}
      {...(fill ? {} : { 'data-unknown': '' })}
      style={style}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  )
}

const Row = ({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode | null }) => (
  <div className={styles.row}>
    <span className={styles.rowLabel}>{label}</span>
    <span className={styles.rowValue}>{value}</span>
    {hint != null && hint !== '' && <span className={styles.rowHint}>{hint}</span>}
  </div>
)

/**
 * One rolling allowance: what is left, and when it refills.
 *
 * **Left, not used.** This panel spent a release saying `24% used` under a
 * bar that filled as the allowance drained, two inches from a sidebar footer
 * saying `76% left` and a header strip whose bar emptied — one account,
 * three surfaces, two scales and two directions. The rule the rest of the app
 * keeps is that a meter's fill *is* what remains, so a full bar always means
 * "plenty" wherever a reader meets one; this row now keeps it too.
 */
const WindowRow = ({ window }: { window: UsageWindow }) => {
  const left = Math.min(100, Math.max(0, Math.round(100 - window.usedPercent)))
  const tone = left <= 0 ? 'bad' : left < 20 ? 'warn' : 'good'
  const reset = formatReset(window.resetsAt)
  return (
    <div className={styles.window}>
      <Row label={window.label} value={`${left}% left`} hint={reset ? `resets ${reset}` : null} />
      <div
        className={styles.track}
        role="progressbar"
        aria-valuenow={left}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${window.label} — what is left`}
      >
        {/* No minimum width: a spent window has nothing left to draw, and a
            1% sliver on an exhausted plan is the one reading this bar must
            not give. */}
        <div className={styles.fill} data-tone={tone} style={{ width: `${left}%` }} />
      </div>
    </div>
  )
}
