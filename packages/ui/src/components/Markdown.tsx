import { useEffect, useMemo, useState } from 'react'
import { Marked } from 'marked'

import { ensureHighlighter, highlight, onHighlighterReady } from '../lib/highlight'
import { sanitizeHtml } from '../lib/sanitize'
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

/** Replaces fenced code blocks with highlighted markup once shiki is available. */
const applyHighlighting = (html: string, dark: boolean): string => {
  const template = document.createElement('template')
  template.innerHTML = html
  const blocks = template.content.querySelectorAll('pre > code')
  for (const block of blocks) {
    const language = [...block.classList]
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length)
    const highlighted = highlight(block.textContent ?? '', language, dark)
    if (!highlighted) continue
    const wrapper = document.createElement('template')
    wrapper.innerHTML = highlighted
    const shiki = wrapper.content.firstElementChild
    if (shiki) block.parentElement?.replaceWith(shiki)
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
  const theme = useTheme()
  const [, setTick] = useState(0)

  useEffect(() => {
    ensureHighlighter()
    // Re-render once grammars land so code that painted plain gets colour.
    return onHighlighterReady(() => setTick((value) => value + 1))
  }, [])

  const html = useMemo(() => {
    const parsed = (document ? markedDocument : marked).parse(text, {
      async: false,
    }) as string
    return applyHighlighting(sanitizeHtml(parsed), theme === 'dark')
  }, [text, theme, document])

  /* `chat` is the same prose at a message's size and rhythm — a channel line is
     read in a column of other people's lines, not as a document. */
  return (
    <div
      className={chat ? `${styles.markdown} ${styles.chat}` : styles.markdown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
