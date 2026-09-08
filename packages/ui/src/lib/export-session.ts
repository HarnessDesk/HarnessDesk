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

const fence = (body: string, language = ''): string => `\n\`\`\`${language}\n${body}\n\`\`\`\n`

const heading = (session: Session): string => {
  const lines = [`# ${session.title?.trim() || session.preview?.trim() || 'Session'}`, '']
  lines.push(`- **Workspace:** \`${session.cwd}\``)
  if (session.git?.branch) lines.push(`- **Branch:** \`${session.git.branch}\``)
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
                .map((part) => (part.type === 'mention' ? `\`${part.name}\`` : ''))
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
          out.push(`**Ran** \`${item.command}\`${item.exitCode ? ` → exit ${item.exitCode}` : ''}`)
          if (item.output?.trim()) out.push(fence(item.output.trim()))
          break
        case 'fileChange':
          for (const change of item.changes) {
            out.push(`**${change.kind.type === 'add' ? 'Created' : change.kind.type === 'delete' ? 'Deleted' : 'Edited'}** \`${change.path}\``)
            if (change.diff.trim()) out.push(fence(change.diff.trim(), 'diff'))
          }
          break
        case 'toolCall':
          out.push(
            `**Tool** \`${item.source.kind === 'mcp' ? `${item.source.server}/` : ''}${item.tool}\`` +
              (item.error ? ` — failed: ${item.error}` : ''),
          )
          break
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
