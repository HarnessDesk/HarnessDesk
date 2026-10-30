# Review Credential Detection Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement after the parent checkpoint. Checkboxes track the steps. The parent owns independent reviews and integration; do not dispatch subagents.

**Goal:** Refuse two narrowly defined credential forms in review and fixes text before any publication.

**Architecture:** Reuse the existing whole-file entropy predicate for individual lines and the existing field-value policy for immediately adjacent split lines. Keep the original and decoded sources and all existing detector paths; report only a line number and generic label.

**Tech Stack:** Node.js ES modules, `node:test`, pnpm.

## Global Constraints

The parent supplies `HEAVY_DRIVER` as a private environment variable pointing to the shared heavy-workflow wrapper; its machine-specific location does not belong in repository documentation.

- Approved spec: `docs/superpowers/specs/2026-10-30-review-credential-detection-design.md`. Only the two rules in it are in scope; no new short keys, inline entropy scan, multiline-block inference, homoglyph or name classifier.
- Preserve whole-body bare-file detection, same-line rules, placeholder and strong/weak key semantics. Exact 40/64 hexadecimal exemptions apply only to the new line rule.
- Synthetic generated fixtures only; do not put tested values in test names, assertion messages, or diagnostics. No real credentials or accounts. Do not post, push, merge, rebase, switch branches, touch another checkout or the owner's desk.
- After the parent explicitly continues, first run `pnpm install --frozen-lockfile` in this checkout, using the existing store. Do not install globally. Do not run tests or install before that checkpoint.
- Run every heavy build/test/native workflow through `node "$HEAVY_DRIVER" -- COMMAND ARGS` (maximum two globally); queueing is expected. Do not run full verify; parent owns it. The focused Node test below takes an explicit test file and avoids pnpm argument forwarding ambiguity.
- Native proof is not applicable to this script-only guard: exercise the real exported `postReview` entry with injected runner in both modes, and do not access a provider or launch a desk. Parent owns any later independent native proof.

## File map and interfaces

- Modify `script/check-secrets.mjs`: export the existing `isBareCredentialFile(content: string): boolean` without changing its algorithm or `offendersIn(file, content): string[]` behavior.
- Modify `script/post-review.mjs`: import that predicate; extend private `credentialLines(body)` through line and split-field helpers. `postReview(options, runner, io): Promise<number>` and all public signatures stay unchanged.
- Modify `script/post-review.test.mjs`: use existing `harness()` and `isPost()` to test refusal and successful posting without a network call.
- Modify `docs/release.md`: document the bounded checks, intentional misses, false positives, and human read.

### Task 1: Pin both rules and refusal before mutation

**Files:** `script/post-review.test.mjs`; implementation files as in file map.

**Interfaces:** Tests call existing `postReview` and inspect `harness().calls`, `harness().output()` and `harness().bodies`. No new production interface except the predicate export above.

- [ ] **Step 1: Add focused red tests.** Append the following code to the test file. It generates values at runtime and never includes a value in a test title or assertion message. The 32 distinct ASCII characters have entropy 5 bits/character; the low-entropy value has entropy 0. The hex generator has sufficient variety to exercise the exemption and whole-body rule.

```js
const generatedOpaque = (length) => Array.from({ length }, (_, i) =>
  String.fromCharCode(i % 36 < 26 ? 97 + i % 36 : 48 + i % 36 - 26)).join('')
const generatedHex = (length) => Array.from({ length }, (_, i) => '0123456789abcdef'[i % 16]).join('')

async function checkCredentialCase(body, expected, line, sensitive) {
  for (const mode of ['review', 'fixes']) {
    const h = harness()
    const options = mode === 'review'
      ? { pr: '42', round: '1', by: 'Codex', body, repo: 'owner/repo' }
      : { pr: '42', fixes: body, repo: 'owner/repo' }
    assert.equal(await postReview(options, h.runner, h.io), expected)
    assert.equal(h.calls.some(isPost), expected === 0)
    if (expected === 2) {
      assert.equal(h.calls.length, 0) // refusal precedes identity reads and mutation
      assert.match(h.output().stderr, /credential/)
      if (line != null) assert.match(h.output().stderr, new RegExp(`line ${line}\\b`))
      if (sensitive) {
        assert.equal(h.output().stderr.includes(sensitive), false)
        assert.equal(h.output().stdout.includes(sensitive), false)
      }
    }
  }
}

test('standalone generated lines respect entropy, boundaries and hashes in both paths', async () => {
  const opaque = generatedOpaque(32)
  await checkCredentialCase(`Before\n ${opaque} \nAfter`, 2, 2, opaque)
  await checkCredentialCase(`Before\n${generatedOpaque(31)}\nAfter`, 0)
  await checkCredentialCase(`Before\n${'a'.repeat(32)}\nAfter`, 0)
  const threshold = 'abcdefgh'.repeat(4) // exactly 3 bits per character
  await checkCredentialCase(`Before\n${threshold}\nAfter`, 2, 2, threshold)
  await checkCredentialCase(`Before\n${'abcdefg'.repeat(5)}\nAfter`, 0)
  await checkCredentialCase(`Before\n${opaque}!\nAfter`, 0)
  await checkCredentialCase(`Before ${opaque} after`, 0)
  for (const length of [40, 64]) {
    const hash = generatedHex(length)
    await checkCredentialCase(`Before\n${hash}\nAfter`, 0)
    await checkCredentialCase(hash, 2, 1, hash) // existing whole-body behavior
  }
  const hex = generatedHex(39)
  await checkCredentialCase(`Before\n${hex}\nAfter`, 2, 2, hex)
  const encoded = opaque.replace('a', '%61')
  await checkCredentialCase(`Before\n${encoded}\nAfter`, 2, 2, opaque)
  await checkCredentialCase(`Before\n${opaque.slice(0, 8)}\u200b${opaque.slice(8)}\nAfter`, 2, 2, opaque)
})

test('adjacent secret fields use existing value policy in both paths', async () => {
  for (const body of ['password:\nsunshine', '"password":\r\nsunshine', "'pwd'=\nsunshine", 'pass%77ord:\nsunshine', 'pass\u200bword:\nsunshine']) {
    await checkCredentialCase(body, 2, 2, 'sunshine')
  }
  await checkCredentialCase('token:\nabc123', 2, 2, 'abc123')
  await checkCredentialCase('password:\n"sunshine"', 2, 2, 'sunshine')
  for (const body of ['token:\nrefresh', 'password:\nredacted', 'password:\nabc', 'password:\n\nsunshine', 'password:\n', 'ordinary password:\nsunshine', '"password\':\nsunshine', 'pw:\nsunshine']) {
    await checkCredentialCase(body, 0)
  }
  await checkCredentialCase('The token: refresh handling remains ordinary prose.', 0)
})
```

- [ ] **Step 2: Run red test.** After the parent checkpoint and locked install, run:

```sh
node "$HEAVY_DRIVER" -- node --test script/post-review.test.mjs
```

Expected: the two new tests fail because the new forms currently post; existing tests continue to run. Do not log bodies or print generated fixture values. Node assertion output contains only expected/actual exit codes.

- [ ] **Step 3: Implement the predicates.** In `script/check-secrets.mjs`, change only `const isBareCredentialFile` to `export const isBareCredentialFile`. In `script/post-review.mjs`, import it alongside `offendersIn`. Extract the value judgment from `headerCredentialLines` into this helper and replace the body of its loop with `if (secretFieldValue(match[1], match[2])) return [...]`, retaining the existing exact label and loop:

```js
const secretFieldValue = (key, rawValue) => {
  const value = rawValue.replace(/^`+|[`.]+$/g, '')
  const strongKey = /authorization|cookie|passw(?:or)?d|pwd|secret|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|credential/i.test(key)
  const looksSecret = strongKey || /[\dA-Z]|[^a-z-]/.test(value)
  return value.length >= 4 && looksSecret && !PLACEHOLDER_VALUE.test(value)
}
```

Add the following helpers after `headerCredentialLines`. The split-line matcher uses `KEY_VALUE` on a reconstructed single line so tokenization, optional schemes and punctuation match the existing same-line policy; `lastIndex` is reset because that regular expression is global. The first regex permits only matching quotes around a complete existing field name, a separator, and horizontal whitespace. A blank next line cannot be skipped.

```js
const SPLIT_KEY = new RegExp(`^[ \\t]*(?:(${SECRET_KEY})|"(${SECRET_KEY})"|'(${SECRET_KEY})')[ \\t]*[:=][ \\t]*$`, 'i')
const splitCredentialLines = (source) => {
  const lines = source.split(/\r?\n/)
  return lines.flatMap((line, index) => {
    const key = SPLIT_KEY.exec(line)
    const next = lines[index + 1]
    if (!key || next == null || !next.trim()) return []
    KEY_VALUE.lastIndex = 0
    const match = KEY_VALUE.exec(`${key[1] ?? key[2] ?? key[3]}: ${next.trim()}`)
    return match && secretFieldValue(match[1], match[2])
      ? [`line ${index + 2}  [credential in a secret-named field]`] : []
  })
}
const standaloneCredentialLines = (source) => source.split(/\r?\n/).flatMap((line, index) => {
  const value = line.trim()
  if (/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) return []
  return isBareCredentialFile(value) ? [`line ${index + 1}  [standalone credential]`] : []
})
```

In `credentialLines`, add `splitCredentialLines(source), standaloneCredentialLines(source)` to the existing `.concat(...)` arguments. Keep `offendersIn` first, including its unmodified whole-body check, and retain `Set` deduplication. Consequently a whole-body 40/64 hex value still refuses, even though the new line helper exempts it. The guard remains before `readIdentity`, runner writes and dry-run output. Decoding instability continues to refuse before all checks.

- [ ] **Step 4: Run green and inspect.** Repeat the exact focused command from step 2; expect all tests to pass. Check that same-line tests and existing inline hash/prose cases remain green. If a test fails, diagnose without printing a tested value; do not narrow an existing rule merely to satisfy a new test.

- [ ] **Step 5: Update release guidance.** Replace the current limits paragraph in `docs/release.md` with:

```md
It is a safety net on top of a human read, not a replacement for one. It also
checks an opaque high-entropy token on a line by itself and an existing
secret-named field followed immediately by a value on the next line. Exact
40- and 64-character hexadecimal lines in longer text are exempt from the
new line check because they commonly represent hashes; secrets of those
shapes can pass it. The existing whole-body check still applies. Generated
identifiers or ordinary words after strong field names can be refused; review
and reword or use a placeholder when appropriate.

Known limits include arbitrary inline opaque tokens and multiline blocks,
lowercase prose-like values after weak keys (token, session id), values under
four characters, unrecognized abbreviated or non-English field names,
look-alike characters and bespoke encodings. Names and handles, and private
repository, host or customer names, are not machine-checked. The poster reads
the text before posting.
```

- [ ] **Step 6: Review and hand off.** Run `git diff --check` and inspect `git diff -- script/check-secrets.mjs script/post-review.mjs script/post-review.test.mjs docs/release.md`; check all newly added text and generated fixtures for privacy, no value in diagnostics, same-line compatibility, hash scope and no unrelated changes. Re-run the focused test only if changes after step 4 affect it. Report the test command and results, intentional gaps, and any unverified behavior to the parent. The parent controls commits and review checkpoints unless it directs otherwise.
