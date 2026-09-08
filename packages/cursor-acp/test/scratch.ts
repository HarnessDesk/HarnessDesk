import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/**
 * One temp root for this test file's process, and for everything it spawns.
 *
 * The bridge writes each chat's tool plugin and each attached image under a
 * *fixed* path inside TMPDIR — production's path, shared by every cursor-acp
 * on the machine. `node --test` runs each test file in its own process, in
 * parallel, so the two files of this package used to share that root with
 * each other and with the developer's real cursor-agent; a per-file cleanup
 * that removed "whatever appeared while I ran" therefore removed directories
 * another process was still reading. That is what made the image test flaky
 * on CI: the file was written, and then deleted by the sibling file's
 * cleanup in the window between the bridge's write and the test's read.
 *
 * So TMPDIR itself moves, before anything has read it. `os.tmpdir()` consults
 * the variable on every call, and the runtime spawns the bridge with
 * `{ ...process.env, ...env }`, so the bridge — and the fake CLI under it —
 * land in here too. Nothing this file runs can now reach a path it did not
 * create, and the whole root goes at the end. A run of this package used to
 * leave 17 directories behind.
 */
export const SCRATCH_TMP = mkdtempSync(join(tmpdir(), 'cursor-acp-tmp-'))
process.env['TMPDIR'] = SCRATCH_TMP

after(() => {
  rmSync(SCRATCH_TMP, { recursive: true, force: true })
})

/**
 * A temp directory for one thing the tests need — a workspace, a state index,
 * a Cursor home. It lands inside {@link SCRATCH_TMP}, so it needs no cleanup
 * of its own: the root above takes it.
 */
export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
