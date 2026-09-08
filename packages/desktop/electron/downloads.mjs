import { existsSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * Where a page's download goes, and what it is called.
 *
 * A `<webview>` guest with nobody listening for `will-download` drops the
 * file on the floor: no dialog, no file, no word — measured on 2026-09-06,
 * a click on "Download report.csv" in the pane produced nothing anywhere.
 * The pane is a browser, and a browser puts downloads in the Downloads
 * folder under the name the server gave, numbering a second copy rather
 * than replacing the first. Pure, so the naming is tested without a disk.
 */

/**
 * The name a server sent, made safe to join onto the Downloads folder.
 *
 * Separators become dashes, and so do the two characters that are not
 * separators here but are elsewhere — a colon (a path separator to the
 * Finder, and to HFS) and a NUL (which every `fs` call refuses, and which
 * `setSavePath` would refuse inside a `will-download` callback, where a
 * throw is an uncaught exception in the main process).
 *
 * `.` and `..` survive all of that and are the whole traversal: they carry
 * no separator, and `join(dir, '..')` is the folder *above* Downloads. A
 * name that is only dots is not a name.
 */
const safeName = (filename) => {
  const clean = String(filename || '')
    .replace(/[/\\:\u0000]/g, '-')
    .trim()
  return /^\.+$/.test(clean) || clean === '' ? 'download' : clean
}

/** `report.csv`, then `report (2).csv`, `report (3).csv` — never a replacement. */
export const uniqueName = (dir, filename, taken = (path) => existsSync(path)) => {
  const clean = safeName(filename)
  if (!taken(join(dir, clean))) return clean
  const ext = extname(clean)
  const stem = ext ? clean.slice(0, -ext.length) : clean
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken(join(dir, candidate))) return candidate
  }
  // A thousand copies of one name: the clock and a little chance, so two in
  // the same millisecond still differ.
  return `${stem} (${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)})${ext}`
}

/**
 * What the shell remembers having saved, so "Show in Finder" can only be
 * asked for a file it wrote. Bounded and oldest-first: a desk that runs for
 * weeks should not remember every file it ever saved, and the offer is about
 * the download just made.
 */
export const remember = (paths, path, cap) => {
  // Deleted first, because `Set.add` on a value already there does *not* move
  // it to the end. Without this, downloading a file whose path was remembered
  // long ago left that entry at the oldest position, and the next download
  // could evict the file just written — its own "Show in Finder" then quietly
  // refusing, for a file that had never been more recent.
  paths.delete(path)
  paths.add(path)
  while (paths.size > cap) paths.delete(paths.values().next().value)
  return paths
}

/** What the renderer is told when a download ends, in the words a notice uses. */
export const downloadOutcome = ({ name, path, state, bytes }) => ({
  name,
  path,
  ok: state === 'completed',
  bytes: Number.isFinite(bytes) ? bytes : 0,
  message:
    state === 'completed'
      ? `Downloaded ${name} to Downloads.`
      : state === 'cancelled'
        ? `The download of ${name} was cancelled.`
        : `The download of ${name} did not finish.`,
})
