#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { repositoryFiles } from './lib/repository-files.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_SOURCE = 'packages/ui/src/'
const PRIMITIVE_SOURCE = 'packages/ui/src/design/ui/'
const HEADLESS = /^(?:@base-ui\/react(?:\/|$)|radix-ui$|@radix-ui\/)/
const ALTERNATE_HEADLESS = /^(?:radix-ui$|@radix-ui\/)/
const LEGACY = /(?:^|\/)(?:primitives\/(?:Kit|Dialog)|components\/(?:Menu|Popover))$/
const RETIRED_SIBLING = /^(?:\.\/|\.\.\/)(?:Menu|Popover)$/
const INTERNAL_DESIGN_API = /(?:^@\/design\/|(?:^|\/)design\/)(?:ui|patterns|primitives)(?:\/|$)/
const RAW_STYLE_EXPORT = /export\s*\{\s*styles\s+as\s+[A-Za-z_$][\w$]*\s*\}/
const TEST_SOURCE = /\.(?:spec|test)\.[cm]?[jt]sx?$/
const PRIVATE_TOKEN_AUTHORITIES = new Set([
  'packages/ui/src/styles/base.css',
  'packages/ui/src/styles/design-platform.css',
  'packages/ui/src/styles/editorial.css',
  'packages/ui/src/styles/shadcn-themes.css',
])
const RAW_CONTROL_AUTHORITIES = [
  'packages/ui/src/design/ui/',
  // Base UI Menu receives its semantic host through `render`; the raw node
  // is not an independent behavior or visual implementation.
  'packages/ui/src/design/patterns/Menu.tsx',
  // This pattern owns a polymorphic semantic menu row over canonical menu
  // behavior. Authority is explicit rather than depending on createElement.
  'packages/ui/src/design/patterns/Popover.tsx',
]
const CANONICAL_CONTROLS = new Set(['Button', 'Input', 'Textarea', 'NativeSelect'])
const CONTROL_LAYOUT_PROPERTY = /^(?:display|position|top|right|bottom|left|inset(?:-(?:inline|block|top|right|bottom|left))?|z-index|width|min-width|max-width|margin(?:-(?:top|right|bottom|left|inline|block))?|flex(?:-(?:basis|direction|flow|grow|shrink|wrap))?|grid(?:-(?:area|auto-columns|auto-flow|auto-rows|column|column-end|column-gap|column-start|gap|row|row-end|row-gap|row-start|template|template-areas|template-columns|template-rows))?|gap|row-gap|column-gap|align-(?:content|items|self)|justify-(?:content|items|self)|place-(?:content|items|self)|order|overflow(?:-[xy])?|overflow-wrap|word-break|text-overflow|white-space|text-align|vertical-align)$/
const CONTROL_VISUAL_UTILITY = /(?:^|:)(?:h-|min-h-|max-h-|p[trblxy]?-|rounded(?:-|$)|border(?:-|$)|bg-|text-(?!left$|right$|center$|justify$)|font-|leading-|shadow(?:-|$)|outline(?:-|$)|cursor-)/
const CONTROL_LAYOUT_UTILITY = /^(?:hd-no-drag$|block|inline|inline-block|inline-flex|flex|grid|relative|absolute|fixed|sticky|isolate|w-|min-w-|max-w-|-?m[trblxy]?-|inset-|top-|right-|bottom-|left-|z-|grow(?:-|$)|shrink(?:-|$)|basis-|flex-|grid-|col-|row-|order-|items-|justify-|content-|self-|place-|gap-|space-|overflow-|truncate$|whitespace-|break-|text-(?:left|right|center|justify)$)/

const classIsSelectorSubject = (selector, className) => selector.split(',').some((part) => {
  const safe = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // CSS identifiers escape punctuation such as the $ legal in a JS binding.
  part = part.replace(/\\([^\da-f\s])/gi, '$1')
  const match = new RegExp(`\\.${safe}(?![\\w$-])`).exec(part)
  if (!match) return false
  const suffix = part.slice(match.index + match[0].length).trim()
  return !/[ >+~]/.test(suffix.replace(/\([^)]*\)/g, ''))
})

const isPrivateTokenAuthority = (file) =>
  file.startsWith('packages/ui/src/design/foundation/') || PRIVATE_TOKEN_AUTHORITIES.has(file)

const isRawControlAuthority = (file) => RAW_CONTROL_AUTHORITIES.some((authority) =>
  authority.endsWith('/') ? file.startsWith(authority) : file === authority)

const parseSource = (file, source) => {
  const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind)
  const problem = ast.parseDiagnostics?.[0]
  if (problem) throw new Error(`${file}: TypeScript could not parse this file: ${ts.flattenDiagnosticMessageText(problem.messageText, ' ')}`)
  return ast
}

/** Only canonical overlay implementations and the app-window policy compose
 * low-level parts. AppWindow still uses the canonical modal/focus behavior. */
const isOverlayAuthority = (file) => /^packages\/ui\/src\/design\/(?:ui|patterns)\//.test(file)
const OVERLAY_PART = /^(?:Alert)?Dialog(?:Popup|Overlay|Viewport|Portal)$/

const createElementMatcher = (ast) => {
  const names = new Set(['createElement'])
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== 'react') continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) if ((binding.propertyName ?? binding.name).text === 'createElement') names.add(binding.name.text)
    }
  }
  return (callee) => ts.isIdentifier(callee)
    ? names.has(callee.text)
    : ts.isPropertyAccessExpression(callee) && callee.name.text === 'createElement'
}

export const overlayViolations = (file, source, ast = parseSource(file, source)) => {
  if (isOverlayAuthority(file)) return []
  const violations = []
  const appWindow = file === 'packages/ui/src/components/AppWindow.tsx'
  const isCreateElement = createElementMatcher(ast)
  const visit = (node) => {
    if (!appWindow && ts.isImportSpecifier(node) && OVERLAY_PART.test((node.propertyName ?? node.name).text)) {
      violations.push(`imports ${node.propertyName?.text ?? node.name.text} outside a canonical overlay policy`)
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const role = jsxAttribute(node, 'role', ast)?.initializer
      const value = role && ts.isJsxExpression(role) ? role.expression : role
      if (value && ts.isStringLiteral(value) && /^(?:alert)?dialog$/.test(value.text)) violations.push(`raw role="${value.text}" outside a canonical overlay policy`)
      const tag = node.tagName.getText(ast).split('.').at(-1)
      if (jsxAttribute(node, 'aria-modal', ast) && !(appWindow && tag === 'DialogPopup')) violations.push('aria-modal outside a canonical overlay policy')
      if (!appWindow && OVERLAY_PART.test(tag)) violations.push('uses dialog parts outside a canonical overlay policy')
    }
    if (ts.isCallExpression(node) && isCreateElement(node.expression)) {
      const [host, props] = node.arguments
      const tag = host && (ts.isIdentifier(host) ? host.text : ts.isPropertyAccessExpression(host) ? host.name.text : undefined)
      if (!appWindow && tag && OVERLAY_PART.test(tag)) violations.push('uses dialog parts outside a canonical overlay policy')
      if (props && ts.isObjectLiteralExpression(props)) {
        for (const property of props.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          const key = ts.isComputedPropertyName(property.name) ? property.name.expression : property.name
          const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null
          if (name === 'role' && ts.isStringLiteral(property.initializer) && /^(?:alert)?dialog$/.test(property.initializer.text)) {
            violations.push(`raw role="${property.initializer.text}" outside a canonical overlay policy`)
          }
          if (name === 'aria-modal' && !(appWindow && tag === 'DialogPopup')) violations.push('aria-modal outside a canonical overlay policy')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return [...new Set(violations)]
}

const jsxAttribute = (node, name, ast) => node.attributes.properties.find((attribute) =>
  ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === name)

const isNullJsxAttribute = (attribute) =>
  attribute
  && ts.isJsxAttribute(attribute)
  && attribute.initializer
  && ts.isJsxExpression(attribute.initializer)
  && attribute.initializer.expression?.kind === ts.SyntaxKind.NullKeyword

const moduleSpecifiers = (file, source) => {
  const ast = parseSource(file, source)
  const found = []
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

const stylesheetBindings = (file, source) => {
  const ast = parseSource(file, source)
  const found = new Map()
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (!statement.moduleSpecifier.text.endsWith('.module.css')) continue
    const binding = statement.importClause?.name?.text
    if (!binding) continue
    found.set(binding, path.posix.normalize(path.posix.join(path.posix.dirname(file), statement.moduleSpecifier.text)))
  }
  return found
}

const splitSelectors = (selector) => selector.split(',').map((part) => part.trim()).filter(Boolean)

/* A small structural CSS reader for the one question this gate asks. Regexing
   whole blocks skipped comments before declarations, property case, and CSS
   nesting. This walker balances braces and strings, keeps only direct
   declarations for each rule, and resolves nested selectors through `&`. */
const cssRules = (rawSource) => {
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const matchingBrace = (open, end) => {
    let depth = 1
    let quote = null
    for (let index = open + 1; index < end; index += 1) {
      const char = source[index]
      if (quote) {
        if (char === '\\') index += 1
        else if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '{') depth += 1
      else if (char === '}' && --depth === 0) return index
    }
    return end
  }
  const directDeclarations = (start, end) => {
    let direct = ''
    let cursor = start
    let quote = null
    while (cursor < end) {
      const char = source[cursor]
      if (quote) {
        direct += char
        if (char === '\\' && cursor + 1 < end) direct += source[++cursor]
        else if (char === quote) quote = null
        cursor += 1
        continue
      }
      if (char === '"' || char === "'") {
        quote = char
        direct += char
        cursor += 1
        continue
      }
      if (char === '{') {
        cursor = matchingBrace(cursor, end) + 1
        direct += ';'
        continue
      }
      direct += char
      cursor += 1
    }
    return [...direct.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;{}]+)/gi)]
      .map((match) => ({ property: match[1].toLowerCase(), value: match[2].trim() }))
  }
  const walk = (start, end, parents = []) => {
    let statementStart = start
    let quote = null
    let parens = 0
    for (let cursor = start; cursor < end; cursor += 1) {
      const char = source[cursor]
      if (quote) {
        if (char === '\\') cursor += 1
        else if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'") quote = char
      else if (char === '(') parens += 1
      else if (char === ')') parens = Math.max(0, parens - 1)
      else if (char === ';' && parens === 0) statementStart = cursor + 1
      else if (char === '{' && parens === 0) {
        const close = matchingBrace(cursor, end)
        const prelude = source.slice(statementStart, cursor).trim()
        if (prelude.startsWith('@')) {
          const declarations = directDeclarations(cursor + 1, close)
          if (parents.length > 0 && declarations.length > 0) {
            rules.push({ selector: parents.join(', '), declarations })
          }
          walk(cursor + 1, close, parents)
        } else if (prelude) {
          const own = splitSelectors(prelude)
          const selectors = parents.length === 0
            ? own
            : parents.flatMap((parent) => own.map((selector) => selector.includes('&')
              ? selector.replaceAll('&', parent)
              : `${parent} ${selector}`))
          rules.push({ selector: selectors.join(', '), declarations: directDeclarations(cursor + 1, close), empty: source.slice(cursor + 1, close).trim() === '' })
          walk(cursor + 1, close, selectors)
        }
        cursor = close
        statementStart = close + 1
      }
    }
  }
  walk(0, source.length)
  return rules
}

const cssClassControlOverrides = (source, className) => {
  const overrides = []
  for (const { selector, declarations } of cssRules(source)) {
    if (!classIsSelectorSubject(selector, className)) continue
    for (const { property, value } of declarations) {
      if (
        !CONTROL_LAYOUT_PROPERTY.test(property)
        || (property === 'display' && /^(?:none|contents)$/i.test(value))
        || (/^(?:width|max-width)$/.test(property) && /^(?:0|0px|0rem|0%)$/.test(value))
      ) overrides.push(`${property}: ${value.replace(/\s+/g, ' ')}`)
    }
  }
  return [...new Set(overrides)]
}

const staticClassTokens = (attribute, ast) => {
  if (!attribute?.initializer) return []
  const found = []
  const visit = (node) => {
    if (
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node)
    ) {
      found.push(...node.text.split(/\s+/).filter(Boolean))
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(attribute.initializer)
  return found
}

const utilityBase = (token) => {
  let depth = 0
  let last = -1
  for (let index = 0; index < token.length; index += 1) {
    if (token[index] === '[' || token[index] === '(') depth += 1
    else if (token[index] === ']' || token[index] === ')') depth -= 1
    else if (token[index] === ':' && depth === 0) last = index
  }
  return token.slice(last + 1)
}

const classNameIsStatic = (attribute, cssBindings) => {
  if (!attribute?.initializer) return true
  const known = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
    if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => known(span.expression))
    if (ts.isPropertyAccessExpression(node)) return ts.isIdentifier(node.expression) && cssBindings.has(node.expression.text)
    if (ts.isParenthesizedExpression(node)) return known(node.expression)
    if (ts.isConditionalExpression(node)) return known(node.whenTrue) && known(node.whenFalse)
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return known(node.left) && known(node.right)
      if ([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) return known(node.right)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['cn', 'clsx', 'cx'].includes(node.expression.text)) {
      return node.arguments.every(known)
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(known)
    if (node.kind === ts.SyntaxKind.NullKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.TrueKeyword) return true
    return false
  }
  if (ts.isStringLiteral(attribute.initializer)) return true
  return ts.isJsxExpression(attribute.initializer) && (!attribute.initializer.expression || known(attribute.initializer.expression))
}

export const scanUiArchitecture = (files) => {
  const findings = []
  const cssByPath = new Map(files.filter((file) => file.path.endsWith('.css')).map((file) => [file.path, file.source]))
  for (const file of files) {
    if (file.path.endsWith('.css')) {
      if (!isPrivateTokenAuthority(file.path) && /(?:var\(--hdp-|--hdp-[\w-]+\s*:)/.test(file.source)) {
        findings.push({ path: file.path, rule: 'private-platform-token', detail: 'only explicit foundation and theme files may read or define --hdp-*' })
      }
      if (!file.path.startsWith('packages/ui/src/design/')) {
        for (const rule of cssRules(file.source)) {
          if (rule.empty) findings.push({ path: file.path, rule: 'empty-feature-rule', detail: rule.selector })
        }
        for (const block of file.source.matchAll(/[^{}]+\{([^{}]+)\}/g)) {
          const body = block[1]
          const copiedButtonTokens = [
            /var\(--hd-btn-h(?:-sm)?\)/,
            /var\(--hd-btn-padding(?:-sm)?\)/,
            /var\(--hd-btn-radius\)/,
            /var\(--hd-btn-(?:fill|border)\)/,
          ].filter((token) => token.test(body)).length
          if (copiedButtonTokens >= 3) {
            findings.push({ path: file.path, rule: 'duplicate-button-styling', detail: 'feature CSS duplicates the canonical Button shape instead of selecting its variant and size' })
          }
        }
      }
      continue
    }
    if (RAW_STYLE_EXPORT.test(file.source)) {
      findings.push({ path: file.path, rule: 'raw-style-export', detail: 'export { styles as ... }' })
    }
    for (const specifier of moduleSpecifiers(file.path, file.source)) {
      if (LEGACY.test(specifier) || (RETIRED_SIBLING.test(specifier) && !file.path.startsWith('packages/ui/src/design/patterns/'))) {
        findings.push({ path: file.path, rule: 'legacy-design-api', detail: specifier })
      }
      if (HEADLESS.test(specifier) && file.path.startsWith(UI_SOURCE) && !file.path.startsWith(PRIMITIVE_SOURCE)) {
        findings.push({ path: file.path, rule: 'feature-headless-import', detail: specifier })
      }
      if (ALTERNATE_HEADLESS.test(specifier)) {
        findings.push({ path: file.path, rule: 'alternate-headless-foundation', detail: specifier })
      }
      if (
        INTERNAL_DESIGN_API.test(specifier) &&
        file.path.startsWith(UI_SOURCE) &&
        !file.path.startsWith('packages/ui/src/design/') &&
        !(file.path.endsWith('.test.ts') || file.path.endsWith('.test.tsx'))
      ) {
        findings.push({ path: file.path, rule: 'nonpublic-design-import', detail: specifier })
      }
    }
    if (file.path.startsWith(UI_SOURCE) && !TEST_SOURCE.test(file.path) && !isRawControlAuthority(file.path)) {
      const ast = parseSource(file.path, file.source)
      const isCreateElement = createElementMatcher(ast)
      for (const detail of overlayViolations(file.path, file.source, ast)) findings.push({ path: file.path, rule: 'screen-owned-overlay', detail })
      const cssBindings = stylesheetBindings(file.path, file.source)
      const reportedControlOverrides = new Set()
      const visit = (node) => {
        if (ts.isCallExpression(node)) {
          const tag = node.arguments[0]
          if (isCreateElement(node.expression) && tag && ts.isStringLiteral(tag) && ['button', 'input', 'textarea', 'select'].includes(tag.text)) {
            findings.push({ path: file.path, rule: 'screen-generic-control', detail: `createElement('${tag.text}') bypasses the canonical design contract` })
          }
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(ast)
          if (['button', 'input', 'textarea', 'select'].includes(tag)) {
            findings.push({ path: file.path, rule: 'screen-generic-control', detail: `raw <${tag}> bypasses the canonical design contract` })
          }
          if (tag === 'Button') {
            const variant = jsxAttribute(node, 'variant', ast)
            const size = jsxAttribute(node, 'size', ast)
            if (size?.initializer && ts.isStringLiteral(size.initializer) && size.initializer.text.startsWith('icon') && ts.isJsxElement(node.parent)) {
              const textLabel = node.parent.children.some((child) => ts.isJsxText(child) && child.text.trim())
              if (textLabel) findings.push({ path: file.path, rule: 'text-in-icon-button', detail: 'text labels need a content-width Button size, not an icon-only square' })
            }
            if (isNullJsxAttribute(variant) || isNullJsxAttribute(size)) {
              findings.push({ path: file.path, rule: 'nullable-button-contract', detail: 'Button variants and sizes must be named canonical contracts' })
            }
          }
          if (CANONICAL_CONTROLS.has(tag) && !file.path.startsWith('packages/ui/src/design/')) {
            const className = jsxAttribute(node, 'className', ast)
            const expression = className && ts.isJsxAttribute(className) && className.initializer
              ? className.initializer.getText(ast)
              : ''
            for (const reference of expression.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)(?![\w$])/g)) {
              const cssPath = cssBindings.get(reference[1])
              const css = cssPath ? cssByPath.get(cssPath) : undefined
              const key = `${tag}:${cssPath}:${reference[2]}`
              const overrides = css ? cssClassControlOverrides(css, reference[2]) : []
              if (reportedControlOverrides.has(key) || overrides.length === 0) continue
              reportedControlOverrides.add(key)
              findings.push({ path: file.path, rule: 'canonical-control-visual-override', detail: `${tag} class ${reference[2]} redefines canonical control visuals in ${cssPath}: ${overrides.join(', ')}` })
            }
            if (className && !classNameIsStatic(className, cssBindings)) {
              findings.push({ path: file.path, rule: 'unknown-canonical-control-classname', detail: `${tag} className must be a statically understood layout-only composition` })
            }
            const visualUtilities = staticClassTokens(className, ast).filter((token) => {
              const base = utilityBase(token)
              return base.startsWith('[') || CONTROL_VISUAL_UTILITY.test(token) || !CONTROL_LAYOUT_UTILITY.test(base)
            })
            if (visualUtilities.length > 0) {
              findings.push({
                path: file.path,
                rule: 'canonical-control-visual-override',
                detail: `${tag} className redraws the canonical control with ${[...new Set(visualUtilities)].join(', ')}`,
              })
            }
          }
          const role = jsxAttribute(node, 'role', ast)
          if (role && ts.isJsxAttribute(role) && role.initializer && ts.isStringLiteral(role.initializer) && role.initializer.text === 'menu') {
            findings.push({ path: file.path, rule: 'screen-owned-menu', detail: 'raw role="menu" bypasses the canonical Menu or Popover policy' })
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
      if (/\bcreatePortal\s*\(/.test(file.source)) {
        findings.push({ path: file.path, rule: 'screen-owned-overlay', detail: 'feature-owned portal bypasses the canonical overlay policy' })
      }
    }
  }
  return findings
}

const isMain = process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const files = repositoryFiles(root)
    .filter((file) => file.startsWith('packages/ui/src/') && /\.(?:ts|tsx|css)$/.test(file))
    .map((file) => ({ path: file, source: fs.readFileSync(path.join(root, file), 'utf8') }))
  const findings = scanUiArchitecture(files)
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(`${finding.rule}: ${finding.path}: ${finding.detail}`)
    }
    process.exit(1)
  }
  console.log('UI architecture uses one public design API and the Base UI primitive boundary.')
}
