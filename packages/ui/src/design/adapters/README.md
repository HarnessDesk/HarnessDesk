# Specialized rendering adapters

Specialized engines remain behind the same resolved foundation instead of
becoming alternate UI systems:

- CodeMirror and syntax highlighting consume the `--hd-code-*` contract from
  `styles/editor.css`.
- xterm and terminal chrome consume semantic surface, ink, selection, and focus
  tokens from their production pane adapters.
- Browser, PDF, and user-authored preview contents stay isolated; only their
  first-party HarnessDesk chrome is themed.
- Native menus, file pickers, traffic lights, and operating-system window
  surfaces remain native and are recorded as such in the migration ledger.

These boundaries may translate foundation values into an engine API. They may
not define ordinary buttons, fields, menus, dialogs, or an independent palette.
