# Review credential detection design

The owner approved the two bounded checks below and chose to leave additional short key abbreviations open.

1. **Standalone opaque value in a longer review.** Apply the existing bare-file heuristic to an individual line surrounded by prose: after trimming whitespace, the whole line must be one unquoted token of at least 32 characters from `[A-Za-z0-9+/=_-]`, with Shannon entropy at least 3 bits per character. Reuse the existing helper so its threshold stays consistent. Exempt exact 40- and 64-character hexadecimal lines because standalone commit and content hashes are common review evidence. This exemption also allows secrets with those exact shapes; say so in the release guide. The existing whole-body bare-credential check remains unchanged. Do not scan tokens embedded in sentences.

2. **Key on one line, value on the next.** Recognize a line consisting only of an existing secret field name, optional matching quotes, and `:` or `=`, followed immediately by one nonempty value line. Apply the existing same-line value rules to that value: minimum four characters, existing placeholders, and the strong-versus-weak key distinction. Report the value line number and a generic credential label, never the value. Do not skip blank lines or infer a value from arbitrary multiline blocks. Evaluate original and decoded text just as the current detector does.

The tradeoff is intentional: a generated identifier on its own line can be refused, and a strong field label followed by an ordinary word can be refused. A poster can reword or use a placeholder after checking the content. Conversely, inline opaque tokens, isolated hexadecimal values matching the hash exemptions, lower-case prose-like values under weak keys, short values, and values separated by a blank line remain possible misses.

| Synthetic example | Proposed result |
|---|---|
| Prose, then a line containing a deterministically generated mixed-character 32-character fixture meeting the entropy threshold, then more prose | Refuse |
| Prose containing that same fixture inline | Allowed by the new standalone rule; existing rules still apply |
| A standalone 40-character hexadecimal commit hash | Allowed by the new standalone rule |
| `password:` followed immediately by `sunshine` on the next line | Refuse under the existing strong-key policy |
| `token:` followed immediately by `refresh` | Allow under the existing weak-key prose policy |
| `password:` followed immediately by `redacted` | Allow |
| `password:` followed by a blank line and then a value | Outside the proposed split-line rule |

**Short abbreviations:** retain the existing `pwd` support, but do not add `pw`, `pass`, or `mdp` in this change. They are ambiguous in ordinary prose and language-specific; substring matching would widen false refusals further. A future owner decision could add exact field names only, with their own strong-key classification and examples, after evaluating representative review text.

For implementation, add focused tests in `script/post-review.test.mjs` for both review and fixes paths, checking refusal before posting and no value in diagnostics. Cover threshold and character boundaries, hash exemptions, placeholders, weak-key prose, strong keys, adjacent versus blank lines, quoted keys, CRLF, and decoded or invisible-character variants. Preserve the existing prose and inline hash tests. Generate deterministic fixtures in tests rather than embedding secret-looking high-entropy literals in the proposal or documentation.

Update `docs/release.md` to describe the two narrow checks and their hash exception, and explicitly retain the deliberate gaps: arbitrary inline tokens and multiline blocks, weak-key lowercase values, values shorter than four characters, unrecognized abbreviations and non-English keys, homoglyphs and bespoke encodings, names and handles, and private repository, host, or customer names. The human read remains required.
