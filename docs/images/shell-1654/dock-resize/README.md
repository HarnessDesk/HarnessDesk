# Shared dock resize

Headless preview harness only: `preview.html?comparison-verdict`, `comparison-picked` frame, light and dark, 1440 by 900 viewport. The embedded room is 700px tall so the enlarged dock and the final answers can all remain visible below the current shell controls.

Both captures set the shared dock's top padding to 100px. Before uses the original content-box observer; after uses the border-box observer in source commit `9d08330a5bad29715d6c7cfc547a1a200366543a`.

- Before: the 310px dock leaves a stale 226px transcript reserve.
- After: both measure 310px; both transcripts remain at latest and their final answers stay within the viewport above the dock.
- `measurements.json` beside each pair records the reserve, dock height and scroll distances for both themes.

All four images were inspected and passed the preview text privacy audit. Identities and content come from the synthetic fixture. The matching browser regression fails in both themes without the observer fix, reporting an 84px mismatch, and passes with it.
