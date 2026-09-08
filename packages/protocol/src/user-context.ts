/**
 * Peeling a client's own scaffolding off a user message.
 *
 * Agent clients compose. What reaches the model — and what the agent then
 * stores as the user's turn — is often the typed sentence wrapped in state
 * the client added for the model's benefit: Codex's in-app browser context,
 * Claude Code's system reminders and slash-command caveats. The composing
 * client hides its own wrapper when it draws the bubble; every other client
 * reading the same transcript shows the plumbing.
 *
 * We are every other client, for four agents at once. So the wrapper comes
 * off the sentence and is kept beside it, folded — never dropped. It is real
 * context the model received, and a transcript that deletes it cannot explain
 * why the agent knew what it knew. A heuristic that hides is a heuristic that
 * silently eats real words the day the format changes; one that folds is
 * merely untidy.
 *
 * This is the mirror of `context-envelope` in the renderer, which does the
 * same job for the envelope *we* send. That one stays in the UI because we
 * both write and read it; these belong to the adapters, because knowing what
 * a foreign tag means is exactly what an adapter is for.
 *
 * This module knows the *shape* — an XML-ish block with a tag — and nothing
 * about which agent uses which tags. Each adapter brings its own list, which
 * is what keeps this file below the layering rule.
 */

/** One peeled wrapper: what it is, and what it held. */
export interface UserContext {
  /**
   * What the block is, in words — `In-app browser`, not
   * `in-app-browser-context`. The adapter names it, because the adapter is
   * what knows; a wire tag on screen is the thing this project keeps out of
   * the UI.
   */
  readonly label: string
  /** The block, verbatim, wrapper and all. */
  readonly text: string
}

/**
 * The other shape an envelope comes in: not a tag around the wrapper, but a
 * marker line ahead of the sentence, with the client's sections stacked
 * above it. Codex composes this way — `# Selected text:`, `# Diff comments:`,
 * then `## My request:` and the words — and its own client reads it back by
 * splitting on the last marker, which is exactly what this describes.
 */
export interface RequestMarker {
  /**
   * The marker, spelled as the composing client spells it. The **last**
   * occurrence wins: a person may quote the marker inside their own request,
   * and the client's own reader takes the last one too.
   */
  readonly marker: RegExp
  /**
   * `# Heading:` (without the `#` or the colon) → what to call that section
   * on screen. Each section folds on its own, so a message carrying comments
   * *and* a selection says both, rather than one vague thing.
   */
  readonly sections: Readonly<Record<string, string>>
  /** What to call a section this list has never seen. */
  readonly other: string
}

/**
 * A sentence a client writes into the message as its own — Codex's caveat
 * over an image it attached to a comment. There is nothing structural to
 * match, so the pattern is the whole definition and the label is ours.
 */
export interface NotePattern {
  readonly label: string
  readonly pattern: RegExp
}

export interface PeelOptions {
  /** Tag name (no angle brackets) → what to call it on screen. */
  readonly tags: Readonly<Record<string, string>>
  /** The marker form, for a client that stacks its envelope ahead of one. */
  readonly request?: RequestMarker
  /** Sentences of the client's own, wherever in the message they fall. */
  readonly notes?: readonly NotePattern[]
}

export interface PeeledText {
  /** What is left once the wrappers are out: what the person typed. */
  readonly text: string
  /** The wrappers, in the order they were peeled. */
  readonly context: readonly UserContext[]
}

/**
 * What the message carries beyond this text, for judging a note. A note is a
 * bare sentence, and sentences are things people also type — so it is only
 * read as the client's when something corroborates the client having
 * composed the message: a wrapper already recognised in the text, or the
 * picture the note is about riding beside it as its own part. The adapter
 * says the latter, because only the adapter sees the whole message.
 */
export interface NoteEvidence {
  readonly image?: boolean
}

/**
 * A trailing space, encoded so it survives a markdown round trip. Codex
 * appends one to every composed prompt; it is the only entity it emits, and
 * it is punctuation of the envelope rather than anything anyone typed.
 */
const TRAILING_SPACE = /(?:&#x20;|&#32;|\s)+$/i

/** What a peeled block actually held, with its own tags off. */
const contentsOf = (block: string, tag: string): string =>
  block
    .replace(new RegExp(`^<${tag}(?:\\s[^>]*)?>`), '')
    .replace(new RegExp(`</${tag}>$`), '')
    .trim()

/** The same expression, safe to iterate: `matchAll` insists on a global one. */
const global = (pattern: RegExp): RegExp =>
  pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`)

/**
 * The `# Heading:` lines a composed envelope is stacked out of. Finding one
 * is what makes a marker below it the client's rather than a person's: it is
 * the only evidence in the text that anything composed this at all.
 */
const sectionHeads = (prefix: string): readonly RegExpExecArray[] =>
  [...prefix.matchAll(/^#[ \t]+(.+?):[ \t]*$/gm)] as RegExpExecArray[]

/**
 * The envelope above a marker, split back into the sections that composed it.
 *
 * Text under a heading nobody named — or above the first heading at all — is
 * a section too, under the client's generic label: an envelope this file does
 * not recognise is still not the person's words, and folding it says so
 * without pretending to know what it is.
 */
const sectionsOf = (
  prefix: string,
  heads: readonly RegExpExecArray[],
  rule: RequestMarker,
): UserContext[] => {
  const out: UserContext[] = []
  const lead = prefix.slice(0, heads[0]?.index ?? prefix.length).trim()
  if (lead.length > 0) out.push({ label: rule.other, text: lead })
  heads.forEach((head, index) => {
    const start = head.index ?? 0
    const body = prefix.slice(start, heads[index + 1]?.index ?? prefix.length).trim()
    if (body.length === 0) return
    out.push({ label: rule.sections[head[1] ?? ''] ?? rule.other, text: body })
  })
  return out
}

const blockPattern = (tag: string): RegExp =>
  // The closed form and the truncated one alike: a transcript cut mid-block
  // still has to give up its opening tag rather than keep half an envelope.
  new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?(?:</${tag}>|$)`, 'g')

/**
 * Split a user message into the sentence and the wrappers around it.
 *
 * Text with no wrapper in it comes back untouched — same string, no context —
 * so this is safe to run over every user message from every agent.
 */
export const peelContext = (text: string, options: PeelOptions, evidence: NoteEvidence = {}): PeeledText => {
  const context: UserContext[] = []
  // Whether anything of the client's composing was recognised — counting a
  // wrapper that held nothing, which folds no row but is still structure no
  // person types.
  let composed = false
  let rest = text

  for (const [tag, label] of Object.entries(options.tags)) {
    rest = rest.replace(blockPattern(tag), (block) => {
      composed = true
      // A wrapper with nothing inside it held nothing: Codex writes
      // `<image></image>` where a picture rides beside the text as its own
      // part. That is punctuation of the envelope, like the trailing space
      // below — folding it would be a row that opens onto nothing.
      if (contentsOf(block, tag).length > 0) context.push({ label, text: block.trim() })
      return ''
    })
  }


  // Tags first, deliberately: a wrapper peeled here is a wrapper whose own
  // headings can no longer be read as sections of the envelope around it.
  const request = options.request
  if (request) {
    // The last marker, because that is how the client that writes them reads
    // them back: its composer rebuilds the envelope from the last one, so an
    // older marker can still be sitting above this one.
    const marker = [...rest.matchAll(global(request.marker))].at(-1)
    if (marker?.index !== undefined) {
      const prefix = rest.slice(0, marker.index)
      const heads = sectionHeads(prefix)
      // Only once something above the marker has been recognised — a heading
      // the client composes, or a tag already peeled. Someone who types the
      // marker themselves is writing *about* the format rather than in it,
      // and keeps every word of what they wrote.
      if (heads.length > 0 || context.length > 0) {
        composed = true
        context.push(...sectionsOf(prefix, heads, request))
        rest = rest.slice(marker.index + marker[0].length)
      }
    }
  }

  // Last, so the folds read down the message: the wrapper above the marker,
  // the sections stacked under it, then the sentences the client appended.
  // A note is peeled only on corroboration — an envelope recognised above,
  // or the picture it is about riding in the same message — because the
  // pattern alone is a sentence anyone could have typed, and a heuristic
  // that eats typed words fails the whole file's bargain.
  if (composed || evidence.image === true) {
    for (const note of options.notes ?? []) {
      rest = rest.replace(global(note.pattern), (found) => {
        context.push({ label: note.label, text: found.trim() })
        return ''
      })
    }
  }

  if (context.length === 0) return { text, context: [] }

  return { text: rest.replace(TRAILING_SPACE, '').trim(), context }
}

/**
 * The same peel over a whole message's content, leaving every part that is
 * not text exactly as it was.
 */
export const peelUserContent = <T extends { readonly type: string }>(
  content: readonly T[],
  options: PeelOptions,
  evidence: NoteEvidence = {},
): { readonly content: readonly T[]; readonly context: readonly UserContext[] } => {
  const context: UserContext[] = []
  const peeled = content.map((part) => {
    if (part.type !== 'text') return part
    const text = (part as { readonly text?: unknown }).text
    if (typeof text !== 'string') return part
    const result = peelContext(text, options, evidence)
    if (result.context.length === 0) return part
    context.push(...result.context)
    return { ...part, text: result.text }
  })
  // A part that was nothing but envelope leaves an empty string behind; a
  // bubble with no words in it is not a bubble.
  const kept = peeled.filter(
    (part) => part.type !== 'text' || (part as { readonly text?: unknown }).text !== '',
  )
  return { content: kept, context }
}
