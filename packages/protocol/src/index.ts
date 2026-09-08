/**
 * `@harnessdesk/protocol` — the runtime-agnostic vocabulary.
 *
 * Everything above the adapter layer speaks only these types. If a Codex, Claude,
 * or Gemini identifier appears in a signature here, the layering has been broken.
 */

export * from './errors.js'
export * from './ids.js'
export * from './items.js'
export * from './plan.js'
export * from './tasks.js'
export * from './user-context.js'
export * from './session.js'
export * from './usage.js'
export * from './options.js'
export * from './approval.js'
export * from './events.js'
export * from './runtime.js'
export * from './wire.js'
export * from './validate.js'
export * from './wire-validators.js'
export * from './capability.js'
export * from './editor.js'
export * from './team.js'
export * from './context-envelope.js'
export * from './library.js'
export * from './reduce.js'
