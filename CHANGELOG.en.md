# Changelog

## v1.0.3 (2026-11-18)

- **Initial public release**: Surfaces live parallel task indicators (**running / waiting / error / unread completed**) directly at the far right of collapsed **Projects** rows in Antigravity 2.0.
- **Unified far-right alignment**: Aligns both per-project badges and the `Projects` header global summary pill to the far right edge; hovering a row smoothly shifts native `⋮` / `+` actions to the left of the badge without moving the badge under the cursor.
- **Hover/click task popovers & zero-reload SPA navigation**: Preview active durations, subagent counts, and newly finished conversations without expanding project trees, and jump straight to any conversation via the host TanStack Router; only running tasks tick per second while waiting/done tasks display static clock timestamps.
- **Accurate attribution & bidirectional read sync**: Attributes tasks via `GetAllCascadeTrajectories` workspaces (with CJK URI decoding) and rolls up subagents; persists unread completions in `radar-state.json` and reverse-syncs with host `annotations.lastUserViewTime`.
- **Native theme & font adaptation**: Inherits host `document.body` font family and composited Light/Dark CSS tokens, running in an isolated CDP namespace alongside `antigravity-context`.
