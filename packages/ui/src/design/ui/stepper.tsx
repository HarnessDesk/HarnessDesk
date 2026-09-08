import type * as React from 'react'

import { cn } from '@/lib/utils'
import { CheckIcon } from '@/components/Icons'

/**
 * A journey with a known length.
 *
 * Worth drawing only when all three are true: the steps are ordered, the reader
 * cannot skip them, and knowing how many remain changes whether they start. A
 * stepper over a two-field form is decoration; over a five-step migration it is
 * the difference between "I'll do it later" and "I'll do it now".
 *
 * Done steps show a tick rather than their number. The number was only ever a
 * position, and once a step is behind you its position is not the fact you want
 * — whether it is safely done is. This also makes progress legible at a glance
 * from the shape alone, without counting.
 *
 * The connector is a line between steps, not a border on them, so a step's own
 * width never changes the run of the track.
 */

export type Step = {
  label: React.ReactNode
  /** A word on what this step covers. Optional, and usually unnecessary. */
  hint?: React.ReactNode
}

type StepperProps = Omit<React.ComponentProps<'ol'>, 'children'> & {
  steps: Step[]
  /** Zero-based. Everything before it is done, everything after is ahead. */
  current: number
  orientation?: 'horizontal' | 'vertical'
}

const Stepper = ({ className, steps, current, orientation = 'horizontal', ...props }: StepperProps) => (
  <ol
    data-slot="stepper"
    className={cn(orientation === 'horizontal' ? 'flex items-start' : 'flex flex-col', className)}
    {...props}
  >
    {steps.map((step, index) => {
      const state = index < current ? 'done' : index === current ? 'current' : 'ahead'
      const last = index === steps.length - 1
      return (
        <li
          key={index}
          data-state={state}
          aria-current={state === 'current' ? 'step' : undefined}
          className={cn(
            'flex min-w-0',
            orientation === 'horizontal'
              ? cn('flex-col items-center gap-1.5 text-center', !last && 'flex-1')
              : 'gap-3 pb-4 last:pb-0',
          )}
        >
          <div
            className={cn(
              'flex items-center',
              orientation === 'horizontal' ? 'w-full' : 'flex-col self-stretch',
            )}
          >
            {/* A spacer mirroring the connector, so the marker sits on the
                track's centre line rather than half a marker to its left. */}
            {orientation === 'horizontal' && (
              <span aria-hidden className={cn('h-px flex-1', index === 0 && 'invisible')} style={{ background: 'var(--hd-border)' }} />
            )}
            <span
              className={cn(
                'inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums [&_svg]:size-3.5',
                state === 'done' && 'border-transparent bg-(--hd-primary) text-(--hd-primary-foreground)',
                /* Border keeps the fill colour; the number takes the ink.
                   `--hd-primary` on `--hd-primary-muted` does not clear 4.5:1
                   at this size, which is why `--hd-primary-ink` exists. */
                state === 'current' &&
                  'border-(--hd-primary) bg-(--hd-primary-muted) text-(--hd-primary-ink)',
                state === 'ahead' &&
                  'border-(--hd-border-strong) bg-(--hd-card) text-(--hd-muted-foreground)',
              )}
            >
              {state === 'done' ? <CheckIcon aria-label="Done" /> : index + 1}
            </span>
            {orientation === 'horizontal' && (
              <span aria-hidden className={cn('h-px flex-1', last && 'invisible')} style={{ background: 'var(--hd-border)' }} />
            )}
            {orientation === 'vertical' && !last && (
              <span aria-hidden className="w-px flex-1 bg-(--hd-border)" />
            )}
          </div>
          <div className={cn('min-w-0', orientation === 'vertical' && 'pb-2')}>
            <div
              className={cn(
                'truncate text-xs',
                state === 'ahead' ? 'text-(--hd-muted-foreground)' : 'font-medium',
              )}
            >
              {step.label}
            </div>
            {step.hint != null && (
              <div className="truncate text-xs text-(--hd-muted-foreground)">{step.hint}</div>
            )}
          </div>
        </li>
      )
    })}
  </ol>
)

export { Stepper }
