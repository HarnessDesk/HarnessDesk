/**
 * `@harnessdesk/adapter-codex` — the only place both vocabularies are in scope.
 *
 * Codex types must not appear in any signature this module exports.
 */

export { CodexRuntime, type CodexRuntimeOptions } from './runtime.js'
export { CODEX_RUNTIME_ID } from './mapping/session.js'
