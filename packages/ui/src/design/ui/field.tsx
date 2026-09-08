import type * as React from 'react'
import { useId } from 'react'

import { cn } from '@/lib/utils'
import { Label } from './label'
import { Separator } from './separator'

/**
 * A control, and the three things that can be said around it.
 *
 * Label, hint, error — and the wiring that makes a screen reader read them as
 * one thing rather than as four unrelated strings near each other. That wiring
 * is the reason this exists: `aria-describedby` is the sort of attribute that
 * gets written on the first form of a project and on none of the next twelve.
 * Here it is not a thing anyone remembers to do.
 *
 * The error replaces the hint rather than stacking under it. Two lines of grey
 * and red under one input is the reader's problem to untangle at the exact
 * moment they are already stuck, and the hint said what to type — which they
 * now know, because they typed it and it was wrong.
 *
 * `required` draws the mark the whole industry draws and gives it a real name
 * for assistive tech, rather than an asterisk that reads out as "star".
 */

type FieldProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  label: React.ReactNode
  /** Receives the id to put on the control, plus the describedby wiring. */
  children: (control: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': true | undefined
  }) => React.ReactNode
  hint?: React.ReactNode
  error?: React.ReactNode
  required?: boolean
  /** Label beside the control instead of above it, for a dense settings form. */
  layout?: 'stacked' | 'inline'
}

const Field = ({
  className,
  label,
  children,
  hint,
  error,
  required,
  layout = 'stacked',
  ...props
}: FieldProps) => {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint

  return (
    <div
      data-slot="field"
      className={cn(
        layout === 'inline'
          ? 'grid grid-cols-[minmax(0,10rem)_1fr] items-baseline gap-x-4 gap-y-1'
          : 'flex flex-col gap-1.5',
        className,
      )}
      {...props}
    >
      <Label htmlFor={id} className="gap-1">
        {label}
        {required && (
          <span className="text-(--hd-danger-ink)" aria-hidden>
            *
          </span>
        )}
        {required && <span className="sr-only">(required)</span>}
      </Label>
      <div className="flex min-w-0 flex-col gap-1.5">
        {children({
          id,
          'aria-describedby': note ? noteId : undefined,
          'aria-invalid': error ? true : undefined,
        })}
        {note != null && (
          <p
            id={noteId}
            /* The ink, not the fill: `--hd-danger` measures 3.7:1 on a card and
               this line is 12px. See the state-ink block in tokens.css. */
            className={cn(
              'text-xs',
              error ? 'text-(--hd-danger-ink)' : 'text-(--hd-muted-foreground)',
            )}
          >
            {note}
          </p>
        )}
      </div>
    </div>
  )
}

/*
 * `InputGroup`, `InputAffix` and `InputBare` used to live here: a start affix,
 * an end affix and a bare input, which covers a prefix and a unit and nothing
 * else. They were replaced by the registry's version (design/ui/input-group.tsx)
 * in the adoption pass, which brings the two arrangements this app kept
 * needing and could not express &mdash; an addon above or below the field
 * rather than beside it, and a real button welded to the edge that is still
 * separately clickable.
 */

/*
 * The layer above a single field, adopted from shadcn/ui's `field`.
 *
 * This is the half of their component ours did not have, and the half every
 * settings page in this app has been faking: a set of fields that belong
 * together, with a name, and a rule between sets. Twelve settings surfaces draw
 * that grouping by hand today, each with its own gap.
 *
 * Their `Field` and ours answer different questions, so both are kept and
 * neither was replaced. Theirs lays out a row and leaves the wiring to the
 * caller; ours hands the control its `id` and `aria-describedby` so the wiring
 * cannot be forgotten. The parts below are the ones that were missing.
 */

/**
 * A set of fields that belong together, with a name on it.
 *
 * A real `<fieldset>`, so a screen reader announces the legend before each
 * control inside it — which is the entire reason to group fields, and is lost
 * the moment it is a `<div>` with a heading above.
 */
const FieldSet = ({ className, ...props }: React.ComponentProps<'fieldset'>) => (
  <fieldset
    data-slot="field-set"
    className={cn('flex min-w-0 flex-col gap-4 border-0 p-0', className)}
    {...props}
  />
)

/**
 * The set's name.
 *
 * `variant="label"` for a set nested inside another, where a full-size legend
 * would out-shout the section it sits under.
 */
const FieldLegend = ({
  className,
  variant = 'legend',
  ...props
}: React.ComponentProps<'legend'> & { variant?: 'legend' | 'label' }) => (
  <legend
    data-slot="field-legend"
    data-variant={variant}
    className={cn(
      'mb-1 p-0 font-medium',
      variant === 'legend' ? 'text-base' : 'text-sm',
      className,
    )}
    {...props}
  />
)

/** Several fields, or several sets, at one rhythm. */
const FieldGroup = ({ className, ...props }: React.ComponentProps<'div'>) => (
  <div
    data-slot="field-group"
    className={cn('flex w-full min-w-0 flex-col gap-4', className)}
    {...props}
  />
)

/**
 * A rule between two groups, optionally with a word on it.
 *
 * The word sits on the card's own ground rather than in a gap, so the rule
 * reads as passing behind it &mdash; which is what makes "or" look like a
 * choice between the two halves rather than a third thing.
 */
const FieldSeparator = ({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) => (
  <div
    data-slot="field-separator"
    data-content={children ? '' : undefined}
    className={cn('relative -my-1 h-4 text-xs', className)}
    {...props}
  >
    <Separator className="absolute inset-x-0 top-1/2" />
    {children != null && (
      <span className="relative mx-auto block w-fit bg-(--hd-card) px-2 text-(--hd-muted-foreground)">
        {children}
      </span>
    )}
  </div>
)

/**
 * A field's explanation, for the layout where `Field`'s own hint does not fit
 * &mdash; a set-level note, or a row whose control is the label.
 */
const FieldDescription = ({ className, ...props }: React.ComponentProps<'p'>) => (
  <p
    data-slot="field-description"
    className={cn('text-xs text-(--hd-muted-foreground)', className)}
    {...props}
  />
)

/**
 * What went wrong, announced.
 *
 * `role="alert"` because an error that appears after a submit is news nobody
 * asked for and a screen reader will otherwise never mention. Takes either a
 * child or a list of messages; a single message renders as a line rather than
 * as a one-item list, because a bullet on its own reads as an outline.
 */
const FieldError = ({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<'div'> & { errors?: readonly { message?: string }[] }) => {
  const messages = (errors ?? []).filter((one) => one?.message)
  if (children == null && messages.length === 0) return null
  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('text-xs text-(--hd-danger-ink)', className)}
      {...props}
    >
      {children ??
        (messages.length === 1 ? (
          messages[0]?.message
        ) : (
          <ul className="ml-4 flex list-disc flex-col gap-0.5">
            {messages.map((one, index) => (
              <li key={index}>{one.message}</li>
            ))}
          </ul>
        ))}
    </div>
  )
}

export {
  Field,
  FieldSet,
  FieldLegend,
  FieldGroup,
  FieldSeparator,
  FieldDescription,
  FieldError,
}
