# PR 748 measured visual comparison follow-up

Source follow-up: `285e7d52` (agent header row contract and verification tooling).
The main repair remains `1b084092`.

The original build is `9f2d6dec`; the broken migration is `b8962d50`.
The repaired frames are from the rebuilt macOS arm64 package. Every frame is
1440x900 CSS pixels at 2x and comes from an isolated fake-agent desk. The
public demo persona is intentional. No user-supplied desktop frame is used.
All eight images were inspected before publication.

The Agents comparison expands the same first agent to expose its account row.
The header measured 58px originally, 36px in the broken build, and 59px with
the shared Settings row (including its 1px divider). The fix restores 12px
vertical padding around the 34px mark. Agent names remain Geist 16px/500;
their line height returns from 16px to 21px. Expanded account rows recover
their content-based height rather than the broken 28px small-button box.

The agent handoff menu measured approximately 372x443px originally and
372x432px after repair. Text stays Geist 14px/21px at 400 weight. Rows move
from 31px to 30px by using the shared 4px vertical padding instead of 5px.
The panel keeps its 10px corners, 4px padding, 1px inset hairline, and
`0 8px 28px rgba(0,0,0,0.18)` shadow. Effective content opacity was 1, then 0
in the broken migration, and is 1 again. A blank surface made the unchanged
shadow look more prominent; changing the shadow would not repair that bug.

Other measured comparisons in the PR retain their original evidence commit:
`c2006747db4a0222e9e27f72f7289b475c1d6d3e`.
Library's first row: 65.5px -> 28px -> 65.5px. Skills: 65px -> 28px -> 65px.
Both retain 14px/21px titles and 13px/18px descriptions, with 12px vertical
and 16px horizontal padding. The model-menu outer panel is approximately
254x172px originally and 254x168px repaired; its shadow is also unchanged.
Profile tiles remain 44x44px, with one selection ring instead of a duplicate
visible outer choice frame. Values are CSS pixels, not doubled PNG pixels.

Reproduce numeric/style facts with `node script/shots/shoot.mjs --measure`
and the corresponding `--scene` selections. The flag records style and geometry,
not account text. Use isolated `HD_SHOTS_HOME` / `HD_SHOTS_WORK`, and set
`HD_SHOTS_EXECUTABLE` for the package. The default native smoke now includes
Agents, Library and Skills, enforces layout assertions, and re-samples rendered
appearance before comparing the auxiliary About window after relaunch.

Verified: full `pnpm verify`, six browser integration tests, 24 native app
frames plus About, and a packaged-app check of account expansion and separate
agent detail navigation/return. These do not claim vendor authentication,
external-agent execution, or every possible data-dependent state.
