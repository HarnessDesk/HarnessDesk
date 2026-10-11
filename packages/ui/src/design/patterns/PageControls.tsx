import type { ReactNode } from 'react'
import { Row, Rows, Search, Text, Keycap, Note } from './Settings'
import { NativeSelect } from '../ui/native-select'
import styles from './PageControls.module.css'
/** Labelled page fields and complete supporting text, composed from the Settings row contracts. */
export interface PageChoice {
  readonly id: string; readonly title: string; readonly description?: ReactNode
  readonly value: string; readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[]
  readonly change: (value: string) => void
}
/** Labelled search and choices, using the Settings row control slots. */
export const PageControls = ({ search, choices = [] }: {
  readonly search?: { readonly label: string; readonly placeholder: string; readonly value: string; readonly change: (value: string) => void }
  readonly choices?: readonly PageChoice[]
}) => <Rows>
  {search && <Row title={search.label} control={<Search label={search.label} placeholder={search.placeholder} value={search.value} onChange={search.change} />} />}
  {choices.map(choice => <Row key={choice.id} title={choice.title} desc={choice.description}
    control={<NativeSelect aria-label={choice.title} value={choice.value} onChange={event => choice.change(event.target.value)}>
      {choice.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </NativeSelect>} />)}
</Rows>
/** A keyboard chord, with one keycap per key. */
export const ShortcutKeys = ({ keys }: { readonly keys: readonly string[] }) =>
  <span data-slot="shortcut-keys" className={styles.keys}>{keys.map((key, index) => <Keycap key={`${index}:${key}`}>{key}</Keycap>)}</span>
/** A complete page explanation in the prose role. */
export const PageExplanation = ({ children }: { readonly children: ReactNode }) => <Text as="p" role="prose" ink="secondary">{children}</Text>
/** Source prose retaining its line breaks, wrapping within the page. */
export const PreservedText = ({ value }: { readonly value: string }) => <Text as="p" role="prose" className={styles.preserved}>{value}</Text>
/** A short qualifier beside the fact it belongs to. */
export const InlineQualifier = ({ value }: { readonly value: string }) => <Text role="meta" className={styles.qualifier}>{value}</Text>
/** Complete supporting notes that belong to a page group. */
export const PageNotes = ({ notes }: { readonly notes: readonly { readonly id: string; readonly text: ReactNode }[] }) =>
  <Note>{notes.map(note => <Text key={note.id} as="p" role="prose">{note.text}</Text>)}</Note>
