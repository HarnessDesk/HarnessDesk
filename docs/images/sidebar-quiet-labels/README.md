# Quiet sidebar state labels

Evidence for code commit `d9eb6d0cae73398711e69cb47678c1f702f3edce` on `sidebar-quiet-labels`.

Synthetic preview data and isolated fake-agent native rigs only. Every frame listed below was opened and inspected. Measurements are CSS pixels; preview frames were captured at 2x.

## Rail and title measurements

The session dot right edge is 28.5px inside the sidebar. A state with no adjacent mark ends there. Each adjacent mark occupies 24px: the Approval label ends 48px left of the dot rail because its row retains a worktree glyph and dot; a Team state beside a count ends 24px left. At 200px the count yields and the Team label reaches the dot rail. All 272 visible state text boxes across the 32 sidebar captures have 0px rail error and lie fully inside their clip. They have transparent backgrounds, zero borders and horizontal padding, and no shadow.

At 200px, the Approval session title box is **23.171875px** wide in both themes (showing `Pi…`), with a **48.328125px** Approval text box, the worktree glyph and the dot retained. Removing the pill horizontal padding returns 16px to the title. See the dedicated Approval row frames and each theme's 200px rest entry in `measurements.json`.

## Preview inspection

| Frame | Inspection |
| --- | --- |
| [light-200-rest.png](light-200-rest.png) | Plain coloured labels; count yields; Working ends on the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [light-200-hover-room.png](light-200-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [light-200-hover-member.png](light-200-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count yields; Working ends on the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [light-200-hover-needs-you.png](light-200-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [light-260-rest.png](light-260-rest.png) | Plain coloured labels; count remains; Working ends 24px left of the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [light-260-hover-room.png](light-260-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [light-260-hover-member.png](light-260-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count remains; Working ends 24px left of the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [light-260-hover-needs-you.png](light-260-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [light-320-rest.png](light-320-rest.png) | Plain coloured labels; count remains; Working ends 24px left of the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [light-320-hover-room.png](light-320-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [light-320-hover-member.png](light-320-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count remains; Working ends 24px left of the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [light-320-hover-needs-you.png](light-320-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [light-540-rest.png](light-540-rest.png) | Plain coloured labels; count remains; Working ends 24px left of the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [light-540-hover-room.png](light-540-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [light-540-hover-member.png](light-540-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count remains; Working ends 24px left of the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [light-540-hover-needs-you.png](light-540-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-200-rest.png](dark-200-rest.png) | Plain coloured labels; count yields; Working ends on the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [dark-200-hover-room.png](dark-200-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-200-hover-member.png](dark-200-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count yields; Working ends on the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [dark-200-hover-needs-you.png](dark-200-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-260-rest.png](dark-260-rest.png) | Plain coloured labels; count remains; Working ends 24px left of the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [dark-260-hover-room.png](dark-260-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-260-hover-member.png](dark-260-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count remains; Working ends 24px left of the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [dark-260-hover-needs-you.png](dark-260-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-320-rest.png](dark-320-rest.png) | Plain coloured labels; count remains; Working ends 24px left of the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [dark-320-hover-room.png](dark-320-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-320-hover-member.png](dark-320-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count remains; Working ends 24px left of the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [dark-320-hover-needs-you.png](dark-320-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-540-rest.png](dark-540-rest.png) | Plain coloured labels; count remains; Working ends 24px left of the dot rail; uncounted Team labels align with dots; Approval ends 48px left; no pill or clipping. |
| [dark-540-hover-room.png](dark-540-hover-room.png) | Hovered Team label folds to a dot and its action takes the rail; member action stays hidden; other uncounted labels align with dots, Approval ends 48px left. |
| [dark-540-hover-member.png](dark-540-hover-member.png) | Only the member action appears; parent returns to quiet Working text (count remains; Working ends 24px left of the dot rail); other uncounted labels align with dots, Approval ends 48px left. |
| [dark-540-hover-needs-you.png](dark-540-hover-needs-you.png) | Hovered Needs you Team label folds to a dot; only its action appears; other uncounted labels align with dots, Approval ends 48px left. |
| [light-200-approval-title.png](light-200-approval-title.png) | Approval ends 48px left of the dot rail; glyph and dot remain; title shows Pi… in 23.17px; no pill or clipping. |
| [dark-200-approval-title.png](dark-200-approval-title.png) | Approval ends 48px left of the dot rail; glyph and dot remain; title shows Pi… in 23.17px; no pill or clipping. |

## Native inspection

These three requested scenes check real Electron row and hover behavior. Their staged sessions carry checkout marks but no state labels, so label-to-dot alignment is supplied by the preview frames above.

| Frame | Inspection |
| --- | --- |
| [native-session-rest-light.png](native-session-rest-light.png) | No state label or state dot is present; checkout marks are inset from the sidebar edge. |
| [native-workspace-hover-light.png](native-workspace-hover-light.png) | No state label or state dot is present; the project actions occupy the trailing rail while its pin yields one action step. |
| [native-session-hover-light.png](native-session-hover-light.png) | No state label or state dot is present; the session action occupies the trailing rail and the folder/worktree marks move left without overlap. |
| [native-session-rest-dark.png](native-session-rest-dark.png) | No state label or state dot is present; checkout marks are inset from the sidebar edge. |
| [native-workspace-hover-dark.png](native-workspace-hover-dark.png) | No state label or state dot is present; the project actions occupy the trailing rail while its pin yields one action step. |
| [native-session-hover-dark.png](native-session-hover-dark.png) | No state label or state dot is present; the session action occupies the trailing rail and the folder/worktree marks move left without overlap. |
