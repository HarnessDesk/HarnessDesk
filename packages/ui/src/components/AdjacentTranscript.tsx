import { sessionKey, type Session } from '@harnessdesk/protocol'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { ConversationShell, ConversationThread, Separator } from '../design'
import { fileLink } from '../lib/file-link'
import { useStore } from '../state/context'
import { ItemView, ReadOnlyTranscript } from './Items'

/** The shared transcript items, without the conversation's composer or controls. */
export const AdjacentTranscript = ({ session }: { session: Session }) => {
  const store = useStore()
  const scroll = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)
  const identity = sessionKey(session.runtime, session.id)
  const previousIdentity = useRef(identity)
  const onScroll = useCallback(() => {
    const element = scroll.current
    if (!element) return
    if (element.dataset.autoscrolling) { delete element.dataset.autoscrolling; return }
    setPinned(element.scrollHeight - element.scrollTop - element.clientHeight < 120)
  }, [])
  useEffect(() => {
    const releaseSelection = () => {
      const selection = document.getSelection()
      if (selection && !selection.isCollapsed && selection.anchorNode && scroll.current?.contains(selection.anchorNode)) setPinned(false)
    }
    document.addEventListener('selectionchange', releaseSelection)
    return () => document.removeEventListener('selectionchange', releaseSelection)
  }, [])
  useLayoutEffect(() => {
    const changed = previousIdentity.current !== identity
    previousIdentity.current = identity
    if (changed) setPinned(true)
    if (!pinned && !changed) return
    const element = scroll.current
    if (!element) return
    let frame = 0
    const follow = () => {
      element.dataset.autoscrolling = 'true'
      element.scrollTop = element.scrollHeight
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => delete element.dataset.autoscrolling)
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(element)
    if (content.current) observer.observe(content.current)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [identity, pinned, session.turns])
  const fileClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!link || !event.currentTarget.contains(link)) return
    setPinned(false)
    if (!fileLink(link.getAttribute('href') ?? '')) return
    event.preventDefault()
    store.notice('warning', 'File links are unavailable in the adjacent conversation.')
  }
  return <ReadOnlyTranscript>
    <ConversationShell><ConversationThread ref={scroll} data-transcript="" aria-label="Read-only transcript" onScroll={onScroll} onClick={fileClick} onAuxClick={fileClick}>
      <div ref={content}>
      {session.turns.map((turn, index) => <div key={turn.id}>
        {index > 0 && <Separator />}
        {turn.items.map(item => <ItemView key={item.id} item={item} root={session.cwd} sentAt={turn.startedAt ?? undefined} />)}
      </div>)}
      </div>
    </ConversationThread></ConversationShell>
  </ReadOnlyTranscript>
}
