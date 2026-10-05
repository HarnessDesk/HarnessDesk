import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./ci-changes.mjs', import.meta.url))
const check = (paths, expected, event = 'pull_request') => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-changes-'))
  try {
    const list = join(directory, 'paths')
    if (paths !== null) writeFileSync(list, paths.length ? `${paths.join('\0')}\0` : '')
    const result = spawnSync(process.execPath, [script, list], {
      encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `browser=${expected[0]}\nnative=${expected[1]}\n`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const path of [
  'packages/ui/src/App.tsx', 'packages/protocol/src/wire.ts',
  'packages/client/src/views/index.ts', 'packages/server/src/host.ts',
  'packages/plugins/src/index.ts', 'packages/adapter-codex/test/fixtures/fake-codex.mjs',
  'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.node-version',
  'tsconfig.base.json', '.github/workflows/ci.yml', 'script/ci-changes.mjs',
  'script/copy-fixtures.mjs', 'script/prune-dist.mjs', 'script/check-secrets.mjs',
  'script/shots/audit.mjs', 'assets/avatars/128/blue.png',
]) {
  test(`${path} runs both suites (shared build or loaded input)`, () => check([path], [true, true]))
}
for (const path of ['docs/architecture.md', 'CONTRIBUTING.md', 'script/land-safe.mjs']) {
  test(`${path} skips both suites`, () => check([path], [false, false]))
}
for (const path of ['e2e/ui-system/layout.spec.ts', 'playwright.ui-system.config.ts']) {
  test(`${path} runs the browser suite`, () => check([path], [true, false]))
}
for (const path of ['packages/desktop/electron/main.mjs', 'script/shots/seed.mjs', 'script/lib/temporary-directory.mjs']) {
  test(`${path} runs native smoke`, () => check([path], [false, true]))
}
test('native smoke runner runs both suites because it is also in the browser test directory', () =>
  check(['e2e/ui-system/native-smoke.mjs'], [true, true]))
test('empty input runs everything', () => check([], [true, true]))
test('unreadable input runs everything', () => check(null, [true, true]))
test('push to main or a tag runs everything even for docs', () => check(['docs/architecture.md'], [true, true], 'push'))
test('NUL input preserves filenames with spaces and newlines', () =>
  check(['docs/line\nbreak.md', 'docs/a b.md'], [false, false]))
test('a mixed change runs each affected suite', () =>
  check(['docs/architecture.md', 'packages/desktop/electron/main.mjs', 'e2e/ui-system/layout.spec.ts'], [true, true]))
