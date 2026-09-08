# Social preview

`social-preview.png` — 1280×640, the image GitHub shows when a link to this
repository is shared. Upload it under **Settings → General → Social preview**.

Generated, never drawn:

```bash
node script/social-preview.mjs
```

That assembles `social-preview.src.html` from the app screenshot, the wordmark
and the bare agent strip — all inlined as base64, so it renders with no network
and no font to install — then shoots it at 2× and checks the result is
2560×1280 and that the foreground still fits inside the frame.

**There is one card, and it cannot be a light/dark pair.** It becomes
`og:image`: a static URL that Slack, X, Discord, iMessage and Google fetch
server-side, once, with no viewer and no theme to ask about. The README's
`<picture>` works because a real browser evaluates the media query as it draws;
Open Graph has no such mechanism. So the card is dark, opaque, and has to hold
on a light surface as well as a dark one.

It also has to hold *small*. A link unfurl renders it around 440px wide — a
third of its own width — and everything on it is designed against that size
rather than against the full 1280. That is why the agent strip has no names
under the marks: at unfurl size they are illegible smears, and `agent-marks.mjs`
writes a bare variant for exactly this reason.

**The upload only appears once the repository is public.** GitHub hides that
section on a private repo, along with branch rulesets and private vulnerability
reporting. All three are post-flip steps.
