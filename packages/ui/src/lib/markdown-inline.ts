import { Marked } from 'marked'
import { sanitizeHtml } from './sanitize'

const marked = new Marked({ gfm: true, async: false })

/** Short descriptions use the document renderer's parser and sanitizer. */
export const inlineMarkdown = (text: string): string => {
  const template = document.createElement('template')
  template.innerHTML = sanitizeHtml(marked.parseInline(text, { async: false }) as string)
  // Descriptions live inside row buttons; links keep their words, not another focus target.
  for (const link of template.content.querySelectorAll('a')) link.replaceWith(...Array.from(link.childNodes))
  return template.innerHTML
}
