# Compact visual Team start

The requested outcome is a minimal, direct Team/Flow launch with strong visual alignment and useful prebuilt Agents. Research scope is Orca, Agent Orchestrator and Paperclip. The desktop walkthrough and source evidence are recorded in the companion verification reports.

## Chosen direction

Keep one dialog with one task field, one selected Flow and a prepared roster. A short initial selection offers common/project/recent Flows and Just a Team; the full searchable catalog stays available on demand. Once a Flow is selected, replace the catalog with its name, existing policy graph and Change action. Changing a Flow preserves each Flow's draft and the task.

The roster names the actual instruction preset and resolved runtime for every role. One compact configuration control per role opens runtime, model, effort and instruction choices locally. Existing policy, provider independence, held access, asynchronous preview invalidation and optional judge/check behavior remain authoritative. A same-provider refusal is explained beside the affected role; simplification never relaxes it.

Optional completion and expert information use progressive disclosure. Required non-primary Flow inputs remain visible and validated. Start remains governed by a fresh preview token; a graphical summary must describe the policy actually sent to the engine.

Prebuilt Agent pages offer a visible Choose runtime action and Customize action. Choosing a primary local runtime uses the existing strict seating write and expected-value guard; it preserves other existing local fallbacks. With no local list, it creates an explicit local override. Add fallback remains available in the detailed preferences. Shipped Agent files are not silently rewritten.

## Alternatives considered

- A multi-step wizard reduces each page but adds navigation and obscures the task/roster relationship. It conflicts with the request for fewer pages.
- A chat-only coordinator is concise but does not expose the exact enforced Flow policy before execution.
- The chosen compact dialog keeps task, policy and roster visible together, and leaves graph authoring in the existing Flow editor.

## Visual contract

- Use the existing design system, type scale, tokens, Dialog/Popover behavior and Flow graph renderer.
- Align selected Flow, task, roster, warnings and advanced disclosure to one content edge.
- Use equal role-control columns; long runtime/model labels may truncate as names, while refusal sentences wrap.
- One visible configuration control per ordinary role; no permanent row of runtime/model/effort menus.
- Inspect ordinary and narrow desktop windows, both themes. Verify text, control and graph bounds rather than relying on an attractive frame.

## Acceptance

- Common start is task → one Flow choice → inspect roster → Start, without opening another page or editing a file.
- Full catalog search, keyboard navigation, custom/unsaved/project Flows and Change remain reachable.
- Switching Flow and returning retains task, per-Flow variables, runtime choices and policy edits.
- Every displayed override reaches the preview and start request; late responses cannot restore an obsolete Start token.
- Required inputs and blocking reasons remain visible; optional details do not block ordinary setup.
- Preset runtime choice is reachable from the top of its page, defaults to its actual current selection when available, and preserves explicit local fallbacks and concurrent-edit refusal.
- Existing partial-start recovery and the three preceding correctness fixes remain covered.

## Implementation plan

1. Add a canonical selected-Flow presentation in the design system; test it, then use it to collapse the FrontDoor catalog and bound the initial choices. Keep selected graph and Change together. Add coverage for draft retention and full catalog access.
2. Compact FlowStart role configuration using existing primitives. Test actual runtime/model/effort/instruction policy writes, optional roles, provider refusal and focus/Escape behavior.
3. Add direct prebuilt-Agent runtime choice and visible customization using existing authoring/seating APIs. Test primary replacement, fallback retention, inherited defaults and stale writes.
4. Integrate, run focused tests and gates, build and walk the real app. Capture placeholder-only light/dark frames and measure alignment. Review the final PR with the requested local reviewer, address verified findings and rerun review on the final head.

The phrase “10x better” is the quality target, not a measured result. Record changes in required decisions, controls shown, page navigation and launch/recovery behavior before making a quantitative claim.
