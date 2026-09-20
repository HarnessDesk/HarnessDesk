import { Button } from '../ui/button'
import { createElement, useId, type ButtonHTMLAttributes, type ComponentProps, type FocusEventHandler, type HTMLAttributes, type KeyboardEventHandler, type ReactNode, type Ref } from 'react'

import { isReachProblem, type ReachState } from '@harnessdesk/protocol'

import { READINESS_LABEL, type Readiness } from '../../lib/readiness'
import { AlertIcon, ArrowLeftIcon, CheckIcon, ChevronIcon, CrossIcon, DiffIcon, FilterIcon, SearchIcon } from '../../components/Icons'
import { HarnessMark } from '../../components/BrandIcons'
import { avatarSrc } from '../../lib/avatars'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { buttonVariants } from '../ui/button'
import { Input } from '../ui/input'
import { IconTile } from '../ui/icon-tile'
import { inkTint, inkTone, softTint, softTone, type Tint, type Tone } from '../ui/tone'
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

export const Dot = ({ state, pulse = false, variant = 'default', className, ...props }: HTMLAttributes<HTMLSpanElement> & { state: Readiness; pulse?: boolean; variant?: 'default' | 'navigation' }) => (
  <span {...props} className={cx(styles.dot, className)} data-slot="dot" data-state={state} data-variant={variant} {...(pulse ? { 'data-pulse': '' } : {})} />
)

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

const STATE_STRIP_FILL: Record<Readiness, string> = {
  ready: 'bg-(--hd-success)',
  signin: 'bg-(--hd-primary)',
  limit: 'bg-(--hd-warning)',
  broken: 'bg-(--hd-danger)',
  available: 'bg-(--hd-border-emphasis)',
}

/** A compact whole-roster reading: one segment per agent, in readiness order. */
export const StateStrip = ({ states, className }: { states: readonly Readiness[]; className?: string }) => {
  const counts = new Map<Readiness, number>()
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1)
  const named = ([
    ['ready', 'ready'],
    ['signin', 'needs sign-in'],
    ['limit', 'at a limit'],
    ['broken', 'unavailable'],
    ['available', 'not added'],
  ] as const)
    .flatMap(([state, label]) => counts.has(state) ? [`${counts.get(state)} ${label}`] : [])
    .join(', ')
  return (
    <span
      data-slot="state-strip"
      role="img"
      aria-label={`${states.length} agents: ${named}`}
      className={cx('flex gap-1', className)}
    >
      {states.map((state, index) => (
        <span
          key={`${state}:${index}`}
          data-state={state}
          aria-hidden="true"
          className={cx('h-1 flex-1 rounded-(--hd-radius-2xs)', STATE_STRIP_FILL[state])}
        />
      ))}
    </span>
  )
}

/** One operation or account state: judged mark, title, and the reason beneath it. */
export const StatusSummary = ({
  icon,
  title,
  description,
  tone = 'neutral',
  className,
}: {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  tone?: Tone
  className?: string
}) => (
  <div data-slot="status-summary" data-tone={tone} className={cx('flex items-center gap-3', className)}>
    <IconTile size="default" shape="round" tone={tone}>{icon}</IconTile>
    <span className="flex min-w-0 flex-col gap-px">
      <span data-slot="status-summary-title" className="text-base font-medium text-(--hd-foreground)">
        {title}
      </span>
      {description != null ? (
        <span data-slot="status-summary-description" className="text-sm leading-(--hd-line-sm) text-(--hd-secondary-foreground)">
          {description}
        </span>
      ) : null}
    </span>
  </div>
)

/** The horizontal title band of an account-access sheet. */
export const AccessHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="access-header"
    className={cx('flex shrink-0 items-center gap-2.5 border-b border-(--hd-border) px-4 py-4', className)}
    {...props}
  />
)

/** The roster column of an account-access sheet. */
export const AccessRail = ({ className, ...props }: ComponentProps<'nav'>) => (
  <nav
    data-slot="access-rail"
    className={cx('flex min-h-0 flex-col border-r border-(--hd-border) bg-(--hd-sidebar-plate) max-[720px]:border-r-0 max-[720px]:border-b', className)}
    {...props}
  />
)

export const AccessRailHeader = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="access-rail-header"
    className={cx('shrink-0 border-b border-(--hd-border) p-3', className)}
    {...props}
  />
)

export const AccessRailList = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="access-rail-list"
    className={cx('min-h-0 flex-1 overflow-y-auto p-2', className)}
    {...props}
  />
)

export const AccessRailFooter = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="access-rail-footer"
    className={cx('shrink-0 border-t border-(--hd-border) px-3 py-2.5', className)}
    {...props}
  />
)

/** The scrolled work pane beside an access roster. */
export const AccessDetail = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="access-detail"
    className={cx('flex min-h-0 flex-col overflow-y-auto px-6 pb-6 pt-5', className)}
    {...props}
  />
)

/** A labelled path or consequence in an account-access flow. */
export const AccessFact = ({
  label,
  value,
  children,
  className,
}: {
  label: ReactNode
  value?: ReactNode
  children?: ReactNode
  className?: string
}) => (
  <div data-slot="access-fact" className={cx('mb-4 flex max-w-130 flex-col items-start gap-1.5', className)}>
    <Text role="muted">{label}</Text>
    {value != null ? (
      <CodeText
        as="code"
        className="max-w-full select-all rounded-(--hd-radius-sm) bg-(--hd-muted) px-2 py-1 text-sm leading-(--hd-line-sm) text-(--hd-secondary-foreground) [overflow-wrap:anywhere]"
      >
        {value}
      </CodeText>
    ) : null}
    {children != null ? <Text role="muted">{children}</Text> : null}
  </div>
)

/** A one-time code: verbatim, selectable, and visually separate from prose. */
export const AccessCode = ({ className, ...props }: ComponentProps<'div'>) => (
  <div
    data-slot="access-code"
    className={cx(
      'select-all rounded-(--hd-radius) bg-(--hd-muted) p-4 text-center font-mono text-(length:--hd-heading) leading-(--hd-line-heading) font-semibold tracking-[0.18em]',
      className,
    )}
    {...props}
  />
)

const REACH_INK: Partial<Record<ReachState, string>> = {
  hollow: 'text-(--hd-warning-ink)',
  rejected: 'text-(--hd-warning-ink)',
  differs: 'text-(--hd-warning-ink)',
  unscanned: 'text-(--hd-warning-ink)',
  unhostable: 'text-(--hd-muted-foreground)',
}

/** One state in the Library matrix, distinguished by shape before colour. */
export const LibraryReachMark = ({
  state,
  label,
  placement = 'inline',
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  state: ReachState
  label: string
  placement?: 'inline' | 'cell'
}) => {
  let mark: ReactNode
  if (state === 'hollow' || state === 'rejected') mark = <AlertIcon size={13} />
  else if (state === 'differs') mark = <DiffIcon size={13} />
  else if (state === 'unhostable') mark = <CrossIcon size={13} />
  else if (state === 'unscanned') mark = <span className="size-2 rounded-full border border-(--hd-warning-ink)" />
  else if (state === 'stale') mark = <span className="size-1.5 rounded-full bg-(--hd-muted-foreground)" />
  else if (state === 'reaches') mark = <span className="size-1.5 rounded-full bg-(--hd-success)" />
  else if (state === 'off') {
    mark = (
      <span className="relative inline-flex size-3 items-center justify-center">
        <span className="size-1.5 rounded-full bg-(--hd-muted-foreground)" />
        <span className="absolute h-px w-3 bg-(--hd-muted-foreground)" />
      </span>
    )
  } else mark = <span className="h-px w-2 bg-(--hd-border-emphasis)" />

  return (
    <span
      {...props}
      data-slot="library-reach-mark"
      data-state={state}
      data-placement={placement}
      role="img"
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center ${placement === 'cell' ? 'h-(--hd-control-h) w-full' : 'size-3.5'} ${REACH_INK[state] ?? 'text-(--hd-muted-foreground)'} ${className ?? ''}`}
    >
      {mark}
    </span>
  )
}

/** An agent's identity mark, with reach expressed only by the plate around it. */
export const LibraryReachFace = ({
  state,
  label,
  children,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  state: ReachState
  label: string
  children?: ReactNode
}) => (
  <span
    {...props}
    data-slot="skill-reach"
    data-state={state}
    {...(isReachProblem(state) ? { 'data-problem': '' } : {})}
    role="img"
    aria-label={label}
    className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-(--hd-muted-foreground) opacity-40 data-[state=reaches]:bg-(--hd-muted) data-[state=reaches]:text-(--hd-foreground) data-[state=reaches]:opacity-100 data-[problem]:bg-(--hd-warning-dim) data-[problem]:text-(--hd-warning-ink) data-[problem]:opacity-100 ${className ?? ''}`}
  >
    {children}
  </span>
)

type LibraryOperationState = 'planned' | 'refuse' | 'done' | 'failed' | 'skipped'

/** The list's floor keeps a one-change plan reading as a composed preview. */
export const LibraryOperationList = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    {...props}
    data-slot="library-operation-list"
    role="list"
    className={`flex min-h-18 flex-col ${className ?? ''}`}
  >
    {children}
  </div>
)

/** One planned operation or result, using the glyph the Library already taught. */
export const LibraryOperationMark = ({ state }: { state: LibraryOperationState }) => {
  const mark =
    state === 'refuse' ? <AlertIcon size={13} />
      : state === 'done' ? <CheckIcon size={13} />
        : state === 'failed' ? <CrossIcon size={13} />
          : state === 'skipped' ? <span className="opacity-60">·</span>
            : <span className="size-1.5 rounded-full bg-current opacity-70" />
  return (
    <span
      data-slot="library-operation-mark"
      data-state={state}
      aria-hidden="true"
      className="inline-flex w-4 shrink-0 items-center justify-center self-center text-(--hd-muted-foreground) data-[state=done]:text-(--hd-success) data-[state=failed]:text-(--hd-warning-ink) data-[state=refuse]:text-(--hd-warning-ink)"
    >
      {mark}
    </span>
  )
}

type ChipBaseProps = {
  label?: ReactNode
  className?: string
  stale?: boolean
  unknown?: boolean
  children?: ReactNode
  title?: string
  size?: 'default' | 'sm'
  variant?: 'default' | 'outline'
}

export type ChipProps = ChipBaseProps & (
  | { state: Readiness; tone?: never; tint?: never; emphasis?: never }
  | { state?: never; tone: Tone; tint?: never; emphasis?: boolean }
  | { state?: never; tone?: never; tint: Tint; emphasis?: never }
)

const READINESS_TONE: Record<Readiness, Tone> = {
  ready: 'success',
  available: 'neutral',
  signin: 'brand',
  limit: 'warning',
  broken: 'danger',
}

/**
 * A compact state, said out loud. Readiness keeps its dot and default word;
 * a judged fact takes a semantic `tone`, while an identity takes a `tint`.
 * The emphatic brand tone marks the current fact in a set. Stale and unknown
 * facts keep those meanings distinct in both ink and their accessible names.
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
  } = props
  const state = props.state
  const tint = props.tint
  const emphasis = props.emphasis
  const requestedTone = props.tone ?? ((stale || unknown) && state ? READINESS_TONE[state] : undefined)
  const tone = unknown || (stale && requestedTone === 'success') ? 'neutral' : requestedTone
  const words = children ?? label ?? (unknown ? 'Unknown' : state ? READINESS_LABEL[state] : null)

  return (
    <span
      className={cx(styles.chip, tone && softTone({ tone }), tint && softTint({ tint }), className)}
      data-size={size}
      data-variant={variant}
      {...(state ? { 'data-state': state } : {})}
      {...(tone ? { 'data-tone': tone } : {})}
      {...(tint ? { 'data-tint': tint } : {})}
      {...(emphasis ? { 'data-emphasis': '' } : {})}
      {...(stale ? { 'data-stale': '' } : {})}
      {...(unknown ? { 'data-unknown': '' } : {})}
      {...(title ? { title } : {})}
    >
      {state && <Dot state={state} />}
      <span className={styles.chipWords} data-slot="chip-words">{words}</span>
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

/** The exact part of a search result that matched the query. */
export const SearchMatch = ({ className, ...props }: ComponentProps<'mark'>) => (
  <mark data-slot="search-match" className={cx(styles.searchMatch, className)} {...props} />
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
 */
export const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** The control. Spread what it receives: `{(control) => <Input {...control} />}`. */
  children: (control: FieldControl) => ReactNode
}) => {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint
  return (
    <div className={styles.formField} data-slot="form-field">
      <label className={styles.formLabel} htmlFor={id}>
        {label}
      </label>
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

/** Fields, stacked — the body of a dialog that asks for more than one thing. */
export const FormStack = ({ children }: { children: ReactNode }) => (
  <div className={styles.formStack}>{children}</div>
)

/** The short paragraph that belongs to a group of rows rather than to one of them. */
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
}) => (
  /* A note that says something went wrong is spoken, not only shown: it
     arrives after a press, when a reader is listening for the outcome. */
  <p
    className={cx(styles.note, className)}
    data-slot="note"
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
    onValueChange={(next) => onChange(next as T)}
  >
    {options.map((option) => (
      <ToggleGroupItem
        key={option.value}
        value={option.value}
        className={styles.segItem}
      >
        {option.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
)

/* --- page furniture ------------------------------------------------------ */

/** The page's name, one line saying what it is for, and anything it acts on. */
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
      <div className={styles.pageTitle} data-slot="page-title">{title}</div>
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
}) => (
  <div className={cx(styles.sectionHead, className)} {...(sticky ? { 'data-sticky': '' } : {})}>
    <div className={styles.sectionHeadText}>
      {createElement(
        level === 'heading' ? 'h2' : 'span',
        { className: styles.sectionName, 'data-slot': 'section-name', 'data-level': level },
        name,
      )}
      {description != null && (
        <span className={styles.sectionDescription} data-slot="section-description">{description}</span>
      )}
    </div>
    {action}
  </div>
)

const TEXT_ROLE = {
  wordmark: 'text-(length:--hd-heading) leading-(--hd-line-heading) font-semibold tracking-[-0.01em]',
  page: 'text-(length:--hd-title) leading-(--hd-line-title) font-normal tracking-[-0.02em]',
  subject: 'text-base leading-(--hd-line) font-medium',
  row: 'text-sm leading-(--hd-line-sm) font-medium',
  navigation: 'text-sm leading-(--hd-line-sm) font-normal',
  muted: 'text-sm leading-(--hd-line-sm) font-normal',
  meta: 'text-xs leading-(--hd-line-xs) font-normal',
  figure:
    'text-(length:--hd-display) leading-(--hd-line-display) font-semibold tracking-[-0.025em] tabular-nums',
  metric: 'text-lg leading-none font-semibold tracking-[-0.015em] tabular-nums',
  value: 'text-base leading-(--hd-line) font-normal tabular-nums',
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
} as const

const TEXT_INK = {
  primary: 'text-(--hd-foreground)',
  secondary: 'text-(--hd-secondary-foreground)',
  muted: 'text-(--hd-muted-foreground)',
  navigation: 'text-(--hd-sidebar-muted-foreground)',
} as const

export type TextRole = keyof typeof TEXT_ROLE
export type TextProps = Omit<HTMLAttributes<HTMLElement>, 'role'> & {
  as?: 'span' | 'div' | 'p' | 'strong' | 'h2' | 'h4' | 'summary' | 'label' | 'li'
  children: ReactNode
  role?: TextRole
  tone?: Tone
  /** Identity colour, kept separate from a tone that judges state. */
  tint?: Tint
  /** Preserve a role's size and weight while selecting one of the three ink tiers. */
  ink?: keyof typeof TEXT_INK
  align?: 'start' | 'center' | 'end'
  truncate?: boolean
  /** Put the ellipsis at the beginning, so a path keeps the filename end. */
  truncateFrom?: 'start'
  /** Fade a navigation name at its edge without inventing an ellipsis glyph. */
  fade?: boolean
  numeric?: boolean
}

/** The interface's named text roles, including dashboard readouts. */
export const Text = ({
  as = 'span',
  className,
  role = 'muted',
  tone,
  tint,
  ink,
  align = 'start',
  truncate,
  truncateFrom,
  fade,
  numeric,
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
      ...(truncateFrom ? { 'data-truncate-from': truncateFrom } : {}),
      className: cx(
        TEXT_ROLE[role],
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
        className,
      ),
    },
    children,
  )

/** The label line above navigation rows, including the controls that act on that list. */
export const NavigationGroupHeader = ({
  label,
  filtering = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  label: ReactNode
  filtering?: boolean
  children?: ReactNode
}) => (
  <div
    {...props}
    data-slot="navigation-group-header"
    {...(filtering ? { 'data-filtering': '' } : {})}
    className={cx(styles.navigationGroupHeader, className)}
  >
    <span className={styles.navigationGroupLabel} data-slot="navigation-group-label">{label}</span>
    {children}
  </div>
)

/** A card of rows. Every settings page is made of these and nothing else. */
export const Rows = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; className?: string }) => (
  <div className={cx(styles.rows, className)} {...props}>{children}</div>
)

export const Row = ({
  mark,
  title,
  desc,
  control,
  className,
  ...props
}: {
  mark?: ReactNode
  title: ReactNode
  desc?: ReactNode
  control?: ReactNode
  className?: string
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>) => (
  <div className={cx(styles.row, className)} {...props}>
    {mark ? <span className={styles.rowMark}>{mark}</span> : null}
    <span className={styles.rowText}>
      <span className={styles.rowTitle}>{title}</span>
      {desc ? <span className={styles.rowDesc}>{desc}</span> : null}
    </span>
    {control ? <span className={styles.rowCtl}>{control}</span> : null}
  </div>
)

/** The same row, when the whole line opens something. */
export const RowButton = ({
  mark,
  title,
  desc,
  control,
  onClick,
  chevron = true,
  className,
  ...rest
}: {
  mark?: ReactNode
  title: ReactNode
  desc?: ReactNode
  control?: ReactNode
  onClick: () => void
  chevron?: boolean
  className?: string
  /*
   * Anything else the caller needs on the button itself — `data-slot`, an
   * `aria-label`, a `title`. Passed through rather than left to the caller
   * to wrap this in a div: the hairlines come from `.rowButton`'s own
   * `border-bottom` and `.row:last-child`, so a wrapper around each row
   * makes every one of them a last child and the list loses every rule.
   */
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'onClick' | 'className'>) => (
  <Button variant="row" size="content"
    type="button"
    className={cx(styles.row, styles.rowButton, className)}
    onClick={onClick}
    {...rest}
  >
    {mark ? <span className={styles.rowMark}>{mark}</span> : null}
    <span className={styles.rowText}>
      <span className={styles.rowTitle}>{title}</span>
      {desc ? <span className={styles.rowDesc}>{desc}</span> : null}
    </span>
    {control ? <span className={styles.rowCtl}>{control}</span> : null}
    {chevron ? (
      <span className={styles.rowChev}>
        <ChevronIcon size={15} />
      </span>
    ) : null}
  </Button>
)

/**
 * A row that is one of several answers to the same question.
 *
 * The tick sits on the left, where a list of choices reads as a list rather
 * than as a column of unrelated switches — and the chosen row is the only one
 * carrying ink, so the answer is findable without reading all of them.
 */
export const RowChoice = ({
  title,
  desc,
  wrapDesc = false,
  selected,
  disabled,
  onClick,
}: {
  title: ReactNode
  desc?: ReactNode
  /** A consequence in a narrow choice arrives whole rather than ellipsised. */
  wrapDesc?: boolean
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) => (
  <Button variant="row" size="content"
    type="button"
    role="radio"
    aria-checked={selected}
    tabIndex={selected ? 0 : -1}
    disabled={disabled}
    className={cx('w-full min-w-0', styles.row, styles.rowButton, styles.rowChoice)}
    onClick={onClick}
    onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
      const group = event.currentTarget.closest('[role="radiogroup"]')
      if (!group) return
      const choices = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
      const current = choices.indexOf(event.currentTarget)
      if (current < 0 || choices.length === 0) return

      const next = event.key === 'Home'
        ? choices[0]
        : event.key === 'End'
          ? choices.at(-1)
          : choices[(current + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + choices.length) % choices.length]
      if (!next) return
      event.preventDefault()
      next.focus()
      next.click()
    }}
  >
    <span className={styles.choiceMark}>{selected ? <CheckIcon size={15} /> : null}</span>
    <span className={styles.rowText}>
      <span className={styles.rowTitle}>{title}</span>
      {desc ? <span className={cx(styles.rowDesc, wrapDesc && styles.rowDescWrap)} data-wrap={wrapDesc || undefined}>{desc}</span> : null}
    </span>
  </Button>
)

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
        {name}
        {owner ? <span className={styles.detailOwner}>{owner}</span> : null}
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

export const RowValue = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.rowFixed, className)}>{children}</span>
)

export const RowMark = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.rowMark, className)}>{children}</span>
)

export const DetailMark = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.detailMark, className)}>{children}</span>
)

export const SectionToggle = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.sectionToggle, className)}>{children}</span>
)

export const CodeText = ({
  as = 'span',
  size = 'default',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'span' | 'code' | 'pre'
  size?: 'default' | 'inherit'
  children: ReactNode
}) => createElement(as, {
  ...props,
  'data-slot': 'code-text',
  'data-size': size,
  className: cx(styles.mono, size === 'inherit' && styles.monoInherit, className),
}, children)

/** Initials inside a row's neutral mark. They identify the thing without becoming its name. */
export const Monogram = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span data-slot="monogram" className={cx(styles.monogram, className)}>{children}</span>
)

/** Compact facts whose dot separators belong to the role, not to each caller. */
export const MetaList = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span data-slot="meta-list" className={cx(styles.metaList, className)}>{children}</span>
)

export const WireText = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span className={cx(styles.wire, className)}>{children}</span>
)

export const AccountMark = ({
  as = 'span',
  size,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'span' | 'button'
  size?: 'sm' | 'lg'
  children: ReactNode
}) => createElement(as, {
  ...props,
  ...(as === 'button' ? { type: 'button' } : {}),
  className: cx(styles.avatar, size === 'sm' && styles.avatarSm, size === 'lg' && styles.avatarLg, className),
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
