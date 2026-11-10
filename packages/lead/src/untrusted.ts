import { leadClip } from './context.js'

/** Characters a reader cannot see: every format character, and the letters that draw as a blank. */
export const LEAD_INVISIBLE = /[\p{Cf}ᅟᅠ᠎⠀ㅤﾠ]/gu
/**
 * The one entry to reading a checkpoint's text, before anything else looks at it. Every line terminator a renderer or
 * a model reads as a break becomes one newline; other control characters (a tab aside) and every invisible character
 * are dropped; and each line loses its trailing blanks. The heading and quote checks, the fallback after them and
 * every reader see the same lines. Markup is escaped only after the structure is read (`escape`), so a blockquote's
 * `>` still marks a quoted heading or quote when they are checked.
 */
export const leadUntrustedLines = (text: string): string[] => text.replace(/\r\n|[\r\v\f\u0085\u2028\u2029]/g, '\n')
  .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g, '').replace(LEAD_INVISIBLE, '')
  .split('\n').map(line => line.trimEnd())
/** The last step for a line of the model's: `<` and `>` become entities, so the text is never markup and never raw
 * HTML, and can neither open nor close the desk's envelope. */
export const leadEscape = (line: string): string => line.replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The one way words nobody at the desk wrote (the person's rule text, and later a memory) become a quoted block of the
 * standing instructions. Line terminators fold to one newline, compatibility forms fold (NFKC, so a full-width or
 * ligature spelling of a tag becomes the tag), control and invisible characters go, and only then is every `<` and `>`
 * escaped, last, so no spelling of a closing tag, an opening tag or a desk envelope can survive as markup. Clipped to
 * `max` characters.
 */
export const leadCleanUntrusted = (text: string, max: number): string =>
  leadClip(leadEscape(leadUntrustedLines(text.normalize('NFKC')).join('\n')).trim(), max)
