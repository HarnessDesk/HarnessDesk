# App frame integration visual review

Base: B7a at `07104b664` (B Tasks 1–7a). Review covers 336 opened frames: 56 destinations, each at 1440/1100/720 in light/dark. The original INT1 capture passed 112 cases; after the account repair, only its two cases/six frames were recaptured and reopened. Wall: [INT1](INT1/index.html). B7a's 240 copied PNG hashes are unchanged. Approved snapshots were never re-recorded.

## Acceptance and intended changes

Compared with B7a: **150 changed, 90 identical; 96 additional D/C frames**. The left column is compared with `../app-frame-left-column/output/frame-wall/D7labels`; menus with `../app-frame-popups/output/frame-wall/C2`. Approved drawing references are read-only under `../app-pages-framing-design-7aa8a8/output/prototype/png`. The drawing decides slots/order/placement; spec/FRAME decide numbers/names. The owner-selected group label is at the icons' x, with 16px above a following group.

At 1440/1100, ordinary changed frames contain D's one top row, page doors, flat Teams row, aligned projects/sessions, controlled Settings middle, icon-edge group labels and bottom seat. At 720 the ordinary left column folds, so those frames are identical to B7a. Settings retains its separate standing navigation at 720, explaining all six Settings changes.

**All twelve Browser changes are intended and explicitly owner-approved:**

- `conversation-browser-{1440,1100,720}-{light,dark}.png` (six frames).
- `draft-browser-{1440,1100,720}-{light,dark}.png` (six frames).

The tab-close glyph reaches its canonical trailing edge; adjacent plus/more controls follow (810 light / 804 dark changed pixels per frame). The Browser body, transcript and composer are unchanged. This repair retains the passing alignment census; no census admission, ceiling, tolerance or assertion was loosened.

Four further body comparisons contain only glyph-edge raster differences: `team-details-1100-dark.png` (4 pixels), `team-chat-holding-1440-light.png` (6), `team-chat-holding-1440-dark.png` (5), and `team-board-list-1100-dark.png` (12). Opened against B7a: no changed words, layout, control placement or geometry. These small raster differences are disclosed rather than called pixel-identical.

The six new `left-account` frames initially exposed a D/C merge defect: C's block label stacked D's rich account content. The shared Menu profile/account adapter now keeps those children in one flex line. All six recaptures were opened against D7labels: profile face/name and selected account mark/name/runtime/percentage are horizontal, trailing figures/shortcut aligned, and the plate fits at 720 in both themes. The before-repair frames remain local under `INT1-account-before`.

## What still differs from the approved drawing

These are inherited B7a/input-branch differences, not accepted as completion of the final drawing:

- Conversation/Draft retain the B7a transcript/empty-state/composer fixture composition, rather than the drawing's simple face-led transcript and compact draft controls. The inherited empty-state heading is larger than the ordinary title scale.
- The drawing's bottom status strip and final tool/Team This Team/Seats composition are not yet implemented by B Tasks 1–7a. B Tasks 8–11 in the other worktree were not touched or integrated.
- Teams, Agents and Dashboard retain pixel-identical legacy page heading/navigation and pending final page slots. Dashboard's 720 standing navigation/cramped summary remain inherited limitations.
- Settings retains its legacy heading, General fixture body and separate standing navigation at 720; final drawing composition remains subsequent work.
- Some empty Findings/Chat fixtures do not exercise the drawing's populated content; no claim is made for unshown long finding titles. Narrow reading surfaces retain their B7a outer inset where it differs from the drawing's gutter.
- Native preview content retains its own white document boundary in dark theme where inherited; ordinary app surfaces remain legible and quiet.
- The inherited right-panel drag bounds remain 280–900, while spec/FRAME say 320–640. Proven in all four input commits; no merge changed them. Default wall panels remain 400px, and the template journey explicitly requests/asserts 640px through a real pointer resize. Canonical clamp migration remains future work.

## Look checklist

Columns follow “The visual check” in the master plan:

1. Nothing broken: clipping, overlap, mid-word breaks, horizontal overflow; names/paths truncate, sentences wrap.
2. Calm top bar: 40px, title floor 180px, More at far right, one row, icon edge consistent.
3. One left edge: headings, rows and foot align, icons hang.
4. Reading measure 736px / gutter 24px; wide measure 1320px; controls word-wide.
5. Ordinary titles 14/500, groups 13/500 secondary; faint ink only for facts. FRAME's 12/500 menu group wins.
6. Rhythm: label/card 8px, sections 32px; owner-selected following left group 16px; no double spacing or card inside panel.
7. Dark legibility and quiet lines.
8. At 720, left/panel folds or floats without overflow.
9. Approved drawing slots/order/placement; spec and FRAME win numbers/names.
10. Long/CJK content holds; menus stay within 340px.

**P** = inspected pass for this rendered state (numeric contracts are separately checked); **I** = inherited limitation or pending drawing work, not a pass against the final drawing; **NA** = genuinely not exercised/applicable. No unresolved integration defect (**F**) remains. A fixture's P does not claim unshown states were exercised.

## Changed destination inventory

Each destination expands to its actual width/theme filenames in the checklist below. Counts are against B7a; “new” means no B7a counterpart.

| Destination | Changed | Identical | New | Explanation |
|---|---:|---:|---:|---|
| agents | 0 | 6 | 0 | Unchanged B7a |
| conversation | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-activity | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-browser | 6 | 0 | 0 | D left column + approved Browser tab-close edge |
| conversation-changes | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-details | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-file | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-git | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-left-open | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| conversation-plugin | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-preview | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-tasks | 4 | 2 | 0 | D left column / Settings navigation |
| conversation-terminal | 4 | 2 | 0 | D left column / Settings navigation |
| dashboard | 0 | 6 | 0 | Unchanged B7a |
| draft | 4 | 2 | 0 | D left column / Settings navigation |
| draft-browser | 6 | 0 | 0 | D left column + approved Browser tab-close edge |
| draft-details | 4 | 2 | 0 | D left column / Settings navigation |
| left-account | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-column-probe | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-inbox | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-project-menu | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-session-card | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-session-menu | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-start | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-work | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| left-work-pattern | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| plugin-unavailable | 4 | 2 | 0 | D left column / Settings navigation |
| popup-composer-add | 0 | 0 | 6 | C canonical menu/composer rows and plate |
| popup-menu-icons | 0 | 0 | 6 | C canonical menu/composer rows and plate |
| popup-menu-none | 0 | 0 | 6 | C canonical menu/composer rows and plate |
| settings | 6 | 0 | 0 | D left column / Settings navigation |
| settings-middle | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| settings-middle-empty | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| settings-middle-filtered | 0 | 0 | 6 | D left-column / controlled Settings specimen |
| team-board | 4 | 2 | 0 | D left column / Settings navigation |
| team-board-list | 4 | 2 | 0 | D left column / Settings navigation |
| team-changes | 4 | 2 | 0 | D left column / Settings navigation |
| team-chat | 4 | 2 | 0 | D left column / Settings navigation |
| team-chat-holding | 4 | 2 | 0 | D left column / Settings navigation |
| team-chat-side-by-side | 4 | 2 | 0 | D left column / Settings navigation |
| team-details | 4 | 2 | 0 | D left column / Settings navigation |
| team-findings | 4 | 2 | 0 | D left column / Settings navigation |
| team-findings-blocking | 4 | 2 | 0 | D left column / Settings navigation |
| team-findings-open | 4 | 2 | 0 | D left column / Settings navigation |
| team-overview | 4 | 2 | 0 | D left column / Settings navigation |
| team-receipt | 4 | 2 | 0 | D left column / Settings navigation |
| team-run | 4 | 2 | 0 | D left column / Settings navigation |
| team-run-details | 4 | 2 | 0 | D left column / Settings navigation |
| team-run-equivalent | 4 | 2 | 0 | D left column / Settings navigation |
| team-run-flow | 4 | 2 | 0 | D left column / Settings navigation |
| team-run-not-reached | 4 | 2 | 0 | D left column / Settings navigation |
| team-run-repeated | 4 | 2 | 0 | D left column / Settings navigation |
| team-runs | 4 | 2 | 0 | D left column / Settings navigation |
| team-runs-filtered | 4 | 2 | 0 | D left column / Settings navigation |
| teams | 0 | 6 | 0 | Unchanged B7a |
| topbar-probe | 0 | 6 | 0 | Unchanged B7a |

## Per-frame checklist and observations

### agents

[Opened six-frame sheet](INT-review-sheets/agents.png).

Pixel-identical to B7a. Inherited legacy page heading/navigation and drawing slot differences remain for subsequent framing work.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| agents-1440-light.png | P | I | P | P | I | P | P | NA | I | P |
| agents-1440-dark.png | P | I | P | P | I | P | P | NA | I | P |
| agents-1100-light.png | P | I | P | P | I | P | P | NA | I | P |
| agents-1100-dark.png | P | I | P | P | I | P | P | NA | I | P |
| agents-720-light.png | P | I | P | P | I | P | P | I | I | P |
| agents-720-dark.png | P | I | P | P | I | P | P | I | I | P |

### conversation

[Opened six-frame sheet](INT-review-sheets/conversation.png).

D supplies the single top row, page doors, icon-edge group labels, aligned sessions and bottom seat. Main transcript and composer match B7a. The approved drawing has later status/tool composition that remains outside B Tasks 1–7a.

D supplies the single top row, page doors, icon-edge group labels, aligned sessions and bottom seat. Main transcript and composer match B7a. The approved drawing has later status/tool composition that remains outside B Tasks 1–7a. Narrow work surface preserves B7a outer reading inset; drawing gutter/fold differences are inherited.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-720-light.png | P | P | P | I | P | P | P | P | I | P |
| conversation-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### conversation-activity

[Opened six-frame sheet](INT-review-sheets/conversation-activity.png).

Events and Trajectory use the same tool gutter; controls and timing segments stay inside the panel. Trajectory prose excerpts end in ellipses, inherited from B7a (items 1 and 10), so full sentence handling is not approved here. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Events and Trajectory use the same tool gutter; controls and timing segments stay inside the panel. Trajectory prose excerpts end in ellipses, inherited from B7a (items 1 and 10), so full sentence handling is not approved here. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-activity-1440-light.png | I | P | P | P | P | P | P | NA | I | I |
| conversation-activity-1440-dark.png | I | P | P | P | P | P | P | NA | I | I |
| conversation-activity-1100-light.png | I | P | P | P | P | P | P | NA | I | I |
| conversation-activity-1100-dark.png | I | P | P | P | P | P | P | NA | I | I |
| conversation-activity-720-light.png | I | P | P | P | P | P | P | P | I | I |
| conversation-activity-720-dark.png | I | P | P | P | P | P | P | P | I | I |

### conversation-browser

[Opened six-frame sheet](INT-review-sheets/conversation-browser.png).

Native tab controls, URL row, empty state and footer remain readable. Only the tab close edge and following plus/more controls changed from B7a; the real edge placement is coherent. URL placeholder is clipped inside its input at panel width, inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. B7a non-left pixel difference: 810, limited to the tab strip.

Native tab controls, URL row, empty state and footer remain readable. Only the tab close edge and following plus/more controls changed from B7a; the real edge placement is coherent. URL placeholder is clipped inside its input at panel width, inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. B7a non-left pixel difference: 804, limited to the tab strip.

Native tab controls, URL row, empty state and footer remain readable. Only the tab close edge and following plus/more controls changed from B7a; the real edge placement is coherent. URL placeholder is clipped inside its input at panel width, inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. B7a non-left pixel difference: 810, limited to the tab strip.

Native tab controls, URL row, empty state and footer remain readable. Only the tab close edge and following plus/more controls changed from B7a; the real edge placement is coherent. URL placeholder is clipped inside its input at panel width, inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. B7a non-left pixel difference: 804, limited to the tab strip.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-browser-1440-light.png | P | P | P | P | P | P | P | NA | I | I |
| conversation-browser-1440-dark.png | P | P | P | P | P | P | P | NA | I | I |
| conversation-browser-1100-light.png | P | P | P | P | P | P | P | NA | I | I |
| conversation-browser-1100-dark.png | P | P | P | P | P | P | P | NA | I | I |
| conversation-browser-720-light.png | P | P | P | P | P | P | P | P | I | I |
| conversation-browser-720-dark.png | P | P | P | P | P | P | P | P | I | I |

### conversation-changes

[Opened six-frame sheet](INT-review-sheets/conversation-changes.png).

Filter, Staged switch, Working tree count, empty state and footer retain clear spacing. Filter expands at 720 without overflow. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Filter, Staged switch, Working tree count, empty state and footer retain clear spacing. Filter expands at 720 without overflow. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-changes-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-changes-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-changes-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-changes-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-changes-720-light.png | P | P | P | P | P | P | P | P | I | NA |
| conversation-changes-720-dark.png | P | P | P | P | P | P | P | P | I | NA |

### conversation-details

[Opened six-frame sheet](INT-review-sheets/conversation-details.png).

Conversation facts wrap the held-permission sentence and truncate the folder path. Seat-record facts use a leading gutter different from their section heading, inherited (item 3). The footer remains at the lower panel edge. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Conversation facts wrap the held-permission sentence and truncate the folder path. Seat-record facts use a leading gutter different from their section heading, inherited (item 3). The footer remains at the lower panel edge. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-details-1440-light.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-details-1440-dark.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-details-1100-light.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-details-1100-dark.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-details-720-light.png | P | P | I | P | P | P | P | P | I | P |
| conversation-details-720-dark.png | P | P | I | P | P | P | P | P | I | P |

### conversation-file

[Opened six-frame sheet](INT-review-sheets/conversation-file.png).

README title, Path facts and Edit control retain the tool gutter. The native code editor has its own line-number/text geometry; its three lines remain readable. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

README title, Path facts and Edit control retain the tool gutter. The native code editor has its own line-number/text geometry; its three lines remain readable. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-file-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-file-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-file-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-file-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-file-720-light.png | P | P | P | P | P | P | P | P | I | NA |
| conversation-file-720-dark.png | P | P | P | P | P | P | P | P | I | NA |

### conversation-git

[Opened six-frame sheet](INT-review-sheets/conversation-git.png).

Repository caption and Folder facts hold. Actions wrap in the narrow panel; at 720 labels and ref column appear with no overflow. Commit subjects truncate as entry titles rather than forcing horizontal expansion. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Repository caption and Folder facts hold. Actions wrap in the narrow panel; at 720 labels and ref column appear with no overflow. Commit subjects truncate as entry titles rather than forcing horizontal expansion. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-git-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-git-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-git-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-git-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-git-720-light.png | P | P | P | P | P | P | P | P | I | P |
| conversation-git-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### conversation-left-open

[Opened six-frame sheet](INT-review-sheets/conversation-left-open.png).

D row anatomy and quiet project headings survive on the B7a conversation shell. At 720 the 240px column floats above a dimmed transcript; rows and the footer remain contained. Reference: ../app-frame-left-column/output/frame-wall/D7labels/conversation-left-open-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

D row anatomy and quiet project headings survive on the B7a conversation shell. At 720 the 240px column floats above a dimmed transcript; rows and the footer remain contained. Reference: ../app-frame-left-column/output/frame-wall/D7labels/conversation-left-open-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-left-open-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| conversation-left-open-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| conversation-left-open-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| conversation-left-open-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| conversation-left-open-720-light.png | P | P | P | I | P | P | P | P | I | P |
| conversation-left-open-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### conversation-plugin

[Opened six-frame sheet](INT-review-sheets/conversation-plugin.png).

Recorded work fixture uses the retained Details-style facts and seat record. Group headings and seat-record facts use visibly different leading gutters, inherited (item 3). CJK recorded-work text remains contained. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Recorded work fixture uses the retained Details-style facts and seat record. Group headings and seat-record facts use visibly different leading gutters, inherited (item 3). CJK recorded-work text remains contained. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-plugin-1440-light.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-plugin-1440-dark.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-plugin-1100-light.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-plugin-1100-dark.png | P | P | I | P | P | P | P | NA | I | P |
| conversation-plugin-720-light.png | P | P | I | P | P | P | P | P | I | P |
| conversation-plugin-720-dark.png | P | P | I | P | P | P | P | P | I | P |

### conversation-preview

[Opened six-frame sheet](INT-review-sheets/conversation-preview.png).

Path and Reload/Source controls hold. The rendered document wraps the CJK line and paragraph. Its independent white document background and large document heading remain in dark mode, inherited from B7a (item 7); this review does not approve document theming. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Path and Reload/Source controls hold. The rendered document wraps the CJK line and paragraph. Its independent white document background and large document heading remain in dark mode, inherited from B7a (item 7); this review does not approve document theming. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-preview-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-preview-1440-dark.png | P | P | P | P | P | P | I | NA | I | P |
| conversation-preview-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-preview-1100-dark.png | P | P | P | P | P | P | I | NA | I | P |
| conversation-preview-720-light.png | P | P | P | P | P | P | P | P | I | P |
| conversation-preview-720-dark.png | P | P | P | P | P | P | I | P | I | P |

### conversation-tasks

[Opened six-frame sheet](INT-review-sheets/conversation-tasks.png).

The empty Background tasks state stays centred and readable. The panel fills the 720 frame while the left column and transcript fold away. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

The empty Background tasks state stays centred and readable. The panel fills the 720 frame while the left column and transcript fold away. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-tasks-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-tasks-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-tasks-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-tasks-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-tasks-720-light.png | P | P | P | P | P | P | P | P | I | NA |
| conversation-tasks-720-dark.png | P | P | P | P | P | P | P | P | I | NA |

### conversation-terminal

[Opened six-frame sheet](INT-review-sheets/conversation-terminal.png).

Terminal sits below the conversation. Command, results and prompt remain legible in both themes; composer remains above it. Transcript starts partially scrolled at the upper boundary, as in B7a, not a new clipping defect. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Terminal sits below the conversation. Command, results and prompt remain legible in both themes; composer remains above it. Transcript starts partially scrolled at the upper boundary, as in B7a, not a new clipping defect. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| conversation-terminal-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-terminal-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-terminal-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-terminal-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| conversation-terminal-720-light.png | P | P | P | P | P | P | P | P | I | NA |
| conversation-terminal-720-dark.png | P | P | P | P | P | P | P | P | I | NA |

### dashboard

[Opened six-frame sheet](INT-review-sheets/dashboard.png).

Pixel-identical to B7a. Inherited legacy page heading/navigation and drawing slot differences remain. At 720 the standing navigation and cramped summary remain inherited limitations.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| dashboard-1440-light.png | P | I | P | P | I | P | P | NA | I | P |
| dashboard-1440-dark.png | P | I | P | P | I | P | P | NA | I | P |
| dashboard-1100-light.png | P | I | P | P | I | P | P | NA | I | P |
| dashboard-1100-dark.png | P | I | P | P | I | P | P | NA | I | P |
| dashboard-720-light.png | I | I | P | P | I | I | P | I | I | P |
| dashboard-720-dark.png | I | I | P | P | I | I | P | I | I | P |

### draft

[Opened six-frame sheet](INT-review-sheets/draft.png).

D supplies the left column; B7a empty-state heading, composer and disabled controls remain. Drawing content and later status/tool composition differ; the inherited empty-state heading is larger than the ordinary title scale.

D supplies the left column; B7a empty-state heading, composer and disabled controls remain. Drawing content and later status/tool composition differ; the inherited empty-state heading is larger than the ordinary title scale. Narrow work surface preserves B7a outer reading inset; drawing gutter/fold differences are inherited.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| draft-1440-light.png | P | P | P | P | I | P | P | NA | I | P |
| draft-1440-dark.png | P | P | P | P | I | P | P | NA | I | P |
| draft-1100-light.png | P | P | P | P | I | P | P | NA | I | P |
| draft-1100-dark.png | P | P | P | P | I | P | P | NA | I | P |
| draft-720-light.png | P | P | P | I | I | P | P | P | I | P |
| draft-720-dark.png | P | P | P | I | I | P | P | P | I | P |

### draft-browser

[Opened six-frame sheet](INT-review-sheets/draft-browser.png).

Draft empty-state and composer retain their wide/middle arrangement; the Browser panel floats over them at 720. Tab close edge adjustment matches conversation-browser. URL placeholder truncation is inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. B7a non-left pixel difference: 810, limited to the tab strip.

Draft empty-state and composer retain their wide/middle arrangement; the Browser panel floats over them at 720. Tab close edge adjustment matches conversation-browser. URL placeholder truncation is inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. B7a non-left pixel difference: 804, limited to the tab strip.

Draft empty-state and composer retain their wide/middle arrangement; the Browser panel floats over them at 720. Tab close edge adjustment matches conversation-browser. URL placeholder truncation is inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. B7a non-left pixel difference: 810, limited to the tab strip.

Draft empty-state and composer retain their wide/middle arrangement; the Browser panel floats over them at 720. Tab close edge adjustment matches conversation-browser. URL placeholder truncation is inherited (item 10). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. B7a non-left pixel difference: 804, limited to the tab strip.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| draft-browser-1440-light.png | P | P | P | P | I | P | P | NA | I | I |
| draft-browser-1440-dark.png | P | P | P | P | I | P | P | NA | I | I |
| draft-browser-1100-light.png | P | P | P | P | I | P | P | NA | I | I |
| draft-browser-1100-dark.png | P | P | P | P | I | P | P | NA | I | I |
| draft-browser-720-light.png | P | P | P | P | P | P | P | P | I | I |
| draft-browser-720-dark.png | P | P | P | P | P | P | P | P | I | I |

### draft-details

[Opened six-frame sheet](INT-review-sheets/draft-details.png).

Starts in facts remain readable. At wide/middle sizes the retained large empty-state heading and full composer options differ from the approved drawing, inherited (items 5 and 9). At 720 only the details outlet is visible. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Starts in facts remain readable. At wide/middle sizes the retained large empty-state heading and full composer options differ from the approved drawing, inherited (items 5 and 9). At 720 only the details outlet is visible. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| draft-details-1440-light.png | P | P | P | P | I | P | P | NA | I | P |
| draft-details-1440-dark.png | P | P | P | P | I | P | P | NA | I | P |
| draft-details-1100-light.png | P | P | P | P | I | P | P | NA | I | P |
| draft-details-1100-dark.png | P | P | P | P | I | P | P | NA | I | P |
| draft-details-720-light.png | P | P | P | P | P | P | P | P | I | NA |
| draft-details-720-dark.png | P | P | P | P | P | P | P | P | I | NA |

### left-account

[Opened six-frame sheet](INT-review-sheets/left-account.png).

Repaired account menu: profile face/name and selected account mark/name/runtime are horizontal again, and the percentage remains in its trailing slot. The profile and account rows recover D7labels anatomy without unearned stacking; all labels, shortcut and usage facts are readable and contained in both themes and at 720. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-account-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Repaired account menu: profile face/name and selected account mark/name/runtime are horizontal again, and the percentage remains in its trailing slot. The profile and account rows recover D7labels anatomy without unearned stacking; all labels, shortcut and usage facts are readable and contained in both themes and at 720. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-account-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-account-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-account-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-account-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-account-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-account-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-account-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-column-probe

[Opened six-frame sheet](INT-review-sheets/left-column-probe.png).

Long project/session names ellipsize, count stays in the trailing slot, unavailable row remains quieter, and the seat stays at the bottom. Projects starts at the ordinary icon edge, per the owner choice. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-column-probe-{1440,1100,720}-{light,dark}.png. NA2/NA4/NA8/NA9: isolated control specimen has no app top bar, reading-page main area, shell fold or corresponding approved full-page drawing.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-column-probe-1440-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-column-probe-1440-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-column-probe-1100-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-column-probe-1100-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-column-probe-720-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-column-probe-720-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |

### left-inbox

[Opened six-frame sheet](INT-review-sheets/left-inbox.png).

Inbox title, empty-state icon and complete two-line explanation fit the plate. Light shadow and dark hairline separate the plate from the transcript; the 720 plate stays within the viewport. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-inbox-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Inbox title, empty-state icon and complete two-line explanation fit the plate. Light shadow and dark hairline separate the plate from the transcript; the 720 plate stays within the viewport. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-inbox-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-inbox-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-inbox-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-inbox-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-inbox-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-inbox-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-inbox-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-project-menu

[Opened six-frame sheet](INT-review-sheets/left-project-menu.png).

Every project action, variable path line and destructive label is contained. Icon and label columns align, the first keyboard-focused row has a visible ring, and the 720 menu remains wholly on screen. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-project-menu-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Every project action, variable path line and destructive label is contained. Icon and label columns align, the first keyboard-focused row has a visible ring, and the 720 menu remains wholly on screen. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-project-menu-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-project-menu-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-project-menu-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-project-menu-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-project-menu-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-project-menu-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-project-menu-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-session-card

[Opened six-frame sheet](INT-review-sheets/left-session-card.png).

Name and account line, Context meter and reading, folder path and Open/Rename actions remain in distinct sections. Both themes have quiet separators and readable contrast; the 720 card remains within the viewport. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-session-card-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Name and account line, Context meter and reading, folder path and Open/Rename actions remain in distinct sections. Both themes have quiet separators and readable contrast; the 720 card remains within the viewport. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-session-card-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-session-card-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-session-card-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-session-card-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-session-card-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-session-card-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-session-card-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-session-menu

[Opened six-frame sheet](INT-review-sheets/left-session-menu.png).

Rename, Unpin, Open on the right, Branch, Copy, Archive and removal actions fit the canonical iconless menu. The shortcut stays trailing; the first keyboard-focused row has a visible ring. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-session-menu-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Rename, Unpin, Open on the right, Branch, Copy, Archive and removal actions fit the canonical iconless menu. The shortcut stays trailing; the first keyboard-focused row has a visible ring. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-session-menu-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-session-menu-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-session-menu-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-session-menu-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-session-menu-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-session-menu-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-session-menu-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-start

[Opened six-frame sheet](INT-review-sheets/left-start.png).

Three labels, both shortcut trails and the disabled worktree explanation fit. C uses valid iconless menu anatomy here; unlike D7labels, leading action icons are absent. The disabled sentence remains complete. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-start-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Three labels, both shortcut trails and the disabled worktree explanation fit. C uses valid iconless menu anatomy here; unlike D7labels, leading action icons are absent. The disabled sentence remains complete. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-start-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-start-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-start-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-start-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-start-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-start-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-start-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-work

[Opened six-frame sheet](INT-review-sheets/left-work.png).

Pinned and project groups retain distinct following gaps, fixed trailing facts and the Other projects disclosure. The approval content remains in a centred reading column; the narrow floating column and backdrop do not displace its contents. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-work-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Pinned and project groups retain distinct following gaps, fixed trailing facts and the Other projects disclosure. The approval content remains in a centred reading column; the narrow floating column and backdrop do not displace its contents. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-work-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-work-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| left-work-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-work-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| left-work-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| left-work-720-light.png | P | P | P | I | P | P | P | P | I | P |
| left-work-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### left-work-pattern

[Opened six-frame sheet](INT-review-sheets/left-work-pattern.png).

Isolated work pattern retains the Projects controls, folder heading, inline rename input and fully wrapped empty-state sentence. The same composition is in D7labels; this is a component specimen, not a reading page or a shell fold demonstration. Reference: ../app-frame-left-column/output/frame-wall/D7labels/left-work-pattern-{1440,1100,720}-{light,dark}.png. NA2/NA4/NA8/NA9: isolated control specimen has no app top bar, reading-page main area, shell fold or corresponding approved full-page drawing.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| left-work-pattern-1440-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-work-pattern-1440-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-work-pattern-1100-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-work-pattern-1100-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-work-pattern-720-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| left-work-pattern-720-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |

### plugin-unavailable

[Opened six-frame sheet](INT-review-sheets/plugin-unavailable.png).

The unavailable plugin contributes no panel; the conversation returns to its centred reading width. Transcript, notice and composer stay legible at 720. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

The unavailable plugin contributes no panel; the conversation returns to its centred reading width. Transcript, notice and composer stay legible at 720. Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| plugin-unavailable-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| plugin-unavailable-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| plugin-unavailable-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| plugin-unavailable-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| plugin-unavailable-720-light.png | P | P | P | P | P | P | P | P | I | P |
| plugin-unavailable-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### popup-composer-add

[Opened six-frame sheet](INT-review-sheets/popup-composer-add.png).

Attach images refusal remains complete; Add a file and Slash commands preserve their shortcut trails; Change project folder stays on one line. The plate opens above the composer and fits all three widths. Reference: ../app-frame-popups/output/frame-wall/C2/popup-composer-add-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

Attach images refusal remains complete; Add a file and Slash commands preserve their shortcut trails; Change project folder stays on one line. The plate opens above the composer and fits all three widths. Reference: ../app-frame-popups/output/frame-wall/C2/popup-composer-add-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| popup-composer-add-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| popup-composer-add-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| popup-composer-add-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| popup-composer-add-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| popup-composer-add-720-light.png | P | P | P | I | P | P | P | P | I | P |
| popup-composer-add-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### popup-menu-icons

[Opened six-frame sheet](INT-review-sheets/popup-menu-icons.png).

C2 icon-mode anatomy is intact: all four action icons hang before one label edge; path and earned consequence hints remain complete; group/footer text follows the same label edge. Plate remains contained at 720. Reference: ../app-frame-popups/output/frame-wall/C2/popup-menu-icons-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

C2 icon-mode anatomy is intact: all four action icons hang before one label edge; path and earned consequence hints remain complete; group/footer text follows the same label edge. Plate remains contained at 720. Reference: ../app-frame-popups/output/frame-wall/C2/popup-menu-icons-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| popup-menu-icons-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-icons-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-icons-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-icons-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-icons-720-light.png | P | P | P | I | P | P | P | P | I | P |
| popup-menu-icons-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### popup-menu-none

[Opened six-frame sheet](INT-review-sheets/popup-menu-none.png).

C2 iconless mode removes the entire icon gutter while preserving group, label, hint and footer alignment. The path and consequence sentence remain whole. Plate remains contained at 720. Reference: ../app-frame-popups/output/frame-wall/C2/popup-menu-none-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png.

C2 iconless mode removes the entire icon gutter while preserving group, label, hint and footer alignment. The path and consequence sentence remain whole. Plate remains contained at 720. Reference: ../app-frame-popups/output/frame-wall/C2/popup-menu-none-{1440,1100,720}-{light,dark}.png. I9: shell/main inherits B7a before B8–11; approved prototype has the persistent status strip and final panel/tool composition, which are not present here. Conversation shell reference: output/frame-wall/B7a/conversation-{1440,1100,720}-{light,dark}.png; approved drawing: ../app-pages-framing-design-7aa8a8/output/prototype/png/conv-{1440-light,1440-dark,720-light}.png. I4: underlying transcript/room retains B7a 32px minimum inner inset rather than the drawing's 24px minimum; inherited page geometry is pending B8–11, not caused by D/C.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| popup-menu-none-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-none-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-none-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-none-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| popup-menu-none-720-light.png | P | P | P | I | P | P | P | P | I | P |
| popup-menu-none-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### settings

[Opened six-frame sheet](INT-review-sheets/settings.png).

D supplies controlled Settings navigation, icon-edge group labels and 16px following-group gaps. General content remains B7a. Separate Settings navigation stays standing at 720; legacy heading and final drawing composition remain inherited.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| settings-1440-light.png | P | I | P | P | I | P | P | NA | I | P |
| settings-1440-dark.png | P | I | P | P | I | P | P | NA | I | P |
| settings-1100-light.png | P | I | P | P | I | P | P | NA | I | P |
| settings-1100-dark.png | P | I | P | P | I | P | P | NA | I | P |
| settings-720-light.png | P | I | P | P | I | P | P | I | I | P |
| settings-720-dark.png | P | I | P | P | I | P | P | I | I | P |

### settings-middle

[Opened six-frame sheet](INT-review-sheets/settings-middle.png).

Back, Search and all four Settings groups retain their D7labels order and row anatomy. Selected General has a quiet rounded fill and runtime count remains trailing. This is the isolated navigation specimen; it does not render the Settings main page. Reference: ../app-frame-left-column/output/frame-wall/D7labels/settings-middle-{1440,1100,720}-{light,dark}.png. NA2/NA4/NA8/NA9: isolated control specimen has no app top bar, reading-page main area, shell fold or corresponding approved full-page drawing.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| settings-middle-1440-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-1440-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-1100-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-1100-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-720-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-720-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |

### settings-middle-empty

[Opened six-frame sheet](INT-review-sheets/settings-middle-empty.png).

The deliberately long query truncates within the search input while the no-match sentence arrives whole and wraps beneath it. No stranded headings or result rows remain. Reference: ../app-frame-left-column/output/frame-wall/D7labels/settings-middle-empty-{1440,1100,720}-{light,dark}.png. NA2/NA4/NA8/NA9: isolated control specimen has no app top bar, reading-page main area, shell fold or corresponding approved full-page drawing.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| settings-middle-empty-1440-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-empty-1440-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-empty-1100-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-empty-1100-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-empty-720-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-empty-720-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |

### settings-middle-filtered

[Opened six-frame sheet](INT-review-sheets/settings-middle-filtered.png).

The mute query leaves exactly General/Notifications, with no unrelated group residue. Search focus ring is legible in both themes; the result row keeps its normal icon and label edge. Reference: ../app-frame-left-column/output/frame-wall/D7labels/settings-middle-filtered-{1440,1100,720}-{light,dark}.png. NA2/NA4/NA8/NA9: isolated control specimen has no app top bar, reading-page main area, shell fold or corresponding approved full-page drawing.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| settings-middle-filtered-1440-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-filtered-1440-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-filtered-1100-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-filtered-1100-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-filtered-720-light.png | P | NA | P | NA | P | P | P | NA | NA | P |
| settings-middle-filtered-720-dark.png | P | NA | P | NA | P | P | P | NA | NA | P |

### team-board

[Opened six-frame sheet](INT-review-sheets/team-board.png).

D supplies the left column. B7a summary, dense Board gutter, wide columns and narrow folded layout remain. Drawing status/tool composition remains pending; canvas geometry is not a reading-width page.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-board-1440-light.png | P | P | P | NA | P | P | P | NA | I | P |
| team-board-1440-dark.png | P | P | P | NA | P | P | P | NA | I | P |
| team-board-1100-light.png | P | P | P | NA | P | P | P | NA | I | P |
| team-board-1100-dark.png | P | P | P | NA | P | P | P | NA | I | P |
| team-board-720-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-board-720-dark.png | P | P | P | NA | P | P | P | P | I | P |

### team-board-list

[Opened six-frame sheet](INT-review-sheets/team-board-list.png).

Work summary, filter input/tabs, table and footer remain aligned; assignee names truncate with ellipses. At 720 the view menu moves to its own row and the table stays within its gutters. Five body crops equal B7a; 1100 dark differs by 12 glyph-edge pixels at x265–467, y129–131 in the filter labels, without text/geometry changes in opened originals. This glyph-edge raster difference is disclosed; no changed words or geometry were found. The approved drawing is Board canvas rather than this List view; final status strip/tools remain inherited B work. Reviewed via INT-review-sheets/team-board-list.png; B7a/team-board-list-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-board-list-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-board-list-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-board-list-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-board-list-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-board-list-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-board-list-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-changes

[Opened six-frame sheet](INT-review-sheets/team-changes.png).

Changes remains the flat Branch/From/To facts and diff in the right tool. At 720 the floating tool covers main; there is no duplicate tool bar. The long agent file path wraps across lines at 1100. Main/tool pixels equal B7a in all six frames. Overview body still uses the inherited Run card; final body composition and status strip remain pending B/E work. Reviewed via INT-review-sheets/team-changes.png; B7a/team-changes-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-changes-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-changes-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-changes-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-changes-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-changes-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-changes-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-chat

[Opened six-frame sheet](INT-review-sheets/team-chat.png).

D supplies the left column. B7a empty Chat, waiting notice and Team composer remain. Drawing populated content and later status/tool composition differ.

D supplies the left column. B7a empty Chat, waiting notice and Team composer remain. Drawing populated content and later status/tool composition differ. Narrow work surface preserves B7a outer reading inset; drawing gutter/fold differences are inherited.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-chat-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| team-chat-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| team-chat-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| team-chat-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| team-chat-720-light.png | P | P | P | I | P | P | P | P | I | P |
| team-chat-720-dark.png | P | P | P | I | P | P | P | P | I | P |

### team-chat-holding

[Opened six-frame sheet](INT-review-sheets/team-chat-holding.png).

Holding badge, board-only explanation and two activity readings remain above the shared composer. Explanation wraps at 720 and send control stays inside the composer. Body is exactly B7a at 1100/720. At 1440 there are 6 light / 5 dark changed pixels only at tab glyph edges x779–837, y11–12; opened before/after originals show identical text/placement. These glyph-edge raster differences are disclosed; no changed words or geometry were found. Status strip/tool inventory remain inherited B work. Reviewed via INT-review-sheets/team-chat-holding.png; B7a/team-chat-holding-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-chat-holding-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-chat-holding-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-chat-holding-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-chat-holding-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-chat-holding-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-chat-holding-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-chat-side-by-side

[Opened six-frame sheet](INT-review-sheets/team-chat-side-by-side.png).

Wide frames retain two tiles and the shared composer; 720 folds to member tabs and one visible conversation with its own composer. The edited file name wraps in its card without widening the tile. All six body crops equal B7a. Approved Chat drawing is the Thread layout, so side-by-side is compared for shell slots rather than identical content; status strip and final tool reduction remain inherited B work. Reviewed via INT-review-sheets/team-chat-side-by-side.png; B7a/team-chat-side-by-side-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-chat-side-by-side-1440-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-chat-side-by-side-1440-dark.png | P | P | P | NA | P | P | P | P | I | P |
| team-chat-side-by-side-1100-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-chat-side-by-side-1100-dark.png | P | P | P | NA | P | P | P | P | I | P |
| team-chat-side-by-side-720-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-chat-side-by-side-720-dark.png | P | P | P | NA | P | P | P | P | I | P |

### team-details

[Opened six-frame sheet](INT-review-sheets/team-details.png).

Long edited path wraps across multiple lines in the agent row, without widening the main body. Run facts remain legible; 720 shows only the Run details outlet. The retained Overview is a run summary plus Agents, whereas the drawing shows This Team and Seats (item 9). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. Every non-left pixel matches the same B7a capture (720: whole frame).

Long edited path wraps across multiple lines in the agent row, without widening the main body. Run facts remain legible; 720 shows only the Run details outlet. The retained Overview is a run summary plus Agents, whereas the drawing shows This Team and Seats (item 9). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. The standing left column matches the supplied D7labels structure, with long destination names ellipsized. B7a non-left difference is 4 pixels within a 2x3 top-bar filter-glyph bounding box; no observable layout/content change.

Long edited path wraps across multiple lines in the agent row, without widening the main body. Run facts remain legible; 720 shows only the Run details outlet. The retained Overview is a run summary plus Agents, whereas the drawing shows This Team and Seats (item 9). Item 9 is inherited B7a: retained body/composer/footer composition differs from the supplied drawing; later B/E work is not claimed. Item 8 is only evaluated in the native 720 capture. Closed menus do not prove the 340px menu maximum. Every non-left pixel matches the same B7a capture (720: whole frame).

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-details-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| team-details-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| team-details-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| team-details-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| team-details-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-details-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-findings

[Opened six-frame sheet](INT-review-sheets/team-findings.png).

D supplies the left column. B7a summary/filter and empty findings remain. Drawing populated findings and later status/tool composition differ; this empty fixture cannot prove long finding titles.

D supplies the left column. B7a summary/filter and empty findings remain. Drawing populated findings and later status/tool composition differ; this empty fixture cannot prove long finding titles. Narrow work surface preserves B7a outer reading inset; drawing gutter/fold differences are inherited.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-findings-1440-light.png | P | P | P | P | P | P | P | NA | I | I |
| team-findings-1440-dark.png | P | P | P | P | P | P | P | NA | I | I |
| team-findings-1100-light.png | P | P | P | P | P | P | P | NA | I | I |
| team-findings-1100-dark.png | P | P | P | P | P | P | P | NA | I | I |
| team-findings-720-light.png | P | P | P | I | P | P | P | P | I | I |
| team-findings-720-dark.png | P | P | P | I | P | P | P | P | I | I |

### team-findings-blocking

[Opened six-frame sheet](INT-review-sheets/team-findings-blocking.png).

Blocking-filtered frame also contains zero findings and the empty-state reading column; its summary and provenance are intact at all widths/themes. All six body crops equal B7a. It does not exercise blocking row content or long finding names: items 9/10 are I for inherited empty fixture/prototype coverage, with status strip/tools pending B work. Reviewed via INT-review-sheets/team-findings-blocking.png; B7a/team-findings-blocking-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-findings-blocking-1440-light.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-blocking-1440-dark.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-blocking-1100-light.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-blocking-1100-dark.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-blocking-720-light.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-blocking-720-dark.png | P | P | P | P | P | P | P | P | I | I |

### team-findings-open

[Opened six-frame sheet](INT-review-sheets/team-findings-open.png).

Open/Blocking/All summary is zero, local-only provenance appears, then No findings recorded. The active filter is indicated on the top-bar View icon. At 720 the same reading column stays inside margins. All six body crops equal B7a. This inherited empty fixture cannot demonstrate the approved populated Findings rows or long titles; items 9/10 are I, pending fixture/body work, not a claim that populated content was reviewed. Reviewed via INT-review-sheets/team-findings-open.png; B7a/team-findings-open-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-findings-open-1440-light.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-open-1440-dark.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-open-1100-light.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-open-1100-dark.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-open-720-light.png | P | P | P | P | P | P | P | P | I | I |
| team-findings-open-720-dark.png | P | P | P | P | P | P | P | P | I | I |

### team-overview

[Opened six-frame sheet](INT-review-sheets/team-overview.png).

D supplies the left column. B7a Run summary and wide Agents table/narrow rows remain. The drawing has later status/tool composition; no new main-body change.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-overview-1440-light.png | P | P | P | P | P | P | P | NA | I | P |
| team-overview-1440-dark.png | P | P | P | P | P | P | P | NA | I | P |
| team-overview-1100-light.png | P | P | P | P | P | P | P | NA | I | P |
| team-overview-1100-dark.png | P | P | P | P | P | P | P | NA | I | P |
| team-overview-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-overview-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-receipt

[Opened six-frame sheet](INT-review-sheets/team-receipt.png).

What finished, Work, Answers, Record and Cost appear in that order; recorded cost and sources remain visible at 720. Sentences wrap without widened rows. Body pixels equal B7a in all six frames. The reading column is left anchored rather than centered in the available main area at wide widths, and the retained Cost tabs/record blocks are legacy composition; items 4/6/9 are inherited B7a/E work, not integration repairs. Reviewed via INT-review-sheets/team-receipt.png; B7a/team-receipt-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-receipt-1440-light.png | P | P | P | I | P | I | P | P | I | P |
| team-receipt-1440-dark.png | P | P | P | I | P | I | P | P | I | P |
| team-receipt-1100-light.png | P | P | P | I | P | I | P | P | I | P |
| team-receipt-1100-dark.png | P | P | P | I | P | I | P | P | I | P |
| team-receipt-720-light.png | P | P | P | I | P | I | P | P | I | P |
| team-receipt-720-dark.png | P | P | P | I | P | I | P | P | I | P |

### team-run

[Opened six-frame sheet](INT-review-sheets/team-run.png).

Start, Taken and the two reviewer cards remain legible, including Card unavailable. 720 retains both reviewer columns without horizontal overflow. All six body crops equal B7a. The approved Run drawing uses grouped role rows and a status strip; this inherited timeline still has per-round/card rendering. Final Run body/strip/tool composition remains B8–11 work. Reviewed via INT-review-sheets/team-run.png; B7a/team-run-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-run-1440-light.png | P | P | P | P | P | P | P | P | I | NA |
| team-run-1440-dark.png | P | P | P | P | P | P | P | P | I | NA |
| team-run-1100-light.png | P | P | P | P | P | P | P | P | I | NA |
| team-run-1100-dark.png | P | P | P | P | P | P | P | P | I | NA |
| team-run-720-light.png | P | P | P | P | P | P | P | P | I | NA |
| team-run-720-dark.png | P | P | P | P | P | P | P | P | I | NA |

### team-run-details

[Opened six-frame sheet](INT-review-sheets/team-run-details.png).

Wide frames show timeline beside flat Run facts, including wrapped Brief, Flow file and missing provenance. 1100 floats the tool over main and 720 shows the covering Details tool; no double header. All six body crops equal B7a. Facts have the inherited tall gaps and the separate Run heading rather than the approved compact fact/Seats sequence. Items 6/9 retain inherited B8–11 panel work. Reviewed via INT-review-sheets/team-run-details.png; B7a/team-run-details-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-run-details-1440-light.png | P | P | P | P | P | I | P | P | I | P |
| team-run-details-1440-dark.png | P | P | P | P | P | I | P | P | I | P |
| team-run-details-1100-light.png | P | P | P | P | P | I | P | P | I | P |
| team-run-details-1100-dark.png | P | P | P | P | P | I | P | P | I | P |
| team-run-details-720-light.png | P | P | P | P | P | I | P | P | I | P |
| team-run-details-720-dark.png | P | P | P | P | P | I | P | P | I | P |

### team-run-equivalent

[Opened six-frame sheet](INT-review-sheets/team-run-equivalent.png).

Equivalent Writer rounds 1–2 collapse together, followed by three Not reached roles and End/Nothing waits with Wrap. Brief wraps cleanly at 720. All six body crops equal B7a. Approved grouped Run hierarchy/status strip remain inherited B8–11 work. Reviewed via INT-review-sheets/team-run-equivalent.png; B7a/team-run-equivalent-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-run-equivalent-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-equivalent-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-run-equivalent-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-equivalent-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-run-equivalent-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-equivalent-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-run-flow

[Opened six-frame sheet](INT-review-sheets/team-run-flow.png).

Flow canvas retains the Writer/Verify/Reviewer/Person path, pass/request-changes/approve labels, zoom controls and active Writer outline. It scales to fit at 1100/720; graph text becomes smaller but nothing is cut. All six body crops equal B7a. Canvas data geometry is not a reading-page measure; final status strip and shell tools remain inherited B work. Reviewed via INT-review-sheets/team-run-flow.png; B7a/team-run-flow-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-run-flow-1440-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-run-flow-1440-dark.png | P | P | P | NA | P | P | P | P | I | P |
| team-run-flow-1100-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-run-flow-1100-dark.png | P | P | P | NA | P | P | P | P | I | P |
| team-run-flow-720-light.png | P | P | P | NA | P | P | P | P | I | P |
| team-run-flow-720-dark.png | P | P | P | NA | P | P | P | P | I | P |

### team-run-not-reached

[Opened six-frame sheet](INT-review-sheets/team-run-not-reached.png).

Start/Brief, Taken 0, the four Not reached roles and No rounds have opened yet remain visible at all widths. Brief wraps whole at 720. All six body crops equal B7a. Approved grouped-role Run hierarchy/status strip remain inherited B8–11 work. Reviewed via INT-review-sheets/team-run-not-reached.png; B7a/team-run-not-reached-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-run-not-reached-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-not-reached-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-run-not-reached-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-not-reached-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-run-not-reached-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-not-reached-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-run-repeated

[Opened six-frame sheet](INT-review-sheets/team-run-repeated.png).

Repeated writer rounds 4–19 collapse to one row, with Round 20 retained below and Not reached after it. At 720 lower content meets the scroll viewport edge; no horizontal overflow or mid-word truncation is visible. Long Brief wraps. All six body crops equal B7a. Final grouped Run hierarchy/status strip remain inherited B8–11 work. Reviewed via INT-review-sheets/team-run-repeated.png; B7a/team-run-repeated-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-run-repeated-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-repeated-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-run-repeated-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-repeated-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-run-repeated-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-run-repeated-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-runs

[Opened six-frame sheet](INT-review-sheets/team-runs.png).

Runs summary, pause consequence sentence, table and count/order footer keep one left edge. At 720 the Reviewers column folds and remaining columns stay inside the page. All six body crops equal B7a. The pause sentence wraps whole. Final status strip and shell tool reduction remain inherited B work. Reviewed via INT-review-sheets/team-runs.png; B7a/team-runs-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-runs-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### team-runs-filtered

[Opened six-frame sheet](INT-review-sheets/team-runs-filtered.png).

Filtered indicator appears on top-bar View while the single Run table remains visible. At 720 Reviewers folds and the consequence sentence wraps. All six body crops equal B7a. No unintended table/order/body change accompanies filtering. Final status strip and tool reduction remain inherited B work. Reviewed via INT-review-sheets/team-runs-filtered.png; B7a/team-runs-filtered-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| team-runs-filtered-1440-light.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-filtered-1440-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-filtered-1100-light.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-filtered-1100-dark.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-filtered-720-light.png | P | P | P | P | P | P | P | P | I | P |
| team-runs-filtered-720-dark.png | P | P | P | P | P | P | P | P | I | P |

### teams

[Opened six-frame sheet](INT-review-sheets/teams.png).

Pixel-identical to B7a. Inherited legacy page heading/navigation and drawing slot differences remain for subsequent framing work.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| teams-1440-light.png | P | I | P | P | I | P | P | NA | I | P |
| teams-1440-dark.png | P | I | P | P | I | P | P | NA | I | P |
| teams-1100-light.png | P | I | P | P | I | P | P | NA | I | P |
| teams-1100-dark.png | P | I | P | P | I | P | P | NA | I | P |
| teams-720-light.png | P | I | P | P | I | P | P | I | I | P |
| teams-720-dark.png | P | I | P | P | I | P | P | I | I | P |

### topbar-probe

[Opened six-frame sheet](INT-review-sheets/topbar-probe.png).

Standalone probe keeps long CJK title, status, destinations, contextual New job and tools on one row. At 720 destinations become Findings menu and New job becomes an icon; title remains readable and right overflow stays at the window edge. All six entire frames equal B7a. Empty body is deliberate; body-edge/measure/rhythm and prototype body checks are NA. No popup is open, so menu-width/long-menu-content behavior is not claimed. Reviewed via INT-review-sheets/topbar-probe.png; B7a/topbar-probe-{1440,1100,720}-{light,dark}.png.

| Frame | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| topbar-probe-1440-light.png | P | P | NA | NA | P | NA | P | P | NA | P |
| topbar-probe-1440-dark.png | P | P | NA | NA | P | NA | P | P | NA | P |
| topbar-probe-1100-light.png | P | P | NA | NA | P | NA | P | P | NA | P |
| topbar-probe-1100-dark.png | P | P | NA | NA | P | NA | P | P | NA | P |
| topbar-probe-720-light.png | P | P | NA | NA | P | NA | P | P | NA | P |
| topbar-probe-720-dark.png | P | P | NA | NA | P | NA | P | P | NA | P |

## Owner questions

None pending. The Browser edge repair is approved.

## Evidence limits

This is the integration review of B Tasks 1–7a plus A/D/C, not a claim that B Tasks 8–11 or the full final drawing are complete. The phase A notes directory did not contain the stated EXECUTION/REVIEW files; its source commits and rendered checks were used. Images and browser logs remain local and are not committed.
