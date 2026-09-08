import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'

import { Radio } from '@base-ui/react/radio'

import { READINESS_LABEL, type Readiness } from '../../lib/readiness'
import { ArrowLeftIcon, CaretIcon, CheckIcon, ChevronIcon, SearchIcon } from '../../components/Icons'
import { RadioGroup } from '../ui/radio-group'
import { Switch as UiSwitch, SwitchShape } from '../ui/switch'
import styles from './Kit.module.css'

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

/** Present when true, absent when false — the shape React needs for `[data-x]`. */
const flag = (on: boolean | undefined): Record<string, string> => (on ? { 'data-on': '' } : {})

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

/* --- controls ------------------------------------------------------------ */

/**
 * One vocabulary, spoken by both buttons.
 *
 * The two spellings agreed about every *number* — `button.test.tsx` has pinned
 * that from both sides for a while — and disagreed about every *word*, which
 * turned out to matter more. Measured across the app: `primary` here was
 * `default` there, `quiet` was `ghost`, `danger` was `destructive`, an
 * unqualified `Btn` came out grey while an unqualified `Button` came out ink,
 * and `outline` existed **only** in the shadcn layer.
 *
 * That last one is not a naming quibble, it is why the app looks the way it
 * does. A screen built on Kit could not draw a bordered action even if it
 * wanted one, so it fell back to the grey default — which is how three
 * "add a thing" buttons in one settings window ended up ink, grey and
 * outline. The screens were not careless; the vocabulary was short of a word.
 *
 * So the names are shadcn's, because that is the wider vocabulary and the one
 * a vendored component already speaks, and the three Kit names stay as
 * aliases: ~90 call sites say `primary`, `quiet` or `danger` today and none of
 * them is wrong. `secondary` is the unqualified look, named so a reader can
 * write what they mean instead of relying on an absence.
 */
export type BtnVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'destructive'
  /* The older spellings, kept working. Same paint, same tokens. */
  | 'primary'
  | 'quiet'
  | 'danger'

/** The alias table, in one place rather than in a `data-variant` per call. */
const VARIANT: Readonly<Record<BtnVariant, string>> = {
  default: 'primary',
  primary: 'primary',
  secondary: 'secondary',
  outline: 'outline',
  ghost: 'quiet',
  quiet: 'quiet',
  destructive: 'danger',
  danger: 'danger',
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  readonly variant?: BtnVariant
  readonly small?: boolean
  readonly className?: string
}

export const Btn = ({ variant, small, className, children, ...rest }: ButtonProps) => (
  <button
    type="button"
    className={cx(styles.btn, small && styles.btnSm, className)}
    /* `secondary` is the base rule, so it carries no attribute — writing the
       word and writing nothing have to paint identically or the vocabulary is
       a lie. */
    {...(variant && VARIANT[variant] !== 'secondary' ? { 'data-variant': VARIANT[variant] } : {})}
    {...rest}
  >
    {children}
  </button>
)

export const IconBtn = ({ className, children, ...rest }: ButtonProps) => (
  <button type="button" className={cx(styles.iconBtn, className)} {...rest}>
    {children}
  </button>
)

/**
 * A switch. It is a button, not a checkbox, because every one of these takes
 * effect the moment it is pressed — there is no form to submit.
 */
/**
 * The switch as a shape, with no behaviour of its own.
 *
 * Exists because a switch is mounted two ways: as its own control, which is
 * `Toggle` below, and as the far end of a row that is *itself* the control —
 * a menu row, where a nested button would be invalid markup and would take
 * the click the row wants. Both wear this, so there is one switch in the app
 * rather than one per place that needed one.
 */
/*
 * The switch, in both of its mountings.
 *
 * Neither of these draws anything any more: the shape moved to
 * `design/ui/switch.tsx`, which is the shadcn Base UI switch on the app's own
 * measured sizes. What is left here is the two ways this app mounts it, and
 * the names twelve settings surfaces already call them by.
 *
 * Why the split survives the move: a menu row IS the switch — it carries
 * `role="switch"` and its own handler — so it can only take the picture.
 * Everywhere else the switch is the control, and takes the real one.
 */

/** The switch as a picture, for a row that is itself the switch. */
export const Switch = ({
  on,
  small,
  disabled,
}: {
  on: boolean
  small?: boolean
  /** Greyed with the control that carries it, wherever that control lives. */
  disabled?: boolean
}) => <SwitchShape checked={on} size={small ? 'sm' : 'default'} disabled={disabled} />

/** The switch as the control: a `role="switch"` button that owns the change. */
export const Toggle = ({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean
  onChange?: (next: boolean) => void
  disabled?: boolean
  /** What the switch is for, for anyone not looking at the row beside it. */
  label: string
}) => (
  <UiSwitch
    checked={on}
    aria-label={label}
    disabled={disabled ?? !onChange}
    onCheckedChange={(next) => onChange?.(next)}
  />
)

/**
 * A line of text you type.
 *
 * Counted rather than chosen: the app already drew this input four times —
 * `--hd-control-h` tall, `--hd-radius-sm` cornered, `0 10px` in, one hairline
 * of `border-l2` around it — in the settings sheet, the sign-in sheet, the
 * hand-off sheet and the install dialog. This is that input, once.
 */
export const Input = ({
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { readonly className?: string }) => (
  <input type="text" spellCheck={false} className={cx(styles.input, className)} {...rest} />
)

/**
 * A picker: a real `<select>`, dressed as the input beside it.
 *
 * The platform's own element rather than a menu built from buttons, because a
 * picker on a settings row is plumbing, not presentation: it has to answer to
 * a form, a test and a screen reader without a library between them. What
 * this adds is only the look — the input's own border, height and ring — and
 * the caret, drawn once here so no page draws its own.
 */
export const Select = <T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
  ...control
}: {
  value: T
  options: readonly { readonly value: T; readonly label: string }[]
  onChange: (next: T) => void
  /** What is being chosen, for anyone not looking at the row beside it. */
  label: string
  disabled?: boolean
  className?: string
} & Partial<FieldControl>) => (
  <span className={cx(styles.selectWrap, className)}>
    <select
      className={cx(styles.input, styles.select)}
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
      {...control}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
    <span className={styles.selectChev} aria-hidden="true">
      <CaretIcon size={13} />
    </span>
  </span>
)

/** More than a line of text: the input, allowed to grow. */
export const Textarea = ({
  className,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'> & { readonly className?: string }) => (
  <textarea spellCheck={false} className={cx(styles.input, styles.textarea, className)} {...rest} />
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
    <input
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
 * `RadioGroupItem` is deliberately not used: its indicator is a dot, and the
 * indicator here is the whole segment lighting up. Base UI's `Radio.Root` is
 * the part that carries the behaviour, and it is happy to look like anything.
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
  <RadioGroup
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
      <Radio.Root
        key={option.value}
        value={option.value}
        /* Base UI renders a `span` by default. These are pressable controls and
           the app has always spelled them as buttons &mdash; which keeps the
           disabled state native, keeps the cursor right, and keeps every test
           that looks for a button honest. `render` is how Base UI is told, and
           `nativeButton` is how it is told the element really is one &mdash;
           without it the library assumes it has to add the button behaviour
           itself, and warns that it is about to duplicate the browser. */
        render={<button type="button" />}
        nativeButton
        className={styles.segItem}
        {...flag(option.value === value)}
      >
        {option.label}
      </Radio.Root>
    ))}
  </RadioGroup>
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
      <div className={styles.pageTitle}>{title}</div>
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
export const Rows = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cx(styles.rows, className)}>{children}</div>
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
  <button
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
  </button>
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
  <button
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
  </button>
)

/* --- drill-down ---------------------------------------------------------- */

/**
 * The way back out of a detail page. It names where it goes rather than saying
 * "Back", so it reads the same whether you arrived from the list or from a
 * link somewhere else.
 */
export const BackLink = ({ to, onClick }: { to: string; onClick: () => void }) => (
  <button type="button" className={styles.backLink} onClick={onClick}>
    <ArrowLeftIcon size={14} />
    {to}
  </button>
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

export { styles as kit }
