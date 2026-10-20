import { useRef, type ReactNode } from 'react'
import type { Tint as AccountTint } from '../../lib/accounts'
import type { AvatarId } from '../../lib/avatars'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { AccountMark, Face } from './Settings'
import styles from './SettingsChoices.module.css'
/** Picture, accent and account ring choices; picture arrows move by the eight-column grid. */
interface PictureChoice { readonly id: AvatarId | null; readonly label: string; readonly about: string }
/** Pictures as one radio group; arrows choose across an eight-column grid and unknown pictures check nothing. */
export const PictureChoices = ({ value, items, describedBy, change }: {
  readonly value: unknown; readonly items: readonly PictureChoice[]; readonly describedBy?: string
  readonly change: (value: AvatarId | null) => void
}) => {
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const current = items.findIndex(item => item.id === (value ?? null)), stop = current < 0 ? 0 : current
  return <Card spacing="compact" radius="lg"><div data-slot="picture-choices" className={styles.pictures} role="radiogroup" aria-label="Picture" aria-describedby={describedBy}>
    {items.map((item, index) => <Button key={item.id ?? 'default'} ref={node => { buttons.current[index] = node }}
      type="button" role="radio" aria-checked={index === current} aria-label={item.label} title={`${item.label} — ${item.about}`}
      tabIndex={index === stop ? 0 : -1} variant="ghost" size="inline" className={styles.picture} data-swatch
      data-on={index === current ? '' : undefined} onClick={() => change(item.id)} onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 8 : event.key === 'ArrowUp' ? -8 : null
        if (offset === null) return
        event.preventDefault()
        const next = index + offset, target = items[next]
        if (!target) return
        change(target.id); buttons.current[next]?.focus()
      }}><Face avatar={item.id} size={44} /></Button>)}
  </div></Card>
}
/** Accent colours as radio choices, with palette values supplied by the caller. */
export const AccentChoices = <T extends string,>({ value, items, change }: {
  readonly value: T; readonly items: readonly { readonly value: T; readonly label: string; readonly swatch: string }[]
  readonly change: (value: T) => void
}) => <RadioGroup variant="choice" render={<span />} className={styles.inline} aria-label="Accent" value={value} onValueChange={change}>
  {items.map(item => <RadioGroupItem key={item.value} variant="choice" value={item.value} nativeButton
    aria-label={item.label} title={item.label} render={<Button type="button" variant="ghost" size="icon-circle"
      data-on={value === item.value ? '' : undefined} swatch={item.swatch} />} />)}
</RadioGroup>
/** Account ring colours, keeping the selected mark and current tint callback. */
export const RingChoices = <T extends AccountTint,>({ value, values, mark, change }: {
  readonly value: T; readonly values: readonly T[]; readonly mark: ReactNode; readonly change: (value: T) => void
}) => <RadioGroup variant="choice" render={<span />} className={styles.inline} aria-label="Ring colour" value={value} onValueChange={change}>
  {values.map(tint => <RadioGroupItem key={tint} variant="choice" value={tint} nativeButton aria-label={tint}
    render={<AccountMark as="button" className={styles.ring} data-tint={tint} data-on={tint === value ? '' : undefined}>{mark}</AccountMark>}>{mark}</RadioGroupItem>)}
</RadioGroup>
