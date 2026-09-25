# Foundation ownership

`tokens.css` is the single editable definition of shared design decisions. It
defines raw scales, semantic roles, and component contracts in that order.
`styles/design-platform.css` supplies the inherited raw palette, while
`styles/editorial.css` and `styles/shadcn-themes.css` are complete preference
presets that override semantic aliases under existing `data-hd-*` selectors.
They are not independent component themes.

The application imports the cascade once, in `styles/app.css`: reset and raw
palette, canonical tokens, preference presets, specialized bridges, and finally
the Tailwind semantic-utility bridge. Product styles consume these values and
must not define `--hd-*` tokens.

Run `pnpm design:tokens`, `pnpm design:doc`, and
`node script/design-audit.mjs --strict` after a foundation change.
