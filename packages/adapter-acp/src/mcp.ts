import { execFile } from 'node:child_process'

import type { McpAuth, McpServer } from '@harnessdesk/protocol'

import type { AcpCommandSpec } from './account.js'

/**
 * MCP server listing for ACP agents, from the agent's own CLI.
 *
 * ACP has no MCP-management methods in its protocol. The CLIs behind the
 * agents do: `claude mcp list` and `cursor-agent mcp list` both report the
 * configured servers and their connection status. The registry entry names
 * those commands and this class turns them into the same `McpServer[]` the
 * Codex adapter returns from its own extension plane — read-only, because
 * install/uninstall/toggle are not yet carried over ACP.
 *
 * The output is human-readable with no JSON mode. Two forms are known:
 *
 * - Claude Code: `name: url/command - ✔ Connected` or `⏸ Pending approval`
 * - cursor-agent: `name: status`
 *
 * Both are parsed conservatively; unrecognised lines are skipped rather than
 * producing garbage entries.
 */
export interface AcpMcpCommands {
  readonly list: AcpCommandSpec
  readonly login?: AcpCommandSpec
}

export class CliMcp {
  constructor(
    private readonly commands: AcpMcpCommands,
    private readonly log?: (message: string, details?: unknown) => void,
  ) {}

  async list(): Promise<readonly McpServer[]> {
    try {
      const stdout = await this.#run(this.commands.list)
      return parseMcpList(stdout)
    } catch (error) {
      this.log?.('mcp list probe failed', { error: String(error) })
      return []
    }
  }

  async login(name: string): Promise<string> {
    const spec = this.commands.login
    if (!spec) throw new Error('This agent declares no MCP login command.')
    const stdout = await this.#run({
      command: spec.command,
      args: [...(spec.args ?? []), name],
      env: spec.env,
    })
    const match = /https?:\/\/[^\s"'<>]+/.exec(stdout)
    if (!match) throw new Error('The login command printed no URL to open.')
    return match[0]
  }

  #run(spec: AcpCommandSpec): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        spec.command,
        [...(spec.args ?? [])],
        { timeout: 20_000, env: { ...process.env, ...spec.env } },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim().split('\n').slice(-2).join(' · ') || error.message))
          else resolve(stdout)
        },
      )
    })
  }
}

/**
 * Parses the human-readable output of a CLI's `mcp list` subcommand into
 * `McpServer[]`. Supports two known formats:
 *
 * Claude Code 2.x: `<name>: <detail> - ✔ Connected`
 *                   `<name>: <detail> - ⏸ Pending approval (…)`
 *                   `<name>: <detail> - ✖ Failed (…)`
 *
 * cursor-agent:    `<name>: <status>`
 *
 * Lines that match neither pattern — headers, spinners, blanks — are skipped.
 */
export const parseMcpList = (stdout: string): McpServer[] => {
  const servers: McpServer[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('Checking')) continue
    const entry = parseClaudeLine(line) ?? parseCursorLine(line)
    if (entry) servers.push(entry)
  }
  return servers
}

const CLAUDE_LINE =
  /^(.+?):\s+.+?\s+-\s+(✔|⏸|✖|Connected|Pending|Failed|Disabled)\s*(.*)/

const parseClaudeLine = (line: string): McpServer | null => {
  const match = CLAUDE_LINE.exec(line)
  if (!match) return null
  const name = match[1]!.trim()
  const status = match[2]!
  return {
    name,
    tools: [],
    resources: 0,
    auth: statusToAuth(status),
  }
}

const CURSOR_LINE = /^([^:]+):\s*(ready|connected|failed|pending|disabled|error)\s*$/i

const parseCursorLine = (line: string): McpServer | null => {
  const match = CURSOR_LINE.exec(line)
  if (!match) return null
  return {
    name: match[1]!.trim(),
    tools: [],
    resources: 0,
    auth: statusToAuth(match[2]!),
  }
}

const statusToAuth = (raw: string): McpAuth => {
  const s = raw.toLowerCase()
  if (s === '✔' || s === 'connected' || s === 'ready') return 'none'
  if (s === '⏸' || s.startsWith('pending')) return 'needsLogin'
  return 'none'
}
