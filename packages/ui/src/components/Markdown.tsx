import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type UIEvent as ReactUIEvent,
} from 'react'
import { Marked } from 'marked'

import { buttonVariants, copyButtonIconMarkup } from '../design'
import { ensureHighlighter, highlight, onHighlighterReady } from '../lib/highlight'
import { sanitizeHtml } from '../lib/sanitize'
import { useStore } from '../state/context'
import { useTheme } from '../state/theme'
import styles from './Markdown.module.css'

/**
 * Assistant markdown.
 *
 * Agent output is not trusted input: it can contain anything the model or a tool
 * produced. Raw HTML is disabled at the parser, and the sanitiser below strips
 * anything that could execute or navigate somewhere unexpected — a transcript
 * must be safe to render even when the model was asked to output HTML.
 */

/**
 * Two parsers, and the difference is one option that matters a lot.
 *
 * `breaks: true` turns every single newline into a `<br>`. That is right for
 * an agent's output, which is streamed prose where a lone newline is meant as
 * a line break — without it, a model's carefully laid-out list runs together.
 *
 * It is wrong for a **file**. A `SKILL.md` is written by a person in an
 * editor and hard-wrapped at seventy or eighty columns, so every paragraph in
 * it contains newlines that mean nothing at all. Rendered with `breaks`, a
 * wrapped sentence comes out broken at the author's column width — which is
 * what the skill sheet showed the first time a real definition went through
 * it, and it reads as a bug in the document rather than in the renderer.
 */
const marked = new Marked({ gfm: true, breaks: true, async: false })

/** The same GFM, reading newlines the way a Markdown file means them. */
const markedDocument = new Marked({ gfm: true, breaks: false, async: false })

const copiedTimers = new WeakMap<HTMLButtonElement, number>()
const scrollTimers = new WeakMap<HTMLElement, number>()

/** Replaces fenced blocks with highlighted markup and gives each one its plate chrome. */
const renderCodeBlocks = (html: string, dark: boolean): string => {
  const template = document.createElement('template')
  template.innerHTML = html
  const blocks = template.content.querySelectorAll('pre > code')
  for (const block of blocks) {
    const language = [...block.classList]
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length)
    let pre = block.parentElement
    const highlighted = highlight(block.textContent ?? '', language, dark)
    if (highlighted) {
      const wrapper = document.createElement('template')
      wrapper.innerHTML = highlighted
      const shiki = wrapper.content.firstElementChild
      if (shiki instanceof HTMLElement && pre) {
        pre.replaceWith(shiki)
        pre = shiki
      }
    }
    if (!pre) continue

    const plate = document.createElement('div')
    plate.className = styles.codeBlock!
    plate.dataset.codeBlock = ''
    const header = document.createElement('div')
    header.className = styles.codeHeader!
    if (language) {
      const label = document.createElement('span')
      label.dataset.codeLanguage = ''
      label.textContent = language
      header.append(label)
    }
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.ariaLabel = 'Copy this code'
    copy.title = 'Copy'
    copy.dataset.copyCode = ''
    copy.className = `${buttonVariants({ variant: 'quiet', size: 'icon-xs' })} ${styles.codeCopy}`
    copy.innerHTML = copyButtonIconMarkup(false)
    header.append(copy)
    pre.replaceWith(plate)
    plate.append(header, pre)
  }
  return template.innerHTML
}

export const Markdown = ({
  text,
  chat = false,
  document = false,
}: {
  text: string
  chat?: boolean
  /**
   * The text came from a file rather than from an agent, so a lone newline
   * is the author's line wrap and not a line break. See the parsers above.
   */
  document?: boolean
}) => {
  const store = useStore()
  const theme = useTheme()
  const [grammars, setGrammars] = useState(0)

  useEffect(() => {
    ensureHighlighter()
    // Re-render once grammars land so code that painted plain gets colour.
    return onHighlighterReady(() => setGrammars((value) => value + 1))
  }, [])

  const html = useMemo(() => {
    const parsed = (document ? markedDocument : marked).parse(text, {
      async: false,
    }) as string
    return renderCodeBlocks(sanitizeHtml(parsed), theme === 'dark')
    /* `grammars` is read by nothing here, and it is the point: a grammar that
       lands after the first paint has to rebuild this HTML, or a finished
       message — whose text never changes again — keeps its code plain. */
  }, [text, theme, document, grammars])

  const copyCode = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest<HTMLButtonElement>('button[data-copy-code]')
    if (!button || !event.currentTarget.contains(button)) return
    const code = button.closest<HTMLElement>('[data-code-block]')?.querySelector('pre code')?.textContent
    if (code === undefined) return
    void navigator.clipboard.writeText(code).then(() => {
      button.dataset.copied = ''
      button.innerHTML = copyButtonIconMarkup(true)
      const previous = copiedTimers.get(button)
      if (previous !== undefined) window.clearTimeout(previous)
      copiedTimers.set(button, window.setTimeout(() => {
        delete button.dataset.copied
        button.innerHTML = copyButtonIconMarkup(false)
        copiedTimers.delete(button)
      }, 1500))
    }).catch(() => store.notice('warning', 'Could not copy to the clipboard.'))
  }, [store])

  const showScrollbar = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target?.matches('pre code')) return
    const plate = target.closest<HTMLElement>('[data-code-block]')
    if (!plate) return
    plate.dataset.scrolling = ''
    const previous = scrollTimers.get(plate)
    if (previous !== undefined) window.clearTimeout(previous)
    scrollTimers.set(plate, window.setTimeout(() => {
      delete plate.dataset.scrolling
      scrollTimers.delete(plate)
    }, 900))
  }, [])

  /* `chat` is the same prose at a message's size and rhythm — a channel line is
     read in a column of other people's lines, not as a document. */
  return (
    <div
      className={chat ? `${styles.markdown} ${styles.chat}` : styles.markdown}
      onClick={copyCode}
      onScrollCapture={showScrollbar}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
