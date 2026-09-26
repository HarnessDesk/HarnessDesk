import { Button } from '../ui/button'
import { Children, createContext, createElement, isValidElement, useContext, useEffect, useId, useState, type ButtonHTMLAttributes, type ComponentProps, type CSSProperties, type FocusEventHandler, type HTMLAttributes, type KeyboardEventHandler, type ReactNode, type Ref } from 'react'

import { READINESS_LABEL, type Readiness } from '../../lib/readiness'
import { type Tint as AccountTint } from '../../lib/accounts'
import { ArrowLeftIcon, CheckIcon, ChevronIcon, CrossIcon, FilterIcon, SearchIcon, StaleIcon } from '../../components/Icons'
import { HarnessMark } from '../../components/BrandIcons'
import { avatarSrc } from '../../lib/avatars'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { DisclosureChevron } from '../ui/disclosure-chevron'
import { buttonVariants } from '../ui/button'
import { Input } from '../ui/input'
import { dotTone as dotToneClass, inkTint, inkTone, softTint, softTone, type Tint, type Tone } from '../ui/tone'
import { GroupLabel } from '../ui/group-label'
import { useInPageSection } from '../ui/section'
import { ChoiceRow, choiceListClass, dialogStackClass, FieldsetLegend, stepRadio, useDialogForm } from './DialogForm'
import styles from './Settings.module.css'

/**
 * The parts every settings surface is assembled from.
 *
 * These are deliberately thin: a `Row` is a flex line with a title, a
 * description and one control, and it has no opinion about what the control
 * is. What they buy is that the twelve pages of settings cannot drift apart,
 * because there is one place where a row decides how tall it is.
 */

const cx = (...parts: readonly (string | false | undefined)[]): string =>
  parts.filter(Boolean).join(' ')

/* --- readiness ----------------------------------------------------------- */

/**
 * A state as a light. `presence` is a member's light on the corner of its
 * tile — place the dot inside the tile's own positioned wrapper — ringed in
 * the `ground` the tile stands on, so it reads as cut out of the tile rather
 * than stuck on it.
 */
export const Dot = ({
  state,
  tone,
  pulse = false,
  variant = 'default',
  ground = 'background',
  struck = false,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  /** Absent: the neutral light — a state that is neither good nor bad news. */
  state?: Readiness
  /**
   * A judged tone in place of a readiness state — for a dot that must keep
   * its own colour apart from whatever ground it sits on, such as a chip
   * whose dot borrows the pill's ink everywhere else (`Chip`'s `dotTone`).
   * Ignored when `state` is given.
   */
  tone?: Tone
  pulse?: boolean
  variant?: 'default' | 'navigation' | 'presence'
  /** The surface a presence light's tile stands on. */
  ground?: 'background' | 'popover'
  /** Switched off: the light struck through rather than lit or ringed. */
  struck?: boolean
}) => {
  const light = (
    <span
      {...props}
      className={cx(styles.dot, tone && dotToneClass({ tone }), className)}
      data-slot="dot"
      {...(state ? { 'data-state': state } : tone ? { 'data-tone': tone } : {})}
      data-variant={variant}
      {...(variant === 'presence' ? { 'data-ground': ground } : {})}
      {...(pulse ? { 'data-pulse': '' } : {})}
    />
  )
  if (!struck) return light
  return (
    <span className="relative inline-flex size-3 items-center justify-center">
      {light}
      <span className="absolute h-px w-3 bg-current" />
    </span>
  )
}

const SPINNER_TONE: Record<Tone, string> = {
  neutral: 'border-t-(--hd-muted-foreground)',
  brand: 'border-t-(--hd-primary)',
  success: 'border-t-(--hd-success)',
  warning: 'border-t-(--hd-warning)',
  danger: 'border-t-(--hd-danger)',
  info: 'border-t-(--hd-tint-sky-ink)',
}

const SPINNER_SIZE = { sm: 'size-3', default: 'size-4' } as const

export type SpinnerProps = ComponentProps<'span'> & {
  tone?: Tone
  size?: keyof typeof SPINNER_SIZE
}

/** A running operation whose words live beside it. */
export const Spinner = ({ className, tone = 'neutral', size = 'default', ...props }: SpinnerProps) => (
  <span
    data-slot="spinner"
    data-tone={tone}
    data-size={size}
    className={cx(
      'inline-block shrink-0 animate-spin rounded-full border border-(--hd-border-emphasis) motion-reduce:animate-none',
      SPINNER_TONE[tone],
      SPINNER_SIZE[size],
      className,
    )}
    {...props}
  />
)

type ChipBaseProps = {
  label?: ReactNode
  className?: string
  stale?: boolean
  unknown?: boolean
  children?: ReactNode
  /** Always shown. Without one, the chip names itself in full on hover only while it is cut. */
  title?: string
  size?: 'default' | 'sm'
  variant?: 'default' | 'outline'
  /**
   * A count the chip leads with — `count={3}` and `copies differ` read as
   * "3 copies differ". Zero draws nothing: a chip that counts none is a
   * statement that there is nothing to say.
   */
  count?: number
  /** Draw a zero count anyway, for the rare set where zero is the finding. */
  showZero?: boolean
  /**
   * The chip's own dot, given a tone apart from the pill's — for a live
   * indicator that must disagree with its ground on purpose (a running turn
   * stays the one moving mark while the pill around it keeps a calmer
   * reading). Absent, a chip's dot only ever appears for `state`, where it
   * borrows the pill's own ink (`.chip .dot`, below).
   */
  dotTone?: Tone
  /** The dot pulses — a state still in progress. Meaningless without `dotTone`. */
  dotPulse?: boolean
}

export type ChipProps = ChipBaseProps & (
  | { state: Readiness; tone?: never; tint?: never; emphasis?: never }
  | { state?: never; tone: Tone; tint?: never; emphasis?: boolean }
  | { state?: never; tone?: never; tint: Tint; emphasis?: never }
)

const READINESS_TONE: Record<Readiness, Tone> = {
  ready: 'success',
  available: 'neutral',
  unknown: 'neutral',
  signin: 'brand',
  limit: 'warning',
  broken: 'danger',
}

/** Whether any line of a chip's words is cut by its box right now. */
const chipIsCut = (words: Element): boolean =>
  [words, ...Array.from(words.children)].some((node) => node.scrollWidth > node.clientWidth)

/**
 * A compact state, said out loud. Readiness keeps its dot and default word;
 * a judged fact takes a semantic `tone`, while an identity takes a `tint`.
 * The emphatic brand tone marks the current fact in a set. Stale and unknown
 * facts keep those meanings distinct in both ink and their accessible names.
 *
 * **Grammar.** A chip is a mark, not a sentence:
 *
 * - **One line, always.** It never wraps: it stops at its box (at most 240px,
 *   less when its container is narrower), ellipsises, and says itself whole
 *   in `title` while it is cut. A fact that needs two lines is a row's
 *   description, not a chip.
 * - **Stale is marked, never struck.** A stale fact leads with a history
 *   glyph, and the word "stale" is there for a screen reader. A stale *pass*
 *   drops to the neutral fill and muted ink — it no longer vouches for what
 *   is there now. A stale failure or warning keeps its tone: it is still the
 *   last word, and hiding it would make a broken branch read as fine. A
 *   strikethrough reads as "wrong", and a stale fact was right when it was
 *   recorded.
 * - **Zero draws nothing.** Give counts as `count`; zero renders no chip
 *   unless `showZero` says zero is itself the finding.
 * - **A chip earns its place.** It never repeats the row's own title, nor the
 *   state a control beside it already shows (an "Off" chip by an off switch).
 *   A chip that is identical on every row of a group says something about the
 *   group: it belongs in the group's heading, once.
 *
 * **Tone.** `warning` means the person must act now; `danger` means
 * something is broken or will be lost. A default or normal state is
 * `neutral` or has no chip at all, and a stop the person asked for is
 * neutral. Colour on every row is noise that hides the one row that needs
 * someone. See `design/usage.ts`, family `tone`.
 *
 * **`dotTone`.** A chip's dot ordinarily borrows the pill's own ink, so the
 * two never disagree about what they report. The one exception is a live
 * indicator sitting on a pill that must stay calm while the mark itself
 * keeps moving — a running turn, say — and `dotTone` is that dot's own
 * colour, apart from `tone`.
 */
export const Chip = (props: ChipProps) => {
  const {
    label,
    className,
    stale = false,
    unknown = false,
    children,
    title,
    size = 'default',
    variant = 'default',
    count,
    showZero = false,
    dotTone,
    dotPulse = false,
  } = props
  if (count === 0 && !showZero) return null
  const state = props.state
  const tint = props.tint
  const emphasis = props.emphasis
  const requestedTone = props.tone ?? ((stale || unknown) && state ? READINESS_TONE[state] : undefined)
  /* An unknown fact claims no judgement. A stale pass no longer vouches for
     what is there now, so it goes quiet too; a stale failure is still the
     last word on the branch and keeps its tone. */
  const tone = unknown || (stale && requestedTone === 'success') ? 'neutral' : requestedTone
  const said = children ?? label ?? (unknown ? 'Unknown' : state ? READINESS_LABEL[state] : null)
  const counted = count === undefined
    ? said
    : said == null
      ? String(count)
      : typeof said === 'string' || typeof said === 'number'
        ? `${count} ${said}`
        : <>{count} {said}</>
  /* Bare words go in a span of their own, because the ellipsis is drawn by the
     box that holds the text and the words' own box is a flex row. */
  const words = typeof counted === 'string' || typeof counted === 'number' ? <span>{counted}</span> : counted

  return (
    <span
      className={cx(styles.chip, tone && softTone({ tone }), tint && softTint({ tint }), className)}
      data-slot="chip"
      data-size={size}
      data-variant={variant}
      {...(state ? { 'data-state': state } : {})}
      {...(tone ? { 'data-tone': tone } : {})}
      {...(tint ? { 'data-tint': tint } : {})}
      {...(emphasis ? { 'data-emphasis': '' } : {})}
      {...(stale ? { 'data-stale': '' } : {})}
      {...(unknown ? { 'data-unknown': '' } : {})}
      {...(title
        ? { title }
        : {
            onMouseEnter: (event: { readonly currentTarget: HTMLSpanElement }) => {
              const node = event.currentTarget
              const box = node.querySelector('[data-slot="chip-words"]')
              if (box && chipIsCut(box)) node.title = box.textContent ?? ''
              else node.removeAttribute('title')
            },
          })}
    >
      {stale && <StaleIcon size={11} aria-hidden="true" className={styles.chipGlyph} />}
      {state && <Dot state={state} />}
      <span className={styles.chipWords} data-slot="chip-words">
        {/* Inside `chipWords`, not beside it: a readiness dot sits in the
            chip's own outer gap, but this one takes the words' own — the
            gap the hand-drawn status dot always read at, next to its label. */}
        {!state && dotTone && <Dot tone={dotTone} pulse={dotPulse} variant="navigation" />}
        {words}
      </span>
      {stale && <span className="sr-only"> (stale)</span>}
      {unknown && <span className="sr-only"> (unknown)</span>}
    </span>
  )
}

/**
 * A search field: the input with the glass inside it.
 *
 * Every list that grows past a screen gets one of these, and before this each
 * drew its own — some with the glyph, some without, at three heights. One
 * shape, so "this narrows the list below" reads the same on every page.
 */
export const Search = ({
  value,
  onChange,
  placeholder,
  label,
  className,
  autoFocus,
  clear,
  size = 'default',
  icon = 'search',
  title,
  onFocus,
  onBlur,
  onKeyDown,
  inputRef,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  /** For assistive tech; defaults to the placeholder. */
  label?: string
  className?: string
  autoFocus?: boolean
  size?: 'default' | 'compact'
  /** A filter field is still a search input, but its resting glyph says what it narrows. */
  icon?: 'search' | 'filter'
  title?: string
  onFocus?: FocusEventHandler<HTMLInputElement>
  onBlur?: FocusEventHandler<HTMLInputElement>
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>
  /** The owning surface may use the input as its initial focus target. */
  inputRef?: Ref<HTMLInputElement>
  /** An accessible clear action, present only while the field has a value. */
  clear?: { readonly label: string; readonly onClick: () => void }
}) => (
  <span
    className={cx(styles.search, className)}
    data-slot="search"
    data-size={size}
    data-icon={icon}
    {...(clear && value ? { 'data-clear': '' } : {})}
  >
    {icon === 'filter'
      ? <FilterIcon size={size === 'compact' ? 12 : 14} />
      : <SearchIcon size={size === 'compact' ? 12 : 14} />}
    <Input
      ref={inputRef}
      type="search"
      spellCheck={false}
      variant={size === 'compact' ? 'quiet' : 'default'}
      controlSize={size === 'compact' ? 'compact' : 'default'}
      className={size === 'compact' ? styles.searchCompactInput : styles.input}
      placeholder={placeholder}
      aria-label={label ?? placeholder}
      value={value}
      autoFocus={autoFocus}
      title={title}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onChange={(event) => onChange(event.target.value)}
    />
    {clear && value ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={styles.searchClear}
        aria-label={clear.label}
        onClick={clear.onClick}
      >
        <CrossIcon size={12} />
      </Button>
    ) : null}
  </span>
)

/** The inset around a list of destination rows. */
export const NavigationList = ({ className, ...props }: ComponentProps<'div'>) => (
  <div data-slot="navigation-list" className={cx(styles.navigationList, className)} {...props} />
)

/** A keyboard name shown as a physical key rather than explanatory copy. */
export const Keycap = ({ className, ...props }: ComponentProps<'kbd'>) => (
  <kbd data-slot="keycap" className={cx(styles.keycap, className)} {...props} />
)

/** What `Field` hands its control: the id its label points at, and the wiring to its note. */
export interface FieldControl {
  readonly id: string
  readonly 'aria-describedby'?: string
  readonly 'aria-invalid'?: true
}

/**
 * A control with its name over it, for a form in a dialog.
 *
 * A settings *row* names its control in the row; a *form* names it here. The
 * label is a real `<label>`, so clicking the word focuses the field and a
 * screen reader reads them as one thing. The hint is the one line allowed
 * under a field — what to type, or what will happen — and an error takes its
 * place rather than stacking under it. Both are handed to the control as
 * `aria-describedby`, so what the eye reads under the field is what a reader
 * hears with it; the caller spreads the whole object onto the control rather
 * than picking the id out of it, which is how that wiring stops being a thing
 * anyone has to remember.
 *
 * The label sits 6px over its control and the hint 6px under it, one step
 * smaller than the label, so a hint never reads as large as what you type. A
 * field that may be left empty says so with `optional` — a quiet word at the
 * label's end — rather than a qualifier appended to the label, which read as
 * one long label ("Detail optional").
 */
export const Field = ({
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** The field may be left empty: "Optional" at the label's end. */
  optional?: boolean
  /** The control. Spread what it receives: `{(control) => <Input {...control} />}`. */
  children: (control: FieldControl) => ReactNode
}) => {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint
  const name = (
    <label className={styles.formLabel} htmlFor={id}>
      {label}
    </label>
  )
  return (
    <div className={styles.formField} data-slot="form-field">
      {optional ? (
        <span className={styles.formLabelRow}>
          {name}
          <span className={styles.formOptional} data-slot="form-optional">Optional</span>
        </span>
      ) : name}
      {children({
        id,
        ...(note ? { 'aria-describedby': noteId } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
      })}
      {error ? (
        <span id={noteId} className={styles.formError} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span id={noteId} className={styles.formHint}>
          {hint}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Fields, stacked — the body of a dialog that asks for more than one thing.
 * Inside a dialog it keeps the dialog's form rhythm (`DialogForm`): 16px
 * between fields, a legend 6px over its group.
 */
export const FormStack = ({ children }: { children: ReactNode }) => {
  const inDialog = useDialogForm()
  return <div className={inDialog ? dialogStackClass : styles.formStack} data-slot="form-stack">{children}</div>
}

/**
 * The short paragraph that belongs to a group of rows rather than to one of them.
 *
 * Tone follows the one contract (`design/usage.ts`, family `tone`): `warn`
 * only when the person must act now, `bad` only when something is broken or
 * will be lost. Ordinary information — including a stop the person asked for,
 * or a limit that is simply how the thing works — is an untoned note.
 */
export const Note = ({
  children,
  tone,
  ink = 'secondary',
  icon,
  className,
  ...props
}: Omit<ComponentProps<'p'>, 'children'> & {
  children: ReactNode
  tone?: 'warn' | 'bad'
  ink?: 'secondary' | 'muted'
  icon?: ReactNode
  className?: string
}) => {
  /* In a dialog the form stack spaces the note; a page's note carries its
     own margin under it. */
  const inDialog = useDialogForm()
  return (
  /* A note that says something went wrong is spoken, not only shown: it
     arrives after a press, when a reader is listening for the outcome. */
  <p
    className={cx(styles.note, className)}
    data-slot="note"
    {...(inDialog ? { 'data-context': 'dialog' } : {})}
    data-ink={ink}
    {...(icon ? { 'data-icon': '' } : {})}
    {...(tone ? { 'data-tone': tone } : {})}
    {...(tone === 'bad' ? { role: 'alert' } : {})}
    {...props}
  >
    {icon}
    {icon ? <span>{children}</span> : children}
  </p>
  )
}

/** Short supporting facts that belong to a notice or note. */
export const NoteList = ({ className, ...props }: ComponentProps<'ul'>) => (
  <ul data-slot="note-list" className={cx(styles.noteList, className)} {...props} />
)

/**
 * One question, a handful of answers, all of them on screen.
 *
 * The shape is this app's own and stays: a filled track with the chosen answer
 * lifted out of it, which reads as a set in a way a column of radios does not
 * and fits in a settings row's control slot.
 *
 * The *behaviour* is no longer this app's own. It was a row of hand-rolled
 * `role="radio"` buttons, and every one of them was a tab stop &mdash; so a
 * keyboard reaching the fourth choice pressed Tab four times, where a real
 * radio group is one press to enter and arrows to choose. It now sits on
 * `design/ui/radio-group`, the shadcn Base UI build, which brings the roving
 * focus, the arrow keys, Home/End, and the form value with it.
 *
 * The canonical toggle group supplies radio semantics and roving focus while
 * this pattern supplies the settings-specific segmented appearance.
 */
export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { readonly value: T; readonly label: ReactNode }[]
  value: T
  onChange: (next: T) => void
  label: string
}) => (
  <ToggleGroup
    type="single"
    /*
     * `inline-flex gap-0` is not decoration: it is how the look wins.
     *
     * The vendored RadioGroup declares `grid gap-2` and merges a caller's
     * className through `cn`, which is tailwind-merge — and tailwind-merge
     * cannot see a CSS-module class, so `.segmented`'s own
     * `display: inline-flex` survived the merge and then *lost the cascade*:
     * the Tailwind sheet is bundled after every module, so at equal
     * specificity the utility wins. The result was a segmented control that
     * had been rendering as a one-column stack — Theme, Palette, Accent and
     * Corners each a vertical list of buttons instead of a row.
     *
     * Passing the utilities that belong to the same tailwind-merge groups
     * (`display`, `gap`) makes the merge drop `grid gap-2` outright, which is
     * the only fix that does not depend on which sheet loads last.
     */
    className={`inline-flex gap-0 ${styles.segmented}`}
    aria-label={label}
    value={value}
    /* A second press on the chosen segment asks the group to empty itself.
       A segmented control always holds an answer, so that press is ignored
       here rather than by every caller that remembered to. */
    onValueChange={(next) => {
      if (next !== '') onChange(next as T)
    }}
  >
    {options.map((option) => (
      <ToggleGroupItem
        key={option.value}
        value={option.value}
        /*
         * The lifted chosen state lives here, not in the vendored primitive:
         * `design/ui/toggle-group.tsx` stays on the registry's own
         * `bg-accent`/`text-accent-foreground` press (this app's quiet hover
         * wash), so the segment's own three tokens — the card, its hairline
         * shadow, primary ink — ride on this item, where tailwind-merge
         * resolves them against the primitive's. The same merge drops the
         * primitive's `hover:text-muted-foreground`, which would otherwise
         * dim an unchosen segment's label on hover from secondary ink down
         * to tertiary.
         */
        className={`${styles.segItem} hover:text-(--hd-foreground) data-pressed:bg-(--hd-card) data-pressed:text-(--hd-foreground) data-pressed:shadow-(--hd-shadow-sm)`}
      >
        {option.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
)

/* --- page furniture ------------------------------------------------------ */

/** The page's 20px semibold name, matching the wordmark, one line saying what it is for, and anything it acts on. */
export const PageHead = ({
  title,
  blurb,
  actions,
}: {
  title: ReactNode
  blurb?: ReactNode
  actions?: ReactNode
}) => (
  <div className={styles.pageHead}>
    <div className={styles.pageHeadText}>
      <h1 className={styles.pageTitle} data-slot="page-title">{title}</h1>
      {blurb ? <p className={styles.pageBlurb}>{blurb}</p> : null}
    </div>
    {actions ? <div className={styles.pageCtl}>{actions}</div> : null}
  </div>
)

export const SectionHead = ({
  name,
  description,
  action,
  sticky,
  level = 'label',
  className,
}: {
  name: ReactNode
  description?: ReactNode
  action?: ReactNode
  sticky?: boolean
  /** Card groups are labels by default; page bands opt into a real heading. */
  level?: 'label' | 'heading'
  className?: string
}) => {
  /* In a dialog a section is a group of the form, and its head is that
     group's legend: the label's size and weight, attached to the group it
     names instead of floating page furniture's 20px above and 8px over it. */
  const inSection = useInPageSection()
  if (useDialogForm()) return <FieldsetLegend name={name} description={description} action={action} className={className} />
  return (
  <div className={cx(styles.sectionHead, className)} data-section-head="" {...(sticky ? { 'data-sticky': '' } : {})}>
    <div className={styles.sectionHeadText}>
      {level === 'heading' ? (
        <h2 className={styles.sectionName} data-slot="section-name" data-level={level}>{name}</h2>
      ) : (
        <GroupLabel as={inSection ? 'h3' : 'h2'} className={styles.sectionName} data-slot="section-name" data-level={level}>{name}</GroupLabel>
      )}
      {description != null && (
        <span className={styles.sectionDescription} data-slot="section-description">{description}</span>
      )}
    </div>
    {action}
  </div>
  )
}

const TEXT_ROLE = {
  wordmark: 'font-(family-name:--hd-font-heading) text-(length:--hd-heading) leading-(--hd-line-heading) font-semibold tracking-(--hd-tracking-heading)',
  page: 'font-(family-name:--hd-font-heading) text-(length:--hd-heading) leading-(--hd-line-heading) font-semibold tracking-(--hd-tracking-heading)',
  subject: 'text-base leading-(--hd-line) font-medium',
  row: 'text-sm leading-(--hd-line-sm) font-medium',
  navigation: 'text-sm leading-(--hd-line-sm) font-normal',
  muted: 'text-sm leading-(--hd-line-sm) font-normal',
  meta: 'text-xs leading-(--hd-line-xs) font-normal',
  figure:
    'text-(length:--hd-display) leading-(--hd-line-display) font-semibold tracking-[-0.025em] tabular-nums',
  metric: 'text-lg leading-none font-semibold tracking-[-0.015em] tabular-nums',
  value: 'text-base leading-(--hd-line) font-normal tabular-nums',
  /* A sentence at the reading size: `value`'s step and weight, without the
     tabular figures a value lines up by — a reason, a summary, a notice. */
  prose: 'text-base leading-(--hd-line) font-normal',
} as const

const TEXT_ROLE_INK = {
  wordmark: 'text-(--hd-foreground)',
  page: undefined,
  subject: 'text-(--hd-foreground)',
  row: 'text-(--hd-foreground)',
  navigation: 'text-(--hd-foreground)',
  muted: 'text-(--hd-secondary-foreground)',
  meta: 'text-(--hd-muted-foreground)',
  figure: 'text-(--hd-foreground)',
  metric: 'text-(--hd-foreground)',
  value: 'text-(--hd-foreground)',
  prose: 'text-(--hd-foreground)',
} as const

/** A role's own weight, or one of the scale's rungs in its place. */
const TEXT_WEIGHT = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
} as const

const TEXT_INK = {
  primary: 'text-(--hd-foreground)',
  secondary: 'text-(--hd-secondary-foreground)',
  muted: 'text-(--hd-muted-foreground)',
  navigation: 'text-(--hd-sidebar-muted-foreground)',
} as const

export type TextRole = keyof typeof TEXT_ROLE
export type TextProps = Omit<HTMLAttributes<HTMLElement>, 'role'> & {
  as?: 'span' | 'div' | 'p' | 'strong' | 'b' | 'h2' | 'h3' | 'h4' | 'summary' | 'label' | 'li'
  children: ReactNode
  role?: TextRole
  tone?: Tone
  /** Identity colour, kept separate from a tone that judges state. */
  tint?: Tint
  /** Preserve a role's size and weight while selecting one of the three ink tiers. */
  ink?: keyof typeof TEXT_INK
  /**
   * Keep the role's size and ink on a different rung of the weight scale — the
   * words a search matched, lifted inside the line they were found in.
   */
  weight?: keyof typeof TEXT_WEIGHT
  align?: 'start' | 'center' | 'end'
  truncate?: boolean
  /** Put the ellipsis at the beginning, so a path keeps the filename end. */
  truncateFrom?: 'start'
  /** Fade a navigation name at its edge without inventing an ellipsis glyph. */
  fade?: boolean
  numeric?: boolean
  /** A finished item in a checklist: struck through and stepped back, the way a row marked done is. */
  done?: boolean
}

/** The interface's named text roles, including dashboard readouts. */
export const Text = ({
  as = 'span',
  className,
  role = 'muted',
  tone,
  tint,
  ink,
  weight,
  align = 'start',
  truncate,
  truncateFrom,
  fade,
  numeric,
  done,
  children,
  ...props
}: TextProps) =>
  createElement(
    as,
    {
      ...props,
      'data-slot': 'text',
      'data-role': role,
      ...(tone ? { 'data-tone': tone } : {}),
      ...(tint ? { 'data-tint': tint } : {}),
      ...(ink ? { 'data-ink': ink } : {}),
      ...(weight ? { 'data-weight': weight } : {}),
      ...(truncateFrom ? { 'data-truncate-from': truncateFrom } : {}),
      ...(done ? { 'data-done': '' } : {}),
      className: cx(
        weight ? TEXT_ROLE[role].replace(/\bfont-(?:normal|medium|semibold)\b/, TEXT_WEIGHT[weight]) : TEXT_ROLE[role],
        tone
          ? inkTone({ tone })
          : tint
            ? inkTint({ tint })
            : ink
              ? TEXT_INK[ink]
              : TEXT_ROLE_INK[role],
        align === 'center' ? 'text-center' : align === 'end' ? 'text-right' : 'text-left',
        (truncate || truncateFrom) && 'truncate',
        truncateFrom === 'start' && '[direction:rtl] text-left',
        fade && 'overflow-hidden whitespace-nowrap [mask-image:var(--hd-fade)]',
        numeric && 'tabular-nums',
        done && 'line-through opacity-60',
        className,
      ),
    },
    children,
  )

/**
 * The mark at the head of a line of text — a bullet, a task's check.
 *
 * It is set in the text's own role and is one of that text's lines tall (a
 * zero-width space is the line's strut), with the mark centred in it; the
 * row lays the two out on their first baseline, so the mark sits on the
 * middle of the label's first line however many lines the label wraps to and
 * whatever box the label is drawn in. `role` is the label's.
 */
export const TextMark = ({
  role = 'navigation',
  tone,
  className,
  children,
}: {
  role?: TextRole
  /** A mark that judges — a finished step, a failed one — takes its tone's ink; every other mark is muted. */
  tone?: Tone
  className?: string
  children: ReactNode
}) => (
  <Text
    role={role}
    ink="muted"
    {...(tone ? { tone } : {})}
    aria-hidden="true"
    data-mark=""
    className={cx('inline-flex w-3 shrink-0 items-center justify-center', className)}
  >
    {'\u200b'}
    {children}
  </Text>
)

/** The label line above navigation rows, including the controls that act on that list. */
export const NavigationGroupHeader = ({
  label,
  filtering = false,
  inset = 'bar',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  label: ReactNode
  filtering?: boolean
  /**
   * Which row's left column this header's label answers to. `'bar'` — the
   * default — is the sidebar's, whose own filter bar carries a padding this
   * header adds back in (`--hd-bar-ink`). A rail with no bar of its own,
   * such as the app window's nav, reads `'nav'` instead: the row's own
   * `--hd-nav-inset`, the same number `Button size="navigation"` uses.
   */
  inset?: 'bar' | 'nav'
  children?: ReactNode
}) => (
  <div
    {...props}
    data-slot="navigation-group-header"
    {...(filtering ? { 'data-filtering': '' } : {})}
    {...(inset === 'nav' ? { 'data-inset': 'nav' } : {})}
    className={cx(styles.navigationGroupHeader, className)}
  >
    <GroupLabel className={styles.navigationGroupLabel} data-slot="navigation-group-label">{label}</GroupLabel>
    {children}
  </div>
)

/* Inside a card of rows: a `RowChoice` here is a settings row, whatever
   surrounds the card, because a compact radio row reaching past its column
   would be clipped by the card's edge. */
const RowsCardContext = createContext(false)

/**
 * A card of rows. Every settings page is made of these and nothing else.
 *
 * A card with nothing in it is not drawn: an empty list left a stray 2px
 * rule in the middle of a form. Inside a dialog, a card that is a radio group
 * of `RowChoice` rows and nothing else is a `ChoiceList` — no card, and each
 * row a compact radio row. A radio group of anything else (a branch picker of
 * row buttons) keeps its card, its edge and its ground.
 */
export const Rows = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; className?: string }) => {
  const inDialog = useDialogForm()
  const rows = Children.toArray(children)
  if (rows.length === 0) return null
  if (inDialog && props.role === 'radiogroup' && rows.every((row) => isValidElement(row) && row.type === RowChoice)) {
    return <div className={cx(choiceListClass, className)} data-slot="choice-list" {...props}>{children}</div>
  }
  return (
    <div
      className={cx(styles.rows, className)}
      // Not when this card is also a `radiogroup`: outside a dialog that
      // role is a bare wrapper around a list of answers (a branch picker's
      // row buttons, say) rather than the settings card a `SectionHead`'s
      // inset answers to, and `DialogForm.test.tsx` pins that shape as
      // carrying no slot of its own.
      {...(props.role !== 'radiogroup' ? { 'data-slot': 'rows' } : {})}
      {...(inDialog ? { 'data-context': 'dialog' } : {})}
      {...props}
    >
      <RowsCardContext.Provider value>{children}</RowsCardContext.Provider>
    </div>
  )
}

/**
 * A row's second line. A sentence wraps and arrives whole — rule 9's "an
 * earned line has to arrive whole" — so wrapping is the default and the
 * attribute the stylesheet and the tests key on (`data-wrap`) says so. Only a
 * name or a path, whose end is the least of it, gives way on one line.
 */
const RowDesc = ({ truncate, children }: { truncate: boolean; children: ReactNode }) => (
  <span className={cx(styles.rowDesc, truncate && styles.rowDescTruncate)} data-slot="row-desc" data-wrap={truncate ? undefined : 'true'}>
    {children}
  </span>
)

export const Row = ({
  mark,
  title,
  desc,
  truncateDesc = false,
  control,
  className,
  ...props
}: {
  mark?: ReactNode
  title: ReactNode
  desc?: ReactNode
  /** The description is a name or a path, which gives way at its end on one line. A sentence never does: by default it wraps and arrives whole. */
  truncateDesc?: boolean
  control?: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) => (
  <div className={cx(styles.row, className)} data-slot="row" {...props}>
    {mark ? <span className={styles.rowMark}>{mark}</span> : null}
    <span className={styles.rowText}>
      <span className={styles.rowTitle} data-slot="row-title">{title}</span>
      {desc ? <RowDesc truncate={truncateDesc}>{desc}</RowDesc> : null}
    </span>
    {control ? <span className={styles.rowCtl} data-slot="row-ctl">{control}</span> : null}
  </div>
)

/**
 * The drill-in chevron's edge, in px: the one width the row's trailing column
 * of marks is built on. The chevron is drawn at it, and a fold's mark is
 * centred in a box of it, so the two share one column.
 */
const ROW_CHEVRON = 15

/**
 * What a row that opens something also folds in place: the accounts under an
 * agent. The fold is a second target at the row's end, beside the button
 * rather than inside it.
 */
export interface RowFold {
  readonly open: boolean
  readonly onToggle: () => void
  /** The fold's name, which says what it shows or hides. */
  readonly label: string
}

/**
 * The same row, when the whole line opens something.
 *
 * With a `fold`, the row is two targets on one line: the button that opens,
 * and at its end a fold that shows or hides what the row holds, wearing the
 * trailing disclosure mark — down while folded, up while open — so it never
 * reads as the drill-in chevron. The row keeps its inset and its one rule
 * around both: the rule is the pair's, drawn under it unless it is its card's
 * last row, as any row's is.
 *
 * With an `action`, the row's one thing to do stands at its end as a real
 * button beside the opener — Sign in on an agent that is signed out, Retry
 * on one that failed — where the chevron would be. It cannot go in `control`:
 * that sits inside the row's own button, and a button in a button is not a
 * button to anyone using a keyboard or a screen reader. The whole line still
 * opens; the action is the shortcut past the page it opens.
 */
export const RowButton = ({
  mark,
  title,
  desc,
  truncateDesc = false,
  control,
  onClick,
  chevron = true,
  fold,
  action,
  className,
  ...rest
}: {
  mark?: ReactNode
  title: ReactNode
  desc?: ReactNode
  /** The description is a name or a path, which gives way at its end on one line. A sentence never does: by default it wraps and arrives whole. */
  truncateDesc?: boolean
  control?: ReactNode
  onClick: () => void
  chevron?: boolean
  /** A fold at the row's end, beside the button. */
  fold?: RowFold
  /** The row's one action, a `Button`, at its end beside the opener — in the chevron's place. */
  action?: ReactNode
  className?: string
  /*
   * Anything else the caller needs on the button itself — `data-slot`, an
   * `aria-label`, a `title`. Passed through rather than left to the caller
   * to wrap this in a div: the hairlines come from `.rowButton`'s own
   * `border-bottom` and `.row:last-child`, so a wrapper around each row
   * makes every one of them a last child and the list loses every rule.
   */
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'onClick' | 'className'>) => {
  const button = (
    <Button variant="row" size="pattern"
      type="button"
      className={cx(styles.row, styles.rowButton, className)}
      onClick={onClick}
      {...rest}
    >
      {mark ? <span className={styles.rowMark}>{mark}</span> : null}
      <span className={styles.rowText}>
        <span className={styles.rowTitle}>{title}</span>
        {desc ? <RowDesc truncate={truncateDesc}>{desc}</RowDesc> : null}
      </span>
      {/* The control and the chevron are one trailing item, so a row too narrow
          for them beside the title wraps them together and they keep the row's
          end on either line. */}
      {control || (chevron && !fold && !action) ? (
        <span className={styles.rowEnd}>
          {control ? <span className={styles.rowCtl}>{control}</span> : null}
          {chevron && !fold && !action ? (
            <span className={styles.rowChev}>
              <ChevronIcon size={ROW_CHEVRON} />
            </span>
          ) : null}
        </span>
      ) : null}
    </Button>
  )
  if (!fold && !action) return button
  return (
    <div className={styles.rowFolding} data-slot="row-folding" {...(fold?.open ? { 'data-open': '' } : {})}>
      {button}
      {/* The inset around the action is lit with the row under the pointer,
          so a click on it opens the row, as a click on the row does; the
          action's own button is the keyboard's target. */}
      {action ? (
        <span
          className={styles.rowActionEnd}
          data-slot="row-action"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClick()
          }}
        >
          {action}
        </span>
      ) : null}
      {fold ? (
      <span className={styles.rowFoldEnd} style={{ '--row-chevron': `${ROW_CHEVRON}px` } as CSSProperties}>
        <Button
          variant="row"
          size="pattern"
          type="button"
          className={styles.rowFold}
          aria-expanded={fold.open}
          aria-label={fold.label}
          onClick={fold.onToggle}
        >
          <DisclosureChevron open={fold.open} placement="trailing" size="lg" />
        </Button>
      </span>
      ) : null}
    </div>
  )
}

/**
 * A row that is one of several answers to the same question.
 *
 * The tick sits on the left, where a list of choices reads as a list rather
 * than as a column of unrelated switches — and the chosen row is the only one
 * carrying ink, so the answer is findable without reading all of them.
 *
 * Inside a dialog it is a compact radio row instead (`ChoiceRow`): a radio on
 * the title's line and the description under it in the hint step — unless it
 * stands in a card of rows, where it stays the settings row the card is
 * built for.
 */
export const RowChoice = ({
  title,
  desc,
  truncateDesc = false,
  selected,
  tabStop,
  disabled,
  onClick,
}: {
  title: ReactNode
  desc?: ReactNode
  /** The description is a name or a path, which gives way at its end on one line. A sentence never does: by default it wraps and arrives whole. */
  truncateDesc?: boolean
  selected: boolean
  /** The Tab entry when a radio group has no selected answer. */
  tabStop?: boolean
  disabled?: boolean
  onClick: () => void
}) => {
  const inDialog = useDialogForm()
  const inCard = useContext(RowsCardContext)
  if (inDialog && !inCard) {
    return <ChoiceRow title={title} desc={desc} selected={selected} tabStop={tabStop} disabled={disabled} onClick={onClick} />
  }
  return (
  <Button variant="row" size="pattern"
    type="button"
    role="radio"
    aria-checked={selected}
    tabIndex={selected || tabStop ? 0 : -1}
    disabled={disabled}
    className={cx(styles.row, styles.rowButton, styles.rowChoice)}
    onClick={onClick}
    onKeyDown={stepRadio}
  >
    <span className={styles.choiceMark}>{selected ? <CheckIcon size={15} /> : null}</span>
    <span className={styles.rowText}>
      <span className={styles.rowTitle}>{title}</span>
      {desc ? <RowDesc truncate={truncateDesc}>{desc}</RowDesc> : null}
    </span>
  </Button>
  )
}

/* --- drill-down ---------------------------------------------------------- */

/**
 * The way back out of a detail page. It names where it goes rather than saying
 * "Back", so it reads the same whether you arrived from the list or from a
 * link somewhere else.
 */
export const BackLink = ({ to, onClick }: { to: string; onClick: () => void }) => (
  <Button variant="ghost" size="sm" type="button" className={styles.backLink} onClick={onClick}>
    <ArrowLeftIcon size={14} />
    {to}
  </Button>
)

export const DetailHead = ({
  mark,
  name,
  owner,
  blurb,
  actions,
}: {
  mark?: ReactNode
  name: ReactNode
  /** Who it belongs to — the agent behind an account, the author of a plugin. */
  owner?: ReactNode
  blurb?: ReactNode
  actions?: ReactNode
}) => (
  <div className={styles.detailHead}>
    {mark}
    <div className={styles.detailText}>
      <div className={styles.detailName}>
        <h1 className={styles.detailTitle} data-slot="detail-title">{name}</h1>
        {/* A text owner — a place, a path — gives way at its end; a chip or any
            other element is a mark and stays whole, so the name wraps first. */}
        {owner ? (
          <span className={styles.detailOwner} data-owner={typeof owner === 'string' ? 'text' : 'mark'}>{owner}</span>
        ) : null}
      </div>
      {blurb ? <p className={styles.detailBlurb}>{blurb}</p> : null}
    </div>
    {actions ? <div className={styles.detailCtl}>{actions}</div> : null}
  </div>
)

/**
 * A person's face: the picture they chose, or the house mark when they have
 * not.
 *
 * It is the avatar above — the plate and the hairline the account marks wear —
 * squared, because a person is not an account: account marks are rings, the
 * avatars were drawn as squared tiles (`assets/avatars/README.md`), and the
 * seat reads as "you, and the pen you will pick up" because the two differ.
 * The corner steps up the radius scale with the size, so the seat's 24px and
 * the profile page's 44px read as one object at two sizes.
 *
 * Without a `size` it fills the box it is put in and takes that box's corner:
 * a room's message rows draw a tile for every sender, and a person's face
 * belongs in the same tile as the agents' marks beside it.
 *
 * `avatar` is whatever the profile stores. Anything this build does not ship —
 * a face a later build added, a picture it keeps — draws the house mark. It is
 * not dropped: keeping what it cannot draw is the profile's job
 * (`lib/profile.ts`), so a later build finds it where it left it.
 */
export const Face = ({
  avatar,
  size,
  className,
}: {
  readonly avatar: unknown
  /** The tile's edge in px; absent, the tile fills its box. */
  readonly size?: number
  readonly className?: string
}) => {
  const src = avatarSrc(avatar)
  return (
    <span
      className={className ? `${styles.avatar} ${className}` : styles.avatar}
      data-shape="square"
      {...(size === undefined
        ? { 'data-fill': '' }
        : { 'data-size': size > 32 ? 'm' : 's', style: { width: size, height: size } })}
      aria-hidden="true"
    >
      {src ? (
        <img className={styles.avatarPicture} src={src} alt="" draggable={false} />
      ) : (
        // 0.44 is the ratio the seat always drew at: an 11px mark in its
        // 24px disc, 13px in the menu's 30px one. A filling tile sizes the
        // mark in the stylesheet, by the same ratio.
        <HarnessMark size={size === undefined ? 16 : Math.round(size * 0.44)} />
      )}
    </span>
  )
}

/**
 * One line of text that ellipsises, and says itself whole on hover — only
 * while it is cut. A title on text that is not cut repeats what you are
 * reading and hides the tooltip of whatever holds it (the seat's "New
 * sessions run as …"), so the title is decided as the pointer arrives, from
 * whether the text overflows its box right then. The ellipsis is the
 * caller's class: `overflow: hidden`, `text-overflow: ellipsis`, `nowrap`.
 */
export const Clipped = ({ className, children }: { readonly className?: string; readonly children: ReactNode }) => (
  <span
    className={className}
    onMouseEnter={(event) => {
      const node = event.currentTarget
      if (node.scrollWidth > node.clientWidth) node.title = node.textContent ?? ''
      else node.removeAttribute('title')
    }}
  >
    {children}
  </span>
)

export const PageDescription = ({ children }: { children: ReactNode }) => (
  <p className={styles.pageBlurb}>{children}</p>
)

/**
 * A row's answer in words. A wrapped text answer takes its line under the
 * title; a `numeric` one — money, a count — is compact: it keeps the row's
 * end on tabular figures, where a column of them lines up by place.
 */
export const RowValue = ({ children, className, numeric = false }: { children: ReactNode; className?: string; numeric?: boolean }) => (
  <span className={cx(styles.rowFixed, numeric && 'tabular-nums', className)} {...(numeric ? { 'data-numeric': '' } : {})}>{children}</span>
)

/**
 * A value typed into a settings row — a port, a count, a daily cap — as
 * compact as the switch beside it, and applied the way the switch is.
 *
 * Settings pages never show a Save button: a switch applies as it is flipped,
 * and this applies when the typing is done — on Enter, or when focus leaves
 * the field for somewhere else in the window. Escape puts back what is stored
 * (and only then lets Escape close the window around it), and says so with
 * `onRestore`. Nothing is sent while the text still reads as stored, so
 * tabbing through the page writes nothing.
 *
 * Leaving the window is not finishing: Cmd-Tab away mid-number blurs the
 * field, and applying "1" of "10" there would be a guess. So a blur while the
 * document has lost focus keeps the draft, and the next real blur or Enter
 * applies it. A field that goes away mid-edit (the page closing) drops its
 * draft rather than applying it on the way out: an unmount cannot show a
 * refusal, and a write the person cannot see fail is worse than one they did
 * not finish.
 *
 * The row owns the name (`aria-label` repeats the row's title for a reader),
 * the field owns only the value, at the width of the value it holds: a
 * five-digit port in a 715px field said the field was the subject of the page.
 * A value the caller refuses stays in the field, marked `invalid`, with the
 * caller's `Note` saying why, so the person can mend what they typed rather
 * than type it again.
 */
export const RowInput = ({
  value,
  onCommit,
  invalid = false,
  width = 'number',
  onRestore,
  className,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'defaultValue' | 'onChange' | 'onBlur' | 'onKeyDown' | 'aria-invalid'> & {
  /** What is stored now. The field shows it again whenever it changes. */
  value: string
  /** The finished edit. Called only when it differs from `value`. */
  onCommit: (next: string) => void
  /** The caller refused the last commit; its `Note` says why (link it with `aria-describedby`). */
  invalid?: boolean
  /** Escape put the stored value back: the caller's refusal no longer applies. */
  onRestore?: () => void
  /** `number` for a port, a count or an amount; `text` for a short word. */
  width?: 'number' | 'text'
  'aria-label': string
}) => {
  const [draft, setDraft] = useState(value)
  // What is stored moved (a commit landed, or another window wrote it): the
  // field follows it rather than holding an edit of a value that is gone.
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <Input
      {...props}
      data-slot="row-input"
      value={draft}
      {...(invalid ? { 'aria-invalid': true } : {})}
      className={cx(width === 'number' ? 'w-24' : 'w-48', className)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        // The window lost focus, not the field: keep the draft for later.
        if (!document.hasFocus()) return
        commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape' && (draft !== value || invalid)) {
          event.preventDefault()
          event.stopPropagation()
          setDraft(value)
          onRestore?.()
        }
      }}
    />
  )
}

export const RowMark = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.rowMark, className)}>{children}</span>
)

export const DetailMark = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.detailMark, className)}>{children}</span>
)

/**
 * Code and output in the code face.
 *
 * `block` is text set as a block — laid out line for line, at the code step
 * and its leading, inset from the box it fills: a file's text standing in a
 * card where an editor would be (a plugin panel's code block), a raw envelope
 * a message was sent in, the detail of an Agent that could not be read.
 * `ground="muted"` gives the block a plate of its own, on the muted ground at
 * the small corner and in the secondary ink, for one that sits among
 * sentences rather than filling a card. `wrap` folds long lines instead of
 * scrolling them, for text read as prose rather than aligned as code.
 */
export const CodeText = ({
  as = 'span',
  size = 'default',
  block = false,
  ground = 'none',
  wrap = false,
  spaced = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'span' | 'code' | 'pre'
  size?: 'default' | 'inherit'
  block?: boolean
  /** A block's own plate; only a `block` takes one. */
  ground?: 'none' | 'muted'
  /** Fold a block's long lines; only a `block` takes it. */
  wrap?: boolean
  /** Space the characters, for a code read aloud and typed elsewhere — a one-time code. */
  spaced?: boolean
  children: ReactNode
}) => createElement(as, {
  ...props,
  'data-slot': 'code-text',
  'data-size': size,
  ...(block ? { 'data-block': '' } : {}),
  ...(block && ground !== 'none' ? { 'data-ground': ground } : {}),
  ...(block && wrap ? { 'data-wrap': '' } : {}),
  ...(spaced ? { 'data-spaced': '' } : {}),
  className: cx(styles.mono, size === 'inherit' && styles.monoInherit, block && styles.monoBlock, className),
}, children)

/** Initials inside a row's neutral mark. They identify the thing without becoming its name. */
export const Monogram = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span data-slot="monogram" className={cx(styles.monogram, className)}>{children}</span>
)

/** Compact facts whose dot separators belong to the role, not to each caller. */
export const MetaList = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span data-slot="meta-list" className={cx(styles.metaList, className)}>{children}</span>
)

export const AccountMark = ({
  as = 'span',
  size,
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, 'data-tint'> & {
  as?: 'span' | 'button'
  /** `dot` is the account's colour alone, for a line whose owner is already drawn. */
  size?: 'sm' | 'lg' | 'dot'
  /** One of the accounts' own tints — never a design-system tint at large: #991 once shipped teal and orange, neither of which is a tint an account can wear. */
  'data-tint'?: AccountTint
  children: ReactNode
}) => createElement(as, {
  ...props,
  ...(as === 'button' ? { type: 'button' } : {}),
  className: cx(styles.avatar, as === 'button' && styles.avatarButton, size === 'sm' && styles.avatarSm, size === 'lg' && styles.avatarLg, size === 'dot' && styles.avatarDot, className),
}, children)

export const FileButton = ({
  label,
  accept,
  disabled,
  onFile,
}: {
  label: ReactNode
  accept?: string
  disabled?: boolean
  onFile: (file: File) => void
}) => (
  <label
    className={buttonVariants({ variant: 'secondary', size: 'sm' })}
    aria-disabled={disabled || undefined}
  >
    {label}
    <Input
      type="file"
      accept={accept}
      hidden
      disabled={disabled}
      onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) onFile(file)
      }}
    />
  </label>
)
