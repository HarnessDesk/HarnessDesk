import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../ui/hover-card'
import { Chip, Text } from './Settings'
import styles from './HeaderStatusGroup.module.css'

type Reading = { readonly label: string; readonly detail: string }
type RegisteredReading = Reading & { readonly element: HTMLSpanElement }
type Registry = {
  readonly put: (id: string, reading: RegisteredReading) => void
  readonly remove: (id: string) => void
}
const StatusGroupContext = createContext<Registry | null>(null)

/** Controls inside the group keep their accessible names, without a second tooltip. */
export const useHeaderStatusGroup = (): boolean => useContext(StatusGroupContext) !== null

/** A pane head's facts, on one chip ground with one labelled hover/focus card.
 * Readings register where their source is owned, so conditional controls and
 * minute-by-minute countdowns cannot leave the card holding an older fact. */
export const HeaderStatusGroup = ({ children, label = 'Conversation status', open: controlledOpen }: {
  readonly children: ReactNode
  readonly label?: string
  readonly open?: boolean
}) => {
  const [readings, setReadings] = useState<ReadonlyMap<string, RegisteredReading>>(() => new Map())
  const [open, setOpen] = useState(false)
  const put = useCallback((id: string, reading: RegisteredReading) => {
    setReadings((held) => new Map(held).set(id, reading))
  }, [])
  const remove = useCallback((id: string) => {
    setReadings((held) => {
      const next = new Map(held)
      next.delete(id)
      return next
    })
  }, [])
  const registry = useMemo(() => ({ put, remove }), [put, remove])
  // Registration follows mount time; the card follows chip order, including
  // conditional readings and keyed controls moved without changing their facts.
  useLayoutEffect(() => {
    setReadings((held) => {
      const ordered = [...held].sort(([, a], [, b]) =>
        a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      )
      const ids = [...held.keys()]
      return ordered.some(([id], index) => id !== ids[index]) ? new Map(ordered) : held
    })
  })
  return (
    <StatusGroupContext.Provider value={registry}>
      <HoverCard open={controlledOpen ?? open} onOpenChange={setOpen}>
        <HoverCardTrigger render={<span role="group" tabIndex={0} />} aria-label={label}
          className={`${styles.group} hd-no-drag`} hidden={readings.size === 0}
          onFocus={(event) => { if ((event.target as HTMLElement).matches(':focus-visible')) setOpen(true) }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
          }}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
          onClick={() => setOpen(false)}
        >
          <Chip tone="neutral" className={styles.chip}>{children}</Chip>
        </HoverCardTrigger>
        <HoverCardContent side="bottom" align="end">
          <Text as="div" role="subject">{label}</Text>
          <dl className={styles.facts}>
            {[...readings].map(([id, reading]) => (
              <div key={id} className={styles.fact}>
                <dt><Text role="meta">{reading.label}</Text></dt>
                <dd className={styles.detail}><Text role="prose">{reading.detail}</Text></dd>
              </div>
            ))}
          </dl>
        </HoverCardContent>
      </HoverCard>
    </StatusGroupContext.Provider>
  )
}

/** Works outside a group too; only grouped readings contribute to its card. */
export const HeaderStatusReading = ({ label, detail, children }: Reading & { readonly children: ReactNode }) => {
  const registry = useContext(StatusGroupContext)
  const id = useId()
  const element = useRef<HTMLSpanElement>(null)
  useEffect(() => { if (element.current) registry?.put(id, { label, detail, element: element.current }) }, [registry, id, label, detail])
  useEffect(() => () => registry?.remove(id), [registry, id])
  return <span ref={element} data-slot="header-status-reading" className={styles.reading}>{children}</span>
}
