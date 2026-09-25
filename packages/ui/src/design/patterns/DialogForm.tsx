import { useCallback, useContext, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

import { DialogFormContext } from '../../lib/dialog-form'
import { Button } from '../ui/button'
import styles from './DialogForm.module.css'

/**
 * The form grammar of a dialog.
 *
 * A dialog that asks for more than one thing is a form, and a form has a
 * rhythm a settings page does not: a label sits on its control, fields are
 * one even step apart, a group of answers is named the way a field is, and a
 * list of answers is a list of radios rather than a card of settings rows.
 * The Settings parts (`SectionHead`, `Rows`, `RowChoice`, `FormStack`, `Note`)
 * were being pasted into dialogs and brought page furniture with them — a
 * group label floating 40px from its list, four 60px rows for four words.
 *
 * So the dialog's body says it is a dialog (`DialogFormScope`, provided by
 * `Dialog`, and not by a `flush` body, which is a list), and those parts read
 * it: inside a dialog `SectionHead` draws a legend, `FormStack` and the body
 * keep this sheet's rhythm, a `Rows` radio group whose every row is a
 * `RowChoice` becomes a `ChoiceList` (a group of anything else keeps its
 * card), and a `RowChoice` outside a card is a compact radio row. Dialog and alert content, popovers and menus reset the scope for
 * what they hold. Existing dialogs change without an edit; new ones compose
 * the parts below.
 *
 * Choosing the control for one answer among several:
 *
 *   2–4 short answers        `Segmented`, or a `NativeSelect`
 *   answers that need a line `ChoiceList` — every answer's line in the hint step
 *   several members at once  checkboxes (`Checkbox`), never switches: a switch
 *                            acts now, and a picked member is not an action
 */

/** Marks everything inside as a dialog's form. `Dialog` puts its body in one. */
export const DialogFormScope = ({ children }: { readonly children: ReactNode }) => (
  <DialogFormContext.Provider value>{children}</DialogFormContext.Provider>
)

/** Whether this part is drawn inside a dialog's body. */
export const useDialogForm = (): boolean => useContext(DialogFormContext)

/** The class a dialog's body and an in-dialog `FormStack` share. */
export const dialogStackClass = styles.stack

/**
 * The name over a group, as a `Field` names its control. `SectionHead` draws
 * this inside a dialog, so a group label written for a page lands attached
 * to the group it names.
 */
export const FieldsetLegend = ({
  id,
  name,
  description,
  action,
  className,
}: {
  readonly id?: string
  readonly name: ReactNode
  readonly description?: ReactNode
  readonly action?: ReactNode
  readonly className?: string
}) => (
  <div id={id} className={className ? `${styles.legend} ${className}` : styles.legend} data-slot="fieldset-legend">
    <span className={styles.legendText}>
      <span className={styles.legendName} data-slot="section-name">{name}</span>
      {description != null && <span className={styles.legendHint} data-slot="section-description">{description}</span>}
    </span>
    {action}
  </div>
)

/**
 * A legend over a group of controls — checkboxes, a `ChoiceList`, two fields
 * that belong together. The group is announced by its legend, and the legend
 * sits on the group at a label's distance.
 */
export const Fieldset = ({
  legend,
  hint,
  action,
  children,
}: {
  readonly legend: ReactNode
  /** One line about the whole group, in the hint step. */
  readonly hint?: ReactNode
  readonly action?: ReactNode
  readonly children: ReactNode
}) => {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className={styles.fieldset} data-slot="fieldset">
      <FieldsetLegend id={id} name={legend} description={hint} action={action} />
      <div className={styles.fieldsetBody}>{children}</div>
    </div>
  )
}

/**
 * Arrow keys, Home and End move the answer within the nearest radio group,
 * the way a native radio group does: one Tab stop, and the arrows choose.
 */
export const stepRadio = (event: KeyboardEvent<HTMLElement>): void => {
  if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  const group = event.currentTarget.closest('[role="radiogroup"]')
  if (!group) return
  const choices = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
  const current = choices.indexOf(event.currentTarget as HTMLButtonElement)
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
}

/**
 * One answer in a `ChoiceList`: a radio on the title's line and, under the
 * title, the answer's description in the hint step. Every answer shows its
 * description, so answers can be compared before one is chosen, and choosing
 * moves nothing — a row's height is its content's, never its state's. The
 * whole row is the target. It reaches 8px past its column on either side, so
 * the radio lines up with the labels above it and the hover still has a
 * corner to round, wherever the row is placed.
 */
export const ChoiceRow = ({
  title,
  desc,
  icon,
  trailing,
  selected,
  tabStop,
  disabled,
  autoFocus,
  onClick,
  onDoubleClick,
}: {
  readonly title: ReactNode
  readonly desc?: ReactNode
  /** A 16px line icon leading the title — the kind being chosen, not a tinted tile. */
  readonly icon?: ReactNode
  /** Pinned to the title line's far end — a keyboard shortcut, said quietly. */
  readonly trailing?: ReactNode
  readonly selected: boolean
  /** The Tab entry when the group has no answer yet. */
  readonly tabStop?: boolean
  readonly disabled?: boolean
  /**
   * Focuses this row once, the moment it mounts, without scrolling it into
   * view — a dialog that opens onto a list of answers still opens onto its
   * default one. Read once, at mount: a row does not steal focus back just
   * because its caller re-renders with the same answer still selected.
   */
  readonly autoFocus?: boolean
  readonly onClick: () => void
  /** A double click on a row is the fast path to its list's own default action. */
  readonly onDoubleClick?: () => void
}) => {
  const id = useId()
  const focusOnce = useRef(autoFocus)
  const focusWithoutScrolling = useCallback((node: HTMLButtonElement | null): void => {
    if (focusOnce.current) node?.focus({ preventScroll: true })
  }, [])
  return (
    <Button
      ref={focusWithoutScrolling}
      variant="ghost"
      size="pattern"
      type="button"
      role="radio"
      aria-checked={selected}
      /* Named by its title alone; the description is said once, as the
         description. Left to the text content, the name read both. */
      aria-labelledby={`${id}-title`}
      aria-describedby={desc ? `${id}-desc` : undefined}
      tabIndex={selected || tabStop ? 0 : -1}
      disabled={disabled}
      className={styles.choice}
      data-slot="choice-row"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={stepRadio}
    >
      <span className={styles.radio} aria-hidden="true" {...(selected ? { 'data-checked': '' } : {})} />
      <span className={styles.choiceHead}>
        {icon && <span className={styles.choiceIcon} aria-hidden="true">{icon}</span>}
        <span id={`${id}-title`} className={styles.choiceTitle}>{title}</span>
        {trailing && <span className={styles.choiceTrailing}>{trailing}</span>}
      </span>
      {desc ? <span id={`${id}-desc`} className={styles.choiceDesc}>{desc}</span> : null}
    </Button>
  )
}

/** The container a dialog's `Rows role="radiogroup"` becomes. */
export const choiceListClass = styles.choiceList

/**
 * One answer among a few that each need a line of explanation, in a dialog.
 *
 * Compact rows, a radio beside each title and every description under its
 * title in the hint step, so nothing moves when the answer changes. For two to
 * four answers a word each, use `Segmented` or a `NativeSelect`; for several
 * members at once, checkboxes.
 */
export const ChoiceList = <T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  autoFocusSelected,
  onActivate,
}: {
  /** The group's accessible name — usually the legend's words. */
  readonly label: string
  readonly options: readonly {
    readonly value: T
    readonly title: ReactNode
    readonly description?: ReactNode
    readonly disabled?: boolean
    /** A 16px line icon leading the title, in place of a tinted tile. */
    readonly icon?: ReactNode
    /** Said quietly at the title line's far end — a keyboard shortcut. */
    readonly trailing?: ReactNode
  }[]
  readonly value: T | null
  readonly onChange: (next: T) => void
  readonly disabled?: boolean
  /** Focuses the current answer the moment this list mounts, rather than leaving a dialog's opening focus to fall through to its surface. */
  readonly autoFocusSelected?: boolean
  /** A double click on a row both answers and proceeds — the list's own default action, when its caller has one. */
  readonly onActivate?: (value: T) => void
}) => {
  const answered = options.some((option) => option.value === value && !option.disabled)
  const firstEnabled = options.find((option) => !option.disabled)?.value
  return (
    <div role="radiogroup" aria-label={label} className={styles.choiceList} data-slot="choice-list">
      {options.map((option) => (
        <ChoiceRow
          key={option.value}
          title={option.title}
          desc={option.description}
          icon={option.icon}
          trailing={option.trailing}
          selected={option.value === value}
          tabStop={!answered && option.value === firstEnabled}
          disabled={disabled || option.disabled}
          autoFocus={autoFocusSelected && option.value === value}
          onClick={() => onChange(option.value)}
          onDoubleClick={onActivate ? () => onActivate(option.value) : undefined}
        />
      ))}
    </div>
  )
}
