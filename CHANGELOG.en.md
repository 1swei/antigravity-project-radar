# Changelog

## v1.0.5 (2026-11-21)

- **Support Host-Injected Credentials in Antigravity `2.34.0+`**: Added and exported `serverFromEnv()` and `serverFromDiscovery()` in [client.mjs](sidecars/panel/client.mjs) to consume `ANTIGRAVITY_LS_ADDRESS` and the scoped `ANTIGRAVITY_CSRF_TOKEN` injected by the host when `language_server` omits `--csrf_token` from its CLI args; enforces strict loopback HTTP (`127.0.0.1` / `localhost` / `[::1]`) and token validation, preserves legacy `--csrf_token` discovery, prevents cross-generation port mismatches, and disambiguates multiple instances.
- **Sidecar Keep-Alive & Diagnostics Without CDP**: Enabled `integration.start({ keepAlive: true })` in [main.mjs](sidecars/panel/main.mjs) so the sidecar stays alive when Antigravity `2.33.0+` launches without `--remote-debugging-port=0` instead of cycling every 60s; added `cdp-port-missing` health reporting in [runtime-ui.mjs](compat/runtime-ui.mjs).

## v1.0.4 (2026-11-18)

- **Frameless Transparent-Canvas Logo**: Redesigned [logo.svg](assets/logo.svg) without the dark rounded-square tile into a borderless cobalt radar dish with a bright cyan sweep arc, amber attention beacon, and emerald checkmark badge separated by a true transparent `<mask>` cutout for crisp contrast on both Light and Dark themes.

## v1.0.3 (2026-11-18)

- **Initial public release**: Surfaces live parallel task indicators (**running / waiting / error / unread completed**) directly at the far right of collapsed **Projects** rows in Antigravity 2.0.
- **Unified far-right alignment**: Aligns both per-project badges and the `Projects` header global summary pill to the far right edge; hovering a row smoothly shifts native `⋮` / `+` actions to the left of the badge without moving the badge under the cursor.
- **Hover/click task popovers & zero-reload SPA navigation**: Preview active durations, subagent counts, and newly finished conversations without expanding project trees, and jump straight to any conversation via the host TanStack Router; only running tasks tick per second while waiting/done tasks display static clock timestamps.
- **Accurate attribution & bidirectional read sync**: Attributes tasks via `GetAllCascadeTrajectories` workspaces (with CJK URI decoding) and rolls up subagents; persists unread completions in `radar-state.json` and reverse-syncs with host `annotations.lastUserViewTime`.
- **Native theme & font adaptation**: Inherits host `document.body` font family and composited Light/Dark CSS tokens, running in an isolated CDP namespace alongside `antigravity-context`.
