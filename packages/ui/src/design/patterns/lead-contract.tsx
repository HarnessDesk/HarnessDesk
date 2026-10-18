import { Marked } from 'marked'
import type { ReactNode, Ref } from 'react'
import { sanitizeHtml } from '../../lib/sanitize'
import { Banner } from '../primitives/Banner'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Page } from './Page'
import { LeadIcon } from '../../components/Icons'
import styles from './lead-contract.module.css'
import { Chip, Row, Rows, Spinner, Text } from './Settings'

const markdown = new Marked({ gfm: true, breaks: true, async: false })
/** Revision-qualified Lead decision, composed from the app's row and notice grammar.
 * Prose is untrusted and always passes the transcript sanitizer. Actions wrap in
 * document order; a worker approval supplies a link, never decision callbacks.
 */
export const LeadContract = ({ title, revision, summary, children, links, pending = false, approveLabel = 'Approve', onApprove, onDecline, notice, cardId, cardType, focusRef }: {
  readonly title: string
  readonly revision: number
  readonly summary?: string
  readonly links?: ReactNode
  readonly children?: ReactNode
  readonly pending?: boolean
  readonly approveLabel?: 'Approve' | 'Accept'
  readonly onApprove?: () => void
  readonly onDecline?: () => void
  readonly notice?: ReactNode
  readonly cardType?: string
  readonly cardId?: string
  readonly focusRef?: Ref<HTMLElement>
}) => <section ref={focusRef} tabIndex={-1} data-slot="lead-contract" data-lead-card={cardId} data-lead-card-type={cardType} aria-label={`${title}, revision ${revision}`} className="min-w-0 flex flex-col gap-3">
  <Rows><Row title={<Text as="h2" role="row">{title}</Text>} control={<Chip tone="neutral">Revision {revision}</Chip>} /></Rows>
  {summary !== undefined && <Text as="div" role="prose" children={null} data-lead-prose className="min-w-0 break-words whitespace-normal" dangerouslySetInnerHTML={{ __html: sanitizeHtml(markdown.parse(summary) as string) }} />}
  {children}
  {links && <div className="flex flex-wrap gap-2">{links}</div>}
  {notice && <Banner>{notice}</Banner>}
  {(onApprove || onDecline) && <div data-lead-actions className="flex flex-wrap items-center gap-2" aria-busy={pending}>
    {onApprove && <Button disabled={pending} aria-busy={pending} onClick={onApprove}>{pending && <Spinner aria-hidden />}{approveLabel}</Button>}
    {onDecline && <Button variant="secondary" disabled={pending} aria-busy={pending} onClick={onDecline}>{pending && <Spinner aria-hidden />}Decline</Button>}
  </div>}
</section>


/** Lead's reading page template: one title, a scrolling journal and an in-flow
 * composer anchored at the bottom, using the same page measure as Chat.
 * Screens supply data and decisions; this pattern owns the page geometry.
 */
export const LeadJournal = ({ children, notices, onSettings, threadRef, inputRef, text, onText, onSend, pending, disabled, allowances }: {
  readonly children: ReactNode
  readonly notices?: ReactNode
  readonly onSettings: () => void
  readonly threadRef: Ref<HTMLDivElement>
  readonly inputRef: Ref<HTMLTextAreaElement>
  readonly text: string
  readonly onText: (text: string) => void
  readonly onSend: () => void
  readonly pending: boolean
  readonly disabled: boolean
  readonly allowances?: { readonly dollars: string; readonly rounds: number }
}) => <div className={styles.shell}>
  <Page width="reading" fill>
    <div className={styles.head}><div className={styles.title}><LeadIcon size={20} /><Text as="h1" role="page">Lead</Text></div><Button variant="outline" onClick={onSettings}>Settings</Button></div>
    <div className={styles.thread} ref={threadRef} role="log" aria-label="Lead thread" aria-live="polite">{children}</div>
    <form className={styles.composer} aria-label="Lead composer" onSubmit={event => { event.preventDefault(); onSend() }}>
      {notices}
      <Textarea ref={inputRef} aria-label="Goal or message" placeholder="Describe a goal…" value={text} onChange={event => onText(event.target.value)} />
      <div className={styles.allowances}>
        {allowances && <><Chip tone="neutral">{allowances.dollars}</Chip><Chip tone="neutral">{allowances.rounds} rounds</Chip></>}
        <Button type="submit" disabled={disabled} aria-busy={pending}>{pending ? 'Sending…' : 'Send'}</Button>
      </div>
    </form>
  </Page>
</div>
