import { allItems, type Session } from '@harnessdesk/protocol'

import { splitContext } from './context-envelope'

/**
 * Exporting a session as Markdown.
 *
 * A transcript is often the most useful artefact of a session — for a PR
 * description, a bug report, or a colleague. Markdown rather than JSON because
 * the audience is a person; the raw rollout already lives in the runtime's own
 * store for anything machine-readable.
 */

/**
 * A fenced block, with a fence longer than any run of backticks inside it.
 *
 * A body carrying a ``` line of its own — a command that cats a README, an
 * agent quoting code — would otherwise close the block early and spill the
 * rest of the transcript into the document as prose. Three backticks for
 * everything else, so an ordinary export is byte-for-byte what it was.
 */
const fence = (body: string, language = ''): string => {
  const runs = [...body.matchAll(/`+/g)].map((run) => run[0].length)
  const marker = '`'.repeat(Math.max(2, ...runs) + 1)
  return `\n${marker}${language}\n${body}\n${marker}\n`
}

/**
 * `text` as inline code, whatever is in it.
 *
 * A value interpolated between two backticks opens a code span that never
 * closes when it carries a backtick of its own, and everything after it on the
 * line stops being formatted. These values come off the wire — a tool's name, a
 * command with a `$(…)` in it, a branch — so none of them is ours to trust.
 * CommonMark's own answer: a longer run, padded with a space where the text
 * begins or ends with a backtick.
 */
const code = (text: string): string => {
  if (!text.includes('`')) return `\`${text}\``
  const runs = [...text.matchAll(/`+/g)].map((run) => run[0].length)
  const marker = '`'.repeat(Math.max(...runs) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${marker}${pad}${text}${pad}${marker}`
}

const heading = (session: Session): string => {
  const lines = [`# ${session.title?.trim() || session.preview?.trim() || 'Session'}`, '']
  lines.push(`- **Workspace:** ${code(session.cwd)}`)
  if (session.git?.branch) lines.push(`- **Branch:** ${code(session.git.branch)}`)
  if (session.settings?.model) lines.push(`- **Model:** ${session.settings.model}`)
  lines.push(`- **Started:** ${new Date(session.createdAt).toLocaleString()}`)
  if (session.usage) {
    lines.push(
      `- **Tokens:** ${session.usage.total.inputTokens.toLocaleString()} in · ` +
        `${session.usage.total.outputTokens.toLocaleString()} out`,
    )
  }
  lines.push('')
  return lines.join('\n')
}

export const sessionToMarkdown = (session: Session): string => {
  const out: string[] = [heading(session)]

  for (const [index, turn] of session.turns.entries()) {
    out.push(`## Turn ${index + 1}${turn.status !== 'completed' ? ` (${turn.status})` : ''}\n`)

    for (const item of turn.items) {
      switch (item.type) {
        case 'userMessage': {
          const raw = item.content
            .filter((part) => part.type === 'text')
            .map((part) => (part.type === 'text' ? part.text : ''))
            .join('\n')
          const { injections, text } = splitContext(raw)
          for (const injection of injections) {
            out.push(`> _Context added — ${injection.label}_\n`)
          }
          const mentions = item.content.filter((part) => part.type === 'mention')
          if (mentions.length > 0) {
            out.push(
              `_Attached: ${mentions
                .map((part) => (part.type === 'mention' ? code(part.name) : ''))
                .join(', ')}_\n`,
            )
          }
          if (text.trim()) out.push(`**You:** ${text}\n`)
          break
        }
        case 'assistantMessage':
          if (item.text.trim()) out.push(`${item.text}\n`)
          break
        case 'reasoning':
          if (item.summary.length > 0) {
            out.push(`<details><summary>Reasoning</summary>\n\n${item.summary.join('\n\n')}\n\n</details>\n`)
          }
          break
        case 'command':
          out.push(`**Ran** ${code(item.command)}${item.exitCode ? ` → exit ${item.exitCode}` : ''}`)
          if (item.output?.trim()) out.push(fence(item.output.trim()))
          break
        case 'fileChange':
          for (const change of item.changes) {
            out.push(`**${change.kind.type === 'add' ? 'Created' : change.kind.type === 'delete' ? 'Deleted' : 'Edited'}** ${code(change.path)}`)
            if (change.diff.trim()) out.push(fence(change.diff.trim(), 'diff'))
          }
          break
        case 'toolCall': {
          const name = `${item.source.kind === 'mcp' ? `${item.source.server}/` : ''}${item.tool}`
          /* The reason a failed call gives is the agent's own text of any
             shape: since #241 it is what the call actually said, and since
             #245 that can be several parts joined with newlines. Inlined
             after an em dash, its second line left the list item and became
             Markdown of its own — a heading, a list, a rule — and a backtick
             in it opened a code span that never closed. It goes where a
             command's output goes: a fence (#273). */
          const reason = item.error?.trim() ?? ''
          out.push(`**Tool** ${code(name)}${reason ? ' — failed:' : ''}`)
          if (reason) out.push(fence(reason))
          break
        }
        case 'webSearch':
          out.push(`**Searched the web** for "${item.query}"\n`)
          break
        case 'plan':
          out.push(`**Plan**\n\n${item.text}\n`)
          break
        case 'compaction':
          out.push(`_Earlier messages were summarised to free up context._\n`)
          break
        case 'notice':
          out.push(`_${item.text}_\n`)
          break
        case 'error':
          out.push(`> **Error:** ${item.message}\n`)
          break
        default:
          break
      }
    }

    if (turn.diff?.trim()) {
      out.push(`<details><summary>Turn diff</summary>\n${fence(turn.diff.trim(), 'diff')}\n</details>\n`)
    }
  }

  if (allItems(session).length === 0) out.push('_This session has no messages yet._\n')
  return out.join('\n')
}

/**
 * Offers the file to the user.
 *
 * An object URL rather than a data URL because a long transcript exceeds what
 * some browsers accept in a data URL, and truncating an export silently would be
 * the worst possible failure for it.
 */
export const downloadMarkdown = (filename: string, body: string): void => {
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export const exportFilename = (session: Session): string => {
  const base = (session.title?.trim() || session.preview?.trim() || 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const date = new Date(session.updatedAt).toISOString().slice(0, 10)
  return `${base || 'session'}-${date}.md`
}
