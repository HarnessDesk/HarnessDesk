import { Button } from '../ui/button'
import { createElement, useId, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'

import { READINESS_LABEL, type Readiness } from '../../lib/readiness'
import { ArrowLeftIcon, CheckIcon, ChevronIcon, SearchIcon } from '../../components/Icons'
import { HarnessMark } from '../../components/BrandIcons'
import { avatarSrc } from '../../lib/avatars'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { buttonVariants } from '../ui/button'
import { Input } from '../ui/input'
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

export const Dot = ({ state, className }: { state: Readiness; className?: string }) => (
  <span className={cx(styles.dot, className)} data-state={state} />
)

/**
 * The state, said out loud. Pass `label` only to say something more specific
 * than the state's own name — "Out of weekly credit until Thursday" rather
 * than "Limit reached".
 */
export const Chip = ({
  state,
  label,
  className,
}: {
  state: Readiness
  label?: string
  className?: string
}) => (
  <span className={cx(styles.chip, className)} data-state={state}>
    <Dot state={state} />
    {label ?? READINESS_LABEL[state]}
  </span>
)

/**
 * A search field: the input with the glass inside it.
 *
 * Every list on a settings page that grows past a screen gets one of these,
 * and before this each drew its own — some with the glyph, some without, at
 * three heights. One shape, so "this narrows the list below" reads the same
 * on every page.
 */
export const Search = ({
  value,
  onChange,
  placeholder,
  label,
  className,
  autoFocus,
}: {
  value: string
  onChange: (next: string) => void
  placeholder: string
  /** For assistive tech; defaults to the placeholder. */
  label?: string
  className?: string
  autoFocus?: boolean
}) => (
  <span className={cx(styles.search, className)}>
    <SearchIcon size={14} />
    <Input
      type="search"
      spellCheck={false}
      className={styles.input}
      placeholder={placeholder}
      aria-label={label ?? placeholder}
      value={value}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  </span>
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
    <div className={styles.formField}>
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
export const Note = ({ children, tone }: { children: ReactNode; tone?: 'warn' | 'bad' }) => (
  /* A note that says something went wrong is spoken, not only shown: it
     arrives after a press, when a reader is listening for the outcome. */
  <p
    className={styles.note}
    {...(tone ? { 'data-tone': tone } : {})}
    {...(tone === 'bad' ? { role: 'alert' } : {})}
  >
    {children}
  </p>
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

export const SectionHead = ({ name, action }: { name: ReactNode; action?: ReactNode }) => (
  <div className={styles.sectionHead}>
    <span className={styles.sectionName}>{name}</span>
    {action}
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
}: {
  mark?: ReactNode
  title: ReactNode
  desc?: ReactNode
  control?: ReactNode
  className?: string
}) => (
  <div className={cx(styles.row, className)}>
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
  selected,
  disabled,
  onClick,
}: {
  title: ReactNode
  desc?: ReactNode
  selected: boolean
  disabled?: boolean
  onClick: () => void
}) => (
  <Button variant="row" size="content"
    type="button"
    role="radio"
    aria-checked={selected}
    disabled={disabled}
    className={cx(styles.row, styles.rowButton, styles.rowChoice)}
    onClick={onClick}
  >
    <span className={styles.choiceMark}>{selected ? <CheckIcon size={15} /> : null}</span>
    <span className={styles.rowText}>
      <span className={styles.rowTitle}>{title}</span>
      {desc ? <span className={styles.rowDesc}>{desc}</span> : null}
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
  className,
  children,
  ...props
}: HTMLAttributes<HTMLElement> & {
  as?: 'span' | 'code' | 'pre'
  children: ReactNode
}) => createElement(as, { ...props, className: cx(styles.mono, className) }, children)

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
