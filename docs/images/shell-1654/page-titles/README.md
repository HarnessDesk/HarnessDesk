# Page titles in the content column

Captured 2026-10-15 for PR #1668 from the preview harness. Both themes at 1100px and 1800px. Reading pages stop at 736px; wide pages stop at 1320px. Scrolled frames use a 360px-high window so the short Teams board can scroll without synthetic content.

Usage is an account section in this checkout, under Settings > Runtimes. There is no standalone Usage route: the account frames retain the Runtimes h1 and include its Usage content when scrolled. Flows is an embedded project list and Inbox is a popover; neither has a standalone page or bar title to move.

The [verification record](VERIFICATION.md) lists the commands, case counts and limits.

## Owner checks

- Each standalone page has one body h1, no bar title, and a named destination region. The session retains its bar title menu and has no body h1.
- At both widths, the title starts on the content column edge. The page role supplies 20px type, 28px line height and the existing semibold weight token.
- The title shares its first row with the primary chooser or verb. Search and secondary filters follow at the shared 16px page stack gap. The first content block uses that same gap.
- Long-title frames show wrapping at 1100px and a one-line fit at 1800px; New skill keeps its x position and width.
- Collapsed frames show the rail toggle separately from the content column. Scrolled frames show the title gone and the same bar DOM, position and 40px height. Bar crops span the full window width.

## Bar measurements from the DOM

Every normal before/after bar measured 40px. Collapsed and scrolled bars also measure 40px. JSON files beside each full frame record all remaining buttons and their horizontal geometry.

| Scene/state | Remaining controls |
| --- | --- |
| Settings, rail open | None |
| Settings, rail collapsed/scrolled | Show sidebar |
| Teams, Library, Agents, Plugins, Dashboard, rail open | More |
| Teams, rail collapsed/scrolled | Show sidebar, More |
| Session | State dot, Code reviewer · Worktree Management title menu, Toggle rail, divider, Terminal, Changes, Browser, Files, More |

Show sidebar starts at x=12 and is 28px wide. More starts at x=1060 (1100px window) or x=1760 (1800px window), also 28px wide. No title or control is added on scroll.

## Every frame

| Path | What it shows |
| --- | --- |
| [before/agents-1100-dark.png](before/agents-1100-dark.png) | Baseline before moving titles |
| [before/agents-1100-light.png](before/agents-1100-light.png) | Baseline before moving titles |
| [before/agents-1800-dark.png](before/agents-1800-dark.png) | Baseline before moving titles |
| [before/agents-1800-light.png](before/agents-1800-light.png) | Baseline before moving titles |
| [before/library-1100-dark.png](before/library-1100-dark.png) | Baseline before moving titles |
| [before/library-1100-light.png](before/library-1100-light.png) | Baseline before moving titles |
| [before/library-1800-dark.png](before/library-1800-dark.png) | Baseline before moving titles |
| [before/library-1800-light.png](before/library-1800-light.png) | Baseline before moving titles |
| [before/session-1100-dark.png](before/session-1100-dark.png) | Named session: title menu remains in the fixed bar |
| [before/session-1100-light.png](before/session-1100-light.png) | Named session: title menu remains in the fixed bar |
| [before/session-1800-dark.png](before/session-1800-dark.png) | Named session: title menu remains in the fixed bar |
| [before/session-1800-light.png](before/session-1800-light.png) | Named session: title menu remains in the fixed bar |
| [before/settings-account-usage-1100-dark.png](before/settings-account-usage-1100-dark.png) | Baseline before moving titles |
| [before/settings-account-usage-1100-light.png](before/settings-account-usage-1100-light.png) | Baseline before moving titles |
| [before/settings-account-usage-1800-dark.png](before/settings-account-usage-1800-dark.png) | Baseline before moving titles |
| [before/settings-account-usage-1800-light.png](before/settings-account-usage-1800-light.png) | Baseline before moving titles |
| [before/teams-1100-dark.png](before/teams-1100-dark.png) | Baseline before moving titles |
| [before/teams-1100-light.png](before/teams-1100-light.png) | Baseline before moving titles |
| [before/teams-1800-dark.png](before/teams-1800-dark.png) | Baseline before moving titles |
| [before/teams-1800-light.png](before/teams-1800-light.png) | Baseline before moving titles |
| [after/agents-1100-dark.png](after/agents-1100-dark.png) | Body title and primary controls on the content column |
| [after/agents-1100-light.png](after/agents-1100-light.png) | Body title and primary controls on the content column |
| [after/agents-1800-dark.png](after/agents-1800-dark.png) | Body title and primary controls on the content column |
| [after/agents-1800-light.png](after/agents-1800-light.png) | Body title and primary controls on the content column |
| [after/dashboard-1100-dark.png](after/dashboard-1100-dark.png) | Body title and primary controls on the content column |
| [after/dashboard-1100-light.png](after/dashboard-1100-light.png) | Body title and primary controls on the content column |
| [after/dashboard-1800-dark.png](after/dashboard-1800-dark.png) | Body title and primary controls on the content column |
| [after/dashboard-1800-light.png](after/dashboard-1800-light.png) | Body title and primary controls on the content column |
| [after/library-1100-dark.png](after/library-1100-dark.png) | Body title and primary controls on the content column |
| [after/library-1100-light.png](after/library-1100-light.png) | Body title and primary controls on the content column |
| [after/library-1800-dark.png](after/library-1800-dark.png) | Body title and primary controls on the content column |
| [after/library-1800-light.png](after/library-1800-light.png) | Body title and primary controls on the content column |
| [after/library-long-title-1100-dark.png](after/library-long-title-1100-dark.png) | Long page name stays in its column without moving or shrinking the verb |
| [after/library-long-title-1100-light.png](after/library-long-title-1100-light.png) | Long page name stays in its column without moving or shrinking the verb |
| [after/library-long-title-1800-dark.png](after/library-long-title-1800-dark.png) | Long page name stays in its column without moving or shrinking the verb |
| [after/library-long-title-1800-light.png](after/library-long-title-1800-light.png) | Long page name stays in its column without moving or shrinking the verb |
| [after/plugins-1100-dark.png](after/plugins-1100-dark.png) | Body title and primary controls on the content column |
| [after/plugins-1100-light.png](after/plugins-1100-light.png) | Body title and primary controls on the content column |
| [after/plugins-1800-dark.png](after/plugins-1800-dark.png) | Body title and primary controls on the content column |
| [after/plugins-1800-light.png](after/plugins-1800-light.png) | Body title and primary controls on the content column |
| [after/session-1100-dark.png](after/session-1100-dark.png) | Named session: title menu remains in the fixed bar |
| [after/session-1100-light.png](after/session-1100-light.png) | Named session: title menu remains in the fixed bar |
| [after/session-1800-dark.png](after/session-1800-dark.png) | Named session: title menu remains in the fixed bar |
| [after/session-1800-light.png](after/session-1800-light.png) | Named session: title menu remains in the fixed bar |
| [after/settings-account-usage-1100-dark-bar.png](after/settings-account-usage-1100-dark-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/settings-account-usage-1100-dark-collapsed.png](after/settings-account-usage-1100-dark-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/settings-account-usage-1100-dark-scrolled.png](after/settings-account-usage-1100-dark-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/settings-account-usage-1100-dark.png](after/settings-account-usage-1100-dark.png) | Body title and primary controls on the content column |
| [after/settings-account-usage-1100-light-bar.png](after/settings-account-usage-1100-light-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/settings-account-usage-1100-light-collapsed.png](after/settings-account-usage-1100-light-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/settings-account-usage-1100-light-scrolled.png](after/settings-account-usage-1100-light-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/settings-account-usage-1100-light.png](after/settings-account-usage-1100-light.png) | Body title and primary controls on the content column |
| [after/settings-account-usage-1800-dark-bar.png](after/settings-account-usage-1800-dark-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/settings-account-usage-1800-dark-collapsed.png](after/settings-account-usage-1800-dark-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/settings-account-usage-1800-dark-scrolled.png](after/settings-account-usage-1800-dark-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/settings-account-usage-1800-dark.png](after/settings-account-usage-1800-dark.png) | Body title and primary controls on the content column |
| [after/settings-account-usage-1800-light-bar.png](after/settings-account-usage-1800-light-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/settings-account-usage-1800-light-collapsed.png](after/settings-account-usage-1800-light-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/settings-account-usage-1800-light-scrolled.png](after/settings-account-usage-1800-light-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/settings-account-usage-1800-light.png](after/settings-account-usage-1800-light.png) | Body title and primary controls on the content column |
| [after/teams-1100-dark-bar.png](after/teams-1100-dark-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/teams-1100-dark-collapsed.png](after/teams-1100-dark-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/teams-1100-dark-scrolled.png](after/teams-1100-dark-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/teams-1100-dark.png](after/teams-1100-dark.png) | Body title and primary controls on the content column |
| [after/teams-1100-light-bar.png](after/teams-1100-light-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/teams-1100-light-collapsed.png](after/teams-1100-light-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/teams-1100-light-scrolled.png](after/teams-1100-light-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/teams-1100-light.png](after/teams-1100-light.png) | Body title and primary controls on the content column |
| [after/teams-1800-dark-bar.png](after/teams-1800-dark-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/teams-1800-dark-collapsed.png](after/teams-1800-dark-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/teams-1800-dark-scrolled.png](after/teams-1800-dark-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/teams-1800-dark.png](after/teams-1800-dark.png) | Body title and primary controls on the content column |
| [after/teams-1800-light-bar.png](after/teams-1800-light-bar.png) | Full-window crop of the 40px bar with the rail collapsed |
| [after/teams-1800-light-collapsed.png](after/teams-1800-light-collapsed.png) | Rail collapsed: title stays on the content edge, clear of the rail toggle |
| [after/teams-1800-light-scrolled.png](after/teams-1800-light-scrolled.png) | Title scrolled out of view; the bar retains identical DOM and geometry |
| [after/teams-1800-light.png](after/teams-1800-light.png) | Body title and primary controls on the content column |
