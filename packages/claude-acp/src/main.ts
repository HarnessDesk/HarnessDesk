#!/usr/bin/env node
/*
 * Follows the entry point of `@zed-industries/claude-code-acp` (Apache 2.0,
 * Copyright Zed Industries, Inc. and contributors), with this package's agent
 * in place of its own. Licence: licenses/Apache-2.0.txt.
 */
import { applyEnvironmentSettings, loadManagedSettings } from '@zed-industries/claude-code-acp'

import { HarnessDeskClaudeAgent } from './bridge.js'

/**
 * `claude-acp` — Claude Code as an ACP agent, on stdio.
 *
 * What `@zed-industries/claude-code-acp`'s own entry point does, with this
 * package's agent in place of its own: managed settings first, every console
 * channel to stderr so nothing but ACP reaches stdout, then serve.
 * `CLAUDE_CODE_EXECUTABLE` still names the Claude Code to drive;
 * `CLAUDE_ACP_STATE_DIR` is where per-session effort is remembered.
 */
const managed = loadManagedSettings()
if (managed) applyEnvironmentSettings(managed)
console.log = console.error
console.info = console.error
console.warn = console.error
console.debug = console.error
process.on('unhandledRejection', (reason) => {
  console.error('claude-acp: unhandled rejection', reason)
})

HarnessDeskClaudeAgent.serve()
process.stdin.resume()
