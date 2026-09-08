# Social preview

`social-preview.png` — 1280×640, the image GitHub shows when a link to this
repository is shared. Upload it under **Settings → General → Social preview**.

It is generated, not drawn. `social-preview.src.html` is the source: a 1280×640
page that inlines the wordmark, the agent strip from `../../docs/images/agents-dark.svg`,
and a screenshot from `../../docs/images/app/` as base64, so it renders with no
network and no fonts to install. Re-render it the way the diagrams are
rendered — headless Chrome at 2× — and crop to 1280×640.

**The upload only appears once the repository is public.** GitHub hides that
section on a private repo, along with branch rulesets and private vulnerability
reporting. All three are post-flip steps.
