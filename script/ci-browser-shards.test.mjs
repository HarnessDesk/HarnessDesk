import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const job = (name) => {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'))
  assert.ok(match, `CI must keep the ${name} job`)
  return match[1]
}

test('browser CI spreads the suite across six shards with time for setup and reports (#1140)', () => {
  const browser = job('ui-system-browser')
  assert.match(browser, /^    name: UI system browser integration shard \$\{\{ matrix.shard \}\}\/6$/m)
  assert.match(browser, /^        shard: \[1, 2, 3, 4, 5, 6\]$/m)
  assert.match(browser, /^    timeout-minutes: 30$/m)
  assert.match(browser, /^      - run: pnpm test:ui-system --shard=\$\{\{ matrix.shard \}\}\/6$/m)
  assert.match(browser, /^      fail-fast: false$/m)
})

test('the stable browser check requires every shard and keeps reports after failure (#1140)', () => {
  const aggregate = job('ui-system-browser-integration')
  assert.match(aggregate, /^    name: UI system browser integration$/m)
  assert.match(aggregate, /^    needs: ui-system-browser$/m)
  assert.match(aggregate, /^    if: always\(\)$/m)
  assert.match(aggregate, /SHARDS_RESULT: \$\{\{ needs.ui-system-browser.result \}\}/)
  assert.match(aggregate, /if \[ "\$SHARDS_RESULT" != "success" \]; then[\s\S]*?exit 1/)
  assert.match(job('ui-system-browser'), /- uses: actions\/upload-artifact@\S+\n        if: always\(\)\n        with:\n          name: ui-system-browser-report-\$\{\{ matrix.shard \}\}/)
})
