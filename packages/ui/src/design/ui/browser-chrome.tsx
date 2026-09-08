import type * as React from 'react'

import { ArrowLeftIcon, ArrowRightIcon, RefreshIcon, ShieldIcon, AlertIcon } from '@/components/Icons'
import { cn } from '@/lib/utils'
import { softTone } from './tone'

/**
 * The bar above a web page an agent is driving.
 *
 * Not a browser toolbar copied for the look of it. Two of its parts are load
 * bearing in a way an ordinary browser's are not, because the person reading
 * this pane is not the one who typed the address:
 *
 *   The origin is the fact.     What matters is *which site is this*, and it is
 *                               set apart from the rest of the URL so a long
 *                               path cannot push it out of view. An agent that
 *                               followed a link somewhere unexpected has to be
 *                               visible at a glance, not by reading a 200
 *                               character string to its end.
 *
 *   The lock is a claim, so     `insecure` is loud and `secure` is quiet — the
 *   only trouble speaks.        same rule the transcript holds. A green padlock
 *                               on every page trains people to stop seeing it,
 *                               which is precisely how the missing one gets
 *                               missed.
 *
 * The address is not editable here by default. The pane is a view of what the
 * agent did; typing into it is a separate, deliberate act the host grants.
 */

const BrowserChrome = ({
  className,
  url,
  origin,
  secure = true,
  loading,
  onBack,
  onForward,
  onReload,
  actions,
  ...props
}: Omit<React.ComponentProps<'div'>, 'children'> & {
  /** The path and query — everything after the origin. */
  url: React.ReactNode
  origin: React.ReactNode
  secure?: boolean
  loading?: boolean
  onBack?: () => void
  onForward?: () => void
  onReload?: () => void
  actions?: React.ReactNode
}) => (
  <div
    data-slot="browser-chrome"
    className={cn(
      'flex shrink-0 items-center gap-1 border-b border-(--hd-border) px-1.5 py-1.5',
      className,
    )}
    {...props}
  >
    {[
      { label: 'Back', icon: <ArrowLeftIcon />, action: onBack },
      { label: 'Forward', icon: <ArrowRightIcon />, action: onForward },
      { label: 'Reload', icon: <RefreshIcon />, action: onReload },
    ].map((one) => (
      <button
        key={one.label}
        type="button"
        aria-label={one.label}
        onClick={one.action}
        disabled={!one.action}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-(--hd-radius-sm) text-(--hd-muted-foreground) hover:bg-(--hd-hover) hover:text-(--hd-foreground) disabled:opacity-40 disabled:hover:bg-transparent [&_svg]:size-3.5"
      >
        {one.icon}
      </button>
    ))}

    <div
      className={cn(
        'relative flex h-(--hd-control-h-sm) min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-full bg-(--hd-muted) px-2',
        !secure && 'ring-1 ring-(--hd-danger) ring-inset',
      )}
    >
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 text-xs [&_svg]:size-3',
          secure
            ? 'text-(--hd-muted-foreground)'
            : cn('rounded-full px-1.5 font-medium', softTone({ tone: 'danger' })),
        )}
      >
        {secure ? <ShieldIcon aria-label="Secure" /> : <AlertIcon aria-label="Not secure" />}
        {!secure && 'Not secure'}
      </span>
      {/* The origin in full contrast, the rest quiet — the reader's question is
          "which site", and the path is context for the answer. */}
      <span className="min-w-0 truncate font-(family-name:--hd-font-code) text-xs">
        <span className="text-(--hd-foreground)">{origin}</span>
        <span className="text-(--hd-muted-foreground)">{url}</span>
      </span>
      {loading && (
        /* A determinate bar would be a lie — the pane does not know how much of
           a page is left. A sliver that travels says "still going" honestly. */
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
        >
          <span className="block h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] bg-(--hd-primary)" />
        </span>
      )}
    </div>

    {actions != null && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
  </div>
)

export { BrowserChrome }
