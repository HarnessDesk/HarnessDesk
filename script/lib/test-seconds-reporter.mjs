/**
 * A `node --test` reporter that writes each file's measured seconds as JSON,
 * keyed by its path from the repository root: the sum of its top-level tests'
 * durations. `node script/node-tests.mjs --refresh` folds these into
 * `script/node-test-durations.json`, which deals the CI jobs.
 */
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')

export default async function * testSeconds (source) {
  const files = new Map()
  for await (const event of source) {
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || event.data.nesting !== 0 || !event.data.file) continue
    const file = relative(ROOT, event.data.file)
    files.set(file, (files.get(file) ?? 0) + (event.data.details?.duration_ms ?? 0))
  }
  yield `${JSON.stringify(Object.fromEntries([...files].map(([file, ms]) => [file, Math.round(ms / 100) / 10])), null, 2)}\n`
}
