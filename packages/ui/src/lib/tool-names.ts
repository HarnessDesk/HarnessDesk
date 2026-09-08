import type { CapabilityContribution, PluginInstance } from '@harnessdesk/protocol'

/**
 * A tool call, said the way a person would say it.
 *
 * A wire name — `browser_open`, `mcp__harnessdesk__browser_click` — is what
 * you need to write a permission rule against, and it is the answer on the
 * Permissions page and inside an opened step. It is not what you need when
 * you are reading a history of what an agent did, so everywhere a step is
 * summarised it reads as a sentence instead.
 *
 * Where a plugin described its own tool, that description is the sentence.
 * Where it did not, the identifier is turned back into words, which is a poor
 * sentence but a better row than a symbol.
 */

/**
 * The name a plugin registered, recovered from the name an agent called.
 *
 * Agents namespace the tools a host lends them and they do not agree on how:
 * Claude Code sends `mcp__harnessdesk__browser_open`, Codex sends
 * `browser_open`. Both are the same tool, and a lookup that only knows one of
 * the spellings silently works for one agent and not the other.
 */
export const bareToolName = (tool: string): string => {
  if (isPhrase(tool)) return tool
  const parts = tool.split('__').filter(Boolean)
  return (parts.length > 1 ? parts[parts.length - 1] : tool) ?? tool
}

/**
 * Whether an adapter already handed over words rather than an identifier.
 *
 * Claude Code names a write `Write /path/to/file`. That is a sentence
 * already, and taking it apart the way an identifier is taken apart turns the
 * path into a row of unrelated words.
 */
const isPhrase = (tool: string): boolean => /[\s/]/.test(tool)

/**
 * Adapters wrap a command in backticks because they expect a markdown
 * renderer. A transcript row is not one, so the marks arrive as themselves and
 * the row shows its own source code.
 */
const unbacktick = (tool: string): string => {
  const trimmed = tool.trim()
  return trimmed.length > 1 && trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1).trim()
    : trimmed
}

/**
 * The command a shell was asked to run, without the shell.
 *
 * Codex hands every command over as an argv that begins with a login shell —
 * `/bin/zsh -lc 'echo hi'` — and its own transcript shows `echo hi`. The
 * wrapper is how the agent runs things, not what it ran, and a row that
 * prints it spends its width on the same eleven characters every time.
 *
 * Only a wrapper that is unmistakably one is removed: a shell by name, a
 * `-c` flag, and a single argument after it. Anything else is returned whole,
 * because a command we cannot parse is still a command someone ran.
 */
export const shellCommandOf = (command: string): string => {
  const match = /^(?:\S*\/)?(?:ba|z|k|da|fi)?sh\s+-[a-zA-Z]*c\s+([\s\S]+)$/.exec(command.trim())
  if (!match?.[1]) return command
  const rest = match[1].trim()
  const quote = rest.charAt(0)
  const quoted = (quote === "'" || quote === '"') && rest.length > 1 && rest.endsWith(quote)
  // Only unwrap when the quotes are the outermost pair; a command containing
  // the same quote inside would lose its shape.
  return quoted && !rest.slice(1, -1).includes(quote) ? rest.slice(1, -1) : rest
}

/** The identifier as words: `browser_open` → "Browser open". */
export const toolWords = (tool: string): string => {
  const bare = unbacktick(bareToolName(tool))
  if (isPhrase(bare)) return bare
  // `TaskOutput`, `WebFetch`: a CamelCase identifier is two words that the
  // row would otherwise print as one token — a wire name wearing a capital.
  // Split at each lower-to-upper seam and set the rest in sentence case;
  // an all-caps word (an acronym) keeps its capitals.
  const words = bare
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((word, index) => (index > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * The wire name, when there is one worth showing.
 *
 * Inside an opened step it answers "what do I write a permission rule
 * against" — but only when it *is* an identifier. Claude Code sends the
 * command itself as the tool name, so for those calls the "wire name" is the
 * same string the row already shows, and printing it under the row is not
 * disclosure, it is the sentence twice.
 */
export const wireNameOf = (tool: string): string | null => {
  const clean = unbacktick(tool)
  return clean.length === 0 || isPhrase(clean) ? null : clean
}

/**
 * Every tool the host lends agents, by every name one might call it.
 *
 * Built once from the contributions and reused, because a transcript asks
 * this question for every row it draws.
 */
export const toolSentences = (
  contributions: readonly CapabilityContribution[],
): ReadonlyMap<string, string> => {
  const out = new Map<string, string>()
  for (const contribution of contributions) {
    if (contribution.kind !== 'tool') continue
    const sentence = contribution.description.split('. ')[0]?.trim()
    if (!sentence) continue
    out.set(contribution.name, sentence)
    out.set(`${contribution.namespace}_${contribution.name}`, sentence)
  }
  return out
}

/** What this call did, as a sentence. Falls back to the identifier as words. */
export const toolSentence = (
  tool: string,
  sentences: ReadonlyMap<string, string>,
): string => sentences.get(bareToolName(tool)) ?? sentences.get(tool) ?? toolWords(tool)

/**
 * The tools one plugin lends, by the bare name an agent calls them.
 *
 * Used where a surface cares *which* plugin is acting rather than what the
 * call is called — the browser pane, which has to know whether the step in
 * flight is one of its own.
 */
export const toolsOfPlugin = (
  pluginId: string,
  plugins: readonly PluginInstance[],
  contributions: readonly CapabilityContribution[],
): ReadonlyMap<string, string> => {
  const owners = new Set(
    plugins.filter((instance) => instance.identity.id === pluginId).map((instance) => instance.instanceId),
  )
  const out = new Map<string, string>()
  for (const contribution of contributions) {
    if (contribution.kind !== 'tool' || !owners.has(contribution.owner)) continue
    const sentence = contribution.description.split('. ')[0]?.trim() ?? contribution.name
    out.set(contribution.name, sentence)
  }
  return out
}
