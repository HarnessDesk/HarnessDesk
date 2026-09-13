#!/usr/bin/env node
/**
 * Catches half-applied normalisation and validation helpers.
 *
 * Three defects merged and caught shared one shape (#343):
 * A file defines or imports a helper whose purpose is to normalise, compare,
 * or validate a domain value (such as paths or identifiers), and elsewhere
 * in the same file or module that same value is compared or handled raw:
 *
 * 1. PR #327: `samePath` was added in `worktree.ts`, but `putBack()` still
 *    used strict `entry.path === target`.
 * 2. PR #329: `chatPath` validates against `CHAT_ID`, but `rmSync` deleted
 *    `join(tmpdir(), 'harnessdesk-cursor-acp', chatId)` without validation.
 * 3. PR #319: `isDirectory` was duplicated across host and adapter without
 *    reference pinning comments.
 *
 * This check scans TypeScript source files for:
 * - Direct strict equality comparisons (`===` or `!==`) on path variables
 *   in files that define or import path-equality helpers like `samePath`.
 * - Unvalidated path interpolation into filesystem removal operations (`rm` / `rmSync`).
 * - Unpinned duplicate helper declarations across layers.
 *
 *   node script/check-half-applied-fixes.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { withoutComments } from './lib/without-comments.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGES_DIR = join(root, 'packages')

/** Walk TypeScript source files under packages, skipping dist, node_modules, tests */
export const walkSources = (dir) => {
  const files = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'test' || entry.name === 'fixtures') continue
      files.push(...walkSources(full))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(full)
    }
  }
  return files
}

/**
 * Check if a file defines or imports `samePath` but uses raw `===` or `!==`
 * on path variables (`entry.path === target`, `a.path === b.path`, etc.)
 */
export const checkRawPathComparisons = (source, fileName = 'source.ts') => {
  const issues = []
  if (!/\bsamePath\b/.test(source)) return issues

  // Parse with TypeScript AST
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)

  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const leftText = node.left.getText(sf)
      const rightText = node.right.getText(sf)

      const isPathLike = (text) =>
        /(?:path|target|dir|cwd|root|file)\b/i.test(text) &&
        !/^(?:type|kind|status|mode|id|key)\b/i.test(text)

      // Specifically catch path comparisons like entry.path === target
      const leftIsPath = isPathLike(leftText)
      const rightIsPath = isPathLike(rightText)

      if (leftIsPath && rightIsPath) {
        // Exclude comparisons against literal strings (like '' or '/') unless both are paths
        const isLiteral = (n) => ts.isStringLiteral(n) || n.kind === ts.SyntaxKind.NullKeyword
        if (!isLiteral(node.left) && !isLiteral(node.right)) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
          issues.push({
            rule: 'path-comparison-bypass',
            file: fileName,
            line: line + 1,
            column: character + 1,
            text: node.getText(sf),
            message: `File uses samePath but compares paths directly with ${node.operatorToken.getText(sf)}: "${node.getText(sf)}"`,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return issues
}

/**
 * Check for unvalidated path traversal or ID deletion in files that define validation helpers
 */
export const checkUnvalidatedDeletions = (source, fileName = 'source.ts') => {
  const issues = []
  if (!/\b(?:rmSync|rm)\s*\(/.test(source)) return issues
  if (!/\b(?:CHAT_ID|chatPath|validate|sessionId)\b/.test(source)) return issues

  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)

  const tmpdirVars = new Set()

  const isTmpdirExpr = (node) => {
    let hasTmp = false
    const walk = (n) => {
      if (hasTmp) return
      if (ts.isCallExpression(n)) {
        const text = n.expression.getText(sf)
        if (text === 'tmpdir' || text.endsWith('.tmpdir')) {
          hasTmp = true
          return
        }
      }
      if (ts.isIdentifier(n) && tmpdirVars.has(n.text)) {
        hasTmp = true
        return
      }
      ts.forEachChild(n, walk)
    }
    walk(node)
    return hasTmp
  }

  let changed = true
  while (changed) {
    changed = false
    const scanVars = (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (!tmpdirVars.has(n.name.text) && isTmpdirExpr(n.initializer)) {
          tmpdirVars.add(n.name.text)
          changed = true
        }
      }
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) &&
        n.right
      ) {
        if (!tmpdirVars.has(n.left.text) && isTmpdirExpr(n.right)) {
          tmpdirVars.add(n.left.text)
          changed = true
        }
      }
      ts.forEachChild(n, scanVars)
    }
    scanVars(sf)
  }

  const isRmCall = (node) => {
    if (!ts.isCallExpression(node)) return false
    const expText = node.expression.getText(sf)
    return expText === 'rm' || expText === 'rmSync' || expText.endsWith('.rm') || expText.endsWith('.rmSync')
  }

  const visit = (node) => {
    if (isRmCall(node)) {
      const firstArg = node.arguments[0]
      if (firstArg) {
        let targetVar = null
        let isDirectTmpdir = false

        if (ts.isIdentifier(firstArg) && tmpdirVars.has(firstArg.text)) {
          targetVar = firstArg.text
        } else if (isTmpdirExpr(firstArg)) {
          isDirectTmpdir = true
        }

        if (targetVar || isDirectTmpdir) {
          let isGuarded = false
          let curr = node.parent
          while (curr) {
            if (ts.isIfStatement(curr)) {
              if (curr.thenStatement.pos <= node.pos && node.end <= curr.thenStatement.end) {
                const condText = curr.expression.getText(sf)
                if (targetVar) {
                  const regex = new RegExp(`\\b${targetVar}\\s*\\.\\s*startsWith\\s*\\(`)
                  if (regex.test(condText)) {
                    isGuarded = true
                    break
                  }
                } else if (isDirectTmpdir) {
                  const firstArgText = firstArg.getText(sf)
                  if (condText.includes(firstArgText) && condText.includes('.startsWith(')) {
                    isGuarded = true
                    break
                  }
                }
              }
            }
            curr = curr.parent
          }

          if (!isGuarded) {
            const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
            issues.push({
              rule: 'unvalidated-deletion',
              file: fileName,
              line: line + 1,
              column: character + 1,
              text: firstArg.getText(sf),
              message: `rm/rmSync target under tmpdir does not verify containment before removal: "${firstArg.getText(sf)}"`,
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return issues
}

/**
 * Check for duplicate domain helper functions that cross boundaries (e.g. host and adapter)
 * and require documentation pin comments referencing their counterpart.
 */
export const checkDuplicateHelperPins = (source, fileName = 'source.ts') => {
  const issues = []
  if (!/\bisDirectory\b/.test(source)) return issues

  // If a file declares isDirectory, check if it explicitly pins/references the counterpart
  const isHost = fileName.includes('server/src/host.ts')
  const isAdapter = fileName.includes('adapter-acp/src/runtime.ts')

  if (isHost || isAdapter) {
    const counterpart = isHost ? 'packages/adapter-acp/src/runtime.ts' : 'packages/server/src/host.ts'
    if (!source.includes(counterpart)) {
      issues.push({
        rule: 'unpinned-duplicate-helper',
        file: fileName,
        line: 1,
        column: 1,
        text: 'isDirectory',
        message: `Helper isDirectory is duplicated across layers and must reference its counterpart in ${counterpart}`,
      })
    }
  }
  return issues
}

export const auditFile = (filePath, content = null) => {
  const raw = content ?? readFileSync(filePath, 'utf8')
  const stripped = withoutComments(raw, filePath)
  return [
    ...checkRawPathComparisons(stripped, filePath),
    ...checkUnvalidatedDeletions(stripped, filePath),
    ...checkDuplicateHelperPins(raw, filePath),
  ]
}

export const runAudit = (targetDir = PACKAGES_DIR) => {
  const files = walkSources(targetDir)
  const allIssues = []
  for (const file of files) {
    const fileIssues = auditFile(file)
    allIssues.push(...fileIssues)
  }
  return allIssues
}

const isMain =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const issues = runAudit()
  if (issues.length > 0) {
    console.error(`Found ${issues.length} half-applied fix violation(s):\n`)
    for (const issue of issues) {
      console.error(
        `  ${relative(root, issue.file)}:${issue.line}:${issue.column} - ${issue.message}`,
      )
    }
    process.exit(1)
  } else {
    console.log('Half-applied fix check passed cleanly (0 violations).')
  }
}
