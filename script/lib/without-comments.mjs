/**
 * Comments, told from code by the compiler that owns the question.
 *
 * Lifted out of `check-layering.mjs` so every gate that needs it reads one
 * answer. The design audit kept a third copy — a line-at-a-time scan that
 * tracked quotes within the line, so a `//` inside a template literal that
 * spans lines was cut as though it opened a comment, and a slash-star inside
 * a string opened a block comment that ran to the next star-slash (#229).
 * Both are failures this parser cannot have, and both had been learned here
 * already (#123, #228).
 */

import ts from 'typescript'

/**
 * How the parser should read a file, from its name.
 *
 * `.ts` and `.tsx` differ, and the difference is not cosmetic: `<T>(x: T) => x`
 * is a generic arrow in one and a JSX tag in the other. A `.js`, `.mjs` or
 * `.cjs` is read as JavaScript, JSX allowed — as TypeScript, `</p> // note` was
 * a regex literal and the comment stayed (review of #228, round 1).
 *
 * `.jsx` rides the same branch rather than having one of its own. TypeScript
 * gives `ScriptKind.JS` and `ScriptKind.JSX` one language variant, so the two
 * parse identically, and the branch that named `JSX` separately was one no
 * gate could reach: `walk` below takes `/\.tsx?$/` and `check-reachable`'s
 * `filesUnder` takes `.ts`, `.tsx`, `.mjs`, `.cjs` and `.js`. Dead branches in
 * the thing that decides what a rule sees are the ones worth not keeping
 * (review of #228, round 2).
 */
const kindOf = (fileName) =>
  /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx?$/.test(fileName)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS

/**
 * Strips comments so the rule governs what users see, not what authors explain.
 *
 * TypeScript's own parser finds them, because nothing short of a parser can,
 * and three versions of this learned it one at a time. The first was a pattern
 * that opened a comment at any `/*`, so the glob in `files: ['src/api/**']` in
 * a fixture swallowed the three hundred lines after it, and everything in that
 * stretch was silently exempt from every rule in this file — including a brand
 * name in rendered text that had been sitting there unflagged. The second
 * guessed from the character before `/*` whether a comment could open there,
 * from a short list, and so kept a comment right after `)` or `;` as code
 * (#123). The third skipped quoted strings instead of guessing and lost its
 * place in the first real file it read: `Items.tsx` splits on a regex literal
 * holding three backticks, a scanner that is not a parser takes the first for
 * the start of a template string, and three of that file's doc comments came
 * out as rendered text. An apostrophe in JSX text does the same to a quote.
 * The parser tells a regex literal, JSX text and a template string apart, so
 * what is stripped here is exactly what the compiler would drop.
 *
 * A block comment keeps its line breaks, so a line number read from the result
 * is the file's own. Pass the file's name — `kindOf` above reads the extension,
 * and a file parsed as the wrong language is a file whose comments are in the
 * wrong places.
 *
 * A gate reading a real file asks for `strict`, which refuses a file the parser
 * could not read, by name, rather than strip what it guessed: a recovered
 * parse can leave a comment inside a token, where nothing here reaches it.
 */
export const withoutComments = (source, fileName = 'source.ts', { strict = false } = {}) => {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kindOf(fileName))
  const problem = strict ? file.parseDiagnostics?.[0] : undefined
  if (problem) {
    const { line } = file.getLineAndCharacterOfPosition(problem.start ?? 0)
    throw new Error(`${fileName}:${line + 1}: TypeScript could not parse this file (${ts.flattenDiagnosticMessageText(problem.messageText, ' ')}), so its comments can't be told from its code`)
  }
  const comments = new Map()
  const visit = (node) => {
    // A doc comment's own nodes sit inside the comment; the token it documents
    // reads it whole, as trivia, like any other comment.
    if (node.kind === ts.SyntaxKind.JSDoc) return
    const children = node.kind === ts.SyntaxKind.EndOfFileToken ? [] : node.getChildren(file)
    if (children.length > 0) {
      for (const child of children) visit(child)
      return
    }
    // A token. Only a token's position is where trivia starts — a list of JSX
    // children starts where its first text does — and JSX text is what the
    // reader sees, `//` and all: there is no comment in it.
    if (node.kind === ts.SyntaxKind.JsxText) return
    // The compiler splits the run before a token at its first line break: what
    // comes before the break is the previous token's trailing comment, what
    // comes after is this one's leading comment. Leading alone misses
    // `getValue()/* Codex */`, which is the whole of #123.
    const before = [
      ...(ts.getTrailingCommentRanges(source, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
    ]
    for (const range of before) comments.set(range.pos, range.end)
  }
  visit(file)
  let out = ''
  let at = 0
  for (const [pos, end] of [...comments].sort(([a], [b]) => a - b)) {
    out += source.slice(at, pos) + source.slice(pos, end).replace(/[^\n]/g, '')
    at = end
  }
  return out + source.slice(at)
}
