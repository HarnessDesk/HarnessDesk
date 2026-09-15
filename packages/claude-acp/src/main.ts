#!/usr/bin/env node
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk'

import { HarnessDeskClaudeAgent } from './bridge.js'

/**
 * `claude-acp` — Claude Code as an ACP agent, on stdio.
 *
 * The official Claude Agent ACP entry point applies managed settings first,
 * keeps every console channel on stderr, then serves ACP on stdout. HarnessDesk
 * uses the same public bridge contract with its own agent metadata and
 * extensions.
 * `CLAUDE_CODE_EXECUTABLE` still names the Claude Code to drive;
 * `CLAUDE_ACP_STATE_DIR` is where per-session effort is remembered.
 */
const policy = await resolveSettings({ settingSources: [] })
for (const [key, value] of Object.entries(policy.effective.env ?? {})) process.env[key] = value
console.log = console.error
console.info = console.error
console.warn = console.error
console.debug = console.error
process.on('unhandledRejection', (reason) => {
  console.error('claude-acp: unhandled rejection', reason)
})

HarnessDeskClaudeAgent.serve()
process.stdin.resume()
