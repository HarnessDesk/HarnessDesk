/**
 * Re-exported, not re-implemented.
 *
 * `shortPath` is shared with the write engine, which prints the same paths
 * into the `---`/`+++` labels of every diff it previews — so it lives in the
 * protocol package that both sides already depend on. This file stays as the
 * name the renderer imports it under.
 */
export { shortPath } from '@harnessdesk/protocol'
