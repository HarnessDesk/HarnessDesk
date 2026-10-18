import type { ReactNode, Ref, UIEventHandler } from 'react'
import { Markdown } from '../../components/Markdown'
import { SendIcon } from '../../components/Icons'
import { Banner } from '../primitives/Banner'
import { Button } from '../ui/button'
import { ComposerShell, ComposerText, ComposerTools, ComposerSend, ComposerGap } from '../ui/composer'
import { Message, MessageContent } from '../ui/message'
import { Bubble, BubbleContent } from '../ui/bubble'
import { Page } from './Page'
import styles from './lead-contract.module.css'
import { Chip, Spinner, Text } from './Settings'

/** One Lead decision surface. Row groups inherit its edge and prose uses the
 * transcript's Markdown pipeline, including sanitization and code interactions. */
export const LeadContract = ({ title, revision, summary, children, links, pending = false, approveLabel = 'Approve', onApprove, onDecline, notice, cardId, cardType, focusRef, state }: {
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
  readonly state?: string
}) => <section ref={focusRef} tabIndex={-1} data-slot="lead-contract" data-lead-card={cardId} data-lead-card-type={cardType} aria-label={`${title}, revision ${revision}`} className={styles.surface}>
  <header className={styles.cardHead}>
    <div className="flex flex-wrap items-center gap-2"><Text as="h2" role="subject">{title}</Text><span data-lead-state><Chip tone="neutral">{state ?? (onApprove || onDecline ? 'Pending' : 'Waiting')}</Chip></span></div>
    <Text role="meta">Revision {revision}</Text>
  </header>
  {summary !== undefined && <div data-lead-prose className="min-w-0 break-words whitespace-normal"><Markdown text={summary} /></div>}
  {children}
  {notice && <Banner>{notice}</Banner>}
  {(links || onApprove || onDecline) && <div data-lead-actions className="flex flex-wrap items-center gap-2" aria-busy={pending}>
    {links}
    {onApprove && <Button disabled={pending} aria-busy={pending} onClick={onApprove}>{pending && <Spinner aria-hidden />}{approveLabel}</Button>}
    {onDecline && <Button variant="secondary" disabled={pending} aria-busy={pending} onClick={onDecline}>{pending && <Spinner aria-hidden />}Decline</Button>}
  </div>}
</section>

/** Lead turns use the transcript's message alignment, bubble and rhythm. */
export const LeadMessage = ({ role, text }: { readonly role: 'user' | 'assistant'; readonly text: string }) => <Message align={role === 'user' ? 'end' : 'start'} rhythm="transcript" aria-label={role === 'user' ? 'You' : 'Lead'}>
  <MessageContent className={role === 'user' ? 'items-end' : undefined}><Bubble variant={role === 'user' ? 'secondary' : 'ghost'}><BubbleContent>{role === 'user' ? text : <Markdown text={text} />}</BubbleContent></Bubble></MessageContent>
</Message>

/** Reading page with the app's shared composer and a non-live journal region.
 * Decision controls remain navigable without re-announcing the entire thread. */
export const LeadJournal = ({ children, notices, onSettings, threadRef, onThreadScroll, inputRef, text, onText, onSend, pending, disabled, allowances }: {
  readonly children: ReactNode
  readonly notices?: ReactNode
  readonly onSettings: () => void
  readonly threadRef: Ref<HTMLDivElement>
  readonly onThreadScroll?: UIEventHandler<HTMLDivElement>
  readonly inputRef: Ref<HTMLTextAreaElement>
  readonly text: string
  readonly onText: (text: string) => void
  readonly onSend: () => void
  readonly pending: boolean
  readonly disabled: boolean
  readonly allowances?: { readonly dollars: string; readonly rounds: number }
}) => <div className={styles.shell}>
  <Page width="reading" fill>
    <div className={styles.head}><Text as="h1" role="page">Lead</Text><Button variant="outline" onClick={onSettings}>Settings</Button></div>
    <div className={styles.thread} ref={threadRef} onScroll={onThreadScroll} role="region" aria-label="Lead thread">{children}</div>
    <form className={styles.composer} aria-label="Lead composer" onSubmit={event => { event.preventDefault(); if (!disabled) onSend() }}>
      {notices}
      <ComposerShell>
        <ComposerText ref={inputRef} aria-label="Goal or message" placeholder="Describe a goal…" value={text} onChange={event => onText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!disabled) onSend() } }} />
        <ComposerTools>
          <div className={styles.allowances}>{allowances && <><Chip tone="neutral">{allowances.dollars}</Chip><Chip tone="neutral">{allowances.rounds} rounds</Chip></>}</div>
          <ComposerGap />
          <ComposerSend type="submit" disabled={disabled} aria-label={pending ? 'Sending…' : 'Send'} title={pending ? 'Sending…' : 'Send'} aria-busy={pending}>{pending ? <Spinner aria-hidden /> : <SendIcon />}</ComposerSend>
        </ComposerTools>
      </ComposerShell>
    </form>
  </Page>
</div>
