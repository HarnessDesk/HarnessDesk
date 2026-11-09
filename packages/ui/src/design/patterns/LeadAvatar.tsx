import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { LeadName } from '@harnessdesk/protocol'
import { leadFaceSrc, type LeadMood } from '../../lib/lead-faces'
import { Button } from '../ui/button'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { Text } from './Settings'
import styles from './LeadAvatar.module.css'

/** Where the face is drawn; each place has one size, and only the two large ones show a mood. */
export type LeadAvatarSize = 'navigation' | 'turn' | 'header' | 'popover' | 'picker'
const LARGE: ReadonlySet<LeadAvatarSize> = new Set(['popover', 'picker'])

/**
 * The Lead's face on its character's disc. Below 28px an expression does not
 * read, so the small places draw the neutral face and the presence word beside
 * it says the state; the popover and the picker draw the mood. Never animated.
 * Before the name is known the disc is drawn empty — a glyph there reads as a
 * broken image, and the name arrives with the first read.
 */
export const LeadAvatar = ({ name, size = 'header', mood = 'neutral' }: { readonly name: LeadName | null; readonly size?: LeadAvatarSize; readonly mood?: LeadMood }) => {
  const src = name ? leadFaceSrc(name, mood, LARGE.has(size)) : null
  return <span role="img" aria-label={name === 'lex' ? 'Lex' : name === 'dex' ? 'Dex' : 'Lead'} data-slot="lead-avatar" data-lead={name ?? undefined} data-size={size} data-mood={LARGE.has(size) ? mood : 'neutral'} className={styles.avatar}>
    {src ? <img src={src} alt="" draggable={false} /> : null}
  </span>
}

const CHOICES: readonly { readonly value: LeadName; readonly label: string }[] = [{ value: 'dex', label: 'Dex' }, { value: 'lex', label: 'Lex' }]

/** Who runs the desk: two picture cards. A name is an immediate preference; this control never grants authority. */
export const LeadNameChoice = ({ value, pending, onChange }: { readonly value: LeadName; readonly pending: boolean; readonly onChange: (name: LeadName) => void }) =>
  <RadioGroup variant="choice" render={<span />} className={styles.choices} aria-label="Lead identity" value={value} onValueChange={next => { if (!pending && next !== value) onChange(next as LeadName) }}>
    {CHOICES.map(choice => <RadioGroupItem key={choice.value} variant="choice" value={choice.value} nativeButton disabled={pending} aria-label={choice.label}
      render={<Button type="button" variant="choice" size="inline" className={styles.choice} data-on={value === choice.value ? '' : undefined} />}>
      <LeadAvatar name={choice.value} size="picker" mood={value === choice.value ? 'working' : 'neutral'} />
      <Text role="subject">{choice.label}</Text>
    </RadioGroupItem>)}
  </RadioGroup>

/** A Lead turn centres its face on the first block's first line box, including prose, lists, headings and cards. */
export const LeadTurn = ({ face, children }: { readonly face: ReactNode; readonly children: ReactNode }) => {
  const turn = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const root = turn.current, content = body.current
    if (!root || !content) return
    let disposed = false
    const align = () => {
      if (disposed) return
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        const text = node.parentElement
        if (!node.textContent?.trim() || !text || text.closest('svg, [aria-hidden="true"]') || !text.getClientRects().length) continue
        // The inline's leading belongs to its enclosing block's first line, not its glyph bounds.
        const line = Number.parseFloat(getComputedStyle(text).lineHeight)
        if (!Number.isFinite(line)) continue
        let block = text
        while (block.parentElement && block !== content && ['inline', 'contents'].includes(getComputedStyle(block).display)) block = block.parentElement
        const css = getComputedStyle(block)
        const inset = block.getBoundingClientRect().top - root.getBoundingClientRect().top +
          Number.parseFloat(css.paddingTop) + Number.parseFloat(css.borderTopWidth)
        root.style.setProperty('--turn-first-line-inset', `${inset}px`)
        root.style.setProperty('--turn-first-line-height', `${line}px`)
        break
      }
    }
    align()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(align)
    observer?.observe(content)
    void document.fonts?.ready.then(align)
    return () => { disposed = true; observer?.disconnect() }
  }, [children])
  return <div ref={turn} data-slot="lead-turn" className={styles.turn}><span className={styles.turnFace} data-slot="lead-turn-face">{face}</span><div ref={body} data-slot="lead-turn-body" className={styles.turnBody}>{children}</div></div>
}

/**
 * The empty Lead conversation as one composition: the face, who it is in the
 * scale's 16, what it does in a sentence, and — only when something must come
 * first — the one action that does it. A screen supplies the words and the
 * action, never the layout.
 */
export const LeadGreeting = ({ avatar, title, children, action }: { readonly avatar: ReactNode; readonly title: ReactNode; readonly children: ReactNode; readonly action?: ReactNode }) =>
  <div data-slot="lead-greeting" className={styles.greeting}>
    {avatar}
    <div className={styles.greetingWords}>
      <Text as="h2" role="section" align="center">{title}</Text>
      <Text as="p" role="prose" ink="secondary" align="center">{children}</Text>
    </div>
    {action != null && <div className={styles.greetingAction}>{action}</div>}
  </div>

/** Who the Lead is and where it stands, at the head of its status popover. */
export const LeadIdentity = ({ avatar, name, word }: { readonly avatar: ReactNode; readonly name: ReactNode; readonly word: ReactNode }) =>
  <div data-slot="lead-status-head" className={styles.identity}>{avatar}<div className={styles.identityName}><Text role="subject">{name}</Text><Text role="muted">{word}</Text></div></div>

/** A note that belongs to the person's line above it, at that line's trailing edge. */
export const LeadLineNote = ({ children }: { readonly children: ReactNode }) => <div className={styles.lineNote}>{children}</div>

/** Names a block for tests and tools without adding a box of its own to the layout it sits in. */
export const LeadSlot = ({ slot, children }: { readonly slot: string; readonly children: ReactNode }) => <div data-slot={slot} className={styles.slot}>{children}</div>
