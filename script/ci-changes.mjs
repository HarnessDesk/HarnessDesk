#!/usr/bin/env node
import { readFileSync } from 'node:fs'

// Shared inputs are written once and included in both job lists below.
const SHARED = [
  /^package\.json$/, // Root scripts and tool dependencies define both installs/builds.
  /^pnpm-lock\.yaml$/, // Both jobs install this exact dependency graph.
  /^pnpm-workspace\.yaml$/, // Defines the workspace packages both jobs resolve.
  /^\.node-version$/, // Root runtime/tool configuration.
  /^\.(?:npmrc|pnpmfile\.cjs)$/, // Package-manager configuration can change either install.
  /^tsconfig(?:\.[^/]*)?\.json$/, // Root solution and compiler options used by build:node.
  /^(?:vite|vitest|playwright|eslint|prettier|babel|postcss|tailwind)\.config\.[^/]+$/, // Root tool configuration.
  /^\.github\/workflows\/ci\.yml$/, // Changes to CI must exercise the whole new workflow.
  /^script\/ci-changes(?:\.test)?\.mjs$/, // Changes to the selection policy must exercise both suites.
  /^packages\/ui\//, // Preview harness for browser; built renderer for native smoke.
  /^packages\/(?!ui\/|desktop\/)[^/]+\//, // Root tsc solution builds all Node packages; fixture copy/prune also walk all packages. Includes UI's client/protocol dependencies and server fixtures imported by browser specs.
  /^script\/copy-fixtures\.mjs$/, // build:node copies fake-agent/test fixtures.
  /^script\/prune-dist\.mjs$/, // build:node validates/prunes the compiled output.
  /^assets\//, // UI imports avatar/brand images; the native shell also reads these assets.
  /^script\/shots\/(?:audit|cast)\.mjs$/, // Browser specs and native smoke use the frame audit and its synthetic identities.
  /^script\/check-secrets\.mjs$/, // The shared frame audit imports its public-text checks.
  /^script\/lib\/desk\.mjs$/, // Imported by the frame audit; native smoke also uses it to launch the desk.
]

const BROWSER = [
  ...SHARED,
  /^playwright\.ui-system\.config\.ts$/, // Defines the browser suite and its Vite preview server.
  /^e2e\/ui-system\//, // Browser specs, helpers and recorded metrics live in this test directory.
]

const NATIVE = [
  ...SHARED,
  /^packages\/desktop\//, // Real Electron shell starts the built server and adapters.
  /^e2e\/ui-system\/native-smoke\.mjs$/, // Native smoke entry point, including relaunch/appearance checks.
  /^script\/shots\//, // Native smoke seeds and drives the isolated fake-agent rig.
  /^script\/lib\//, // Native launch helpers and temporary-directory cleanup.
]

// The workflow writes git diff --name-only -z to a file. NUL delimiters keep
// spaces/newlines literal; --no-renames includes both paths of a moved input.
// Missing, empty or malformed input is uncertainty: run everything.
let decision = { browser: true, native: true }
if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
  try {
    const raw = readFileSync(process.argv[2], 'utf8')
    const paths = raw.endsWith('\0') ? raw.slice(0, -1).split('\0') : []
    if (paths.length > 0 && paths.every(path => path.length > 0 && !path.startsWith('/') && !path.split('/').includes('..'))) {
      decision = {
        browser: paths.some(path => BROWSER.some(pattern => pattern.test(path))),
        native: paths.some(path => NATIVE.some(pattern => pattern.test(path))),
      }
    }
  } catch {
    // A failed diff leaves no readable list. Non-PR events also run everything.
  }
}
process.stdout.write(`browser=${decision.browser}\nnative=${decision.native}\n`)
