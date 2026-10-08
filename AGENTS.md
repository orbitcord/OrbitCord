## Learned User Preferences

- After finishing a fix, expect the user to ask to commit and launch the app for testing; commit only the files for that task and leave unrelated local edits uncommitted.
- Keep chat bubbles one consistent iMessage-style shape (18px rounded rect, no separate tail; grouped rows only tighten shared inner corners) across every appearance mode; modes differ only in color and avatar placement. Exceptions: the Phosphor theme gives bubbles near-square 4px corners, and the custom theme's Corners choice sets them (Square 4px, Soft 18px, Round 24px).
- Keep avatar visibility consistent with the selected appearance setting, including for messages rendered outside a bubble (stickers, media).
- Show emoji-only messages and stickers without a bubble; show reply quotes as a lightweight connector line above the bubble, not as a bubble card.
- Lowcord settings pages opened from Discord's settings should feel native: fill Discord's settings content column, keep Discord's sidebar and close (X) button, and never open as a nested popover or separate floating pane.
- Leave media upload, drag-and-drop, and delete on Discord's native behavior; do not restyle or resize Discord's attachment grid internals.
- Prefer network-level request hooks over patching Discord's code for new extensions; keep all extensions on by default except social photo/carousel uploads, which users enable themselves.
- Prioritize low memory, low CPU, and fast startup while staying cross-platform (macOS, Windows, Linux).

## Learned Workspace Facts

- Lowcord uses Electron to load discord.com in codec-enabled Chromium, with a Rust backend over private stdio IPC. `electron/main.cjs` owns the window, tray and permissions; `src-tauri/src/` handles notifications, external links and saved window state. Tauri/CEF/Wry are no longer dependencies; the `src-tauri` source directory name is retained. There is no Vencord: `src-tauri/injection/discord.js` reads Discord's webpack cache, `extensions.js` holds the built-in extensions (network-level hooks), `settings.js` the Lowcord Settings pages (inline in Discord's settings content column, or a dialog when opened from the tray).
- Chat appearance (bubbles, avatars, media alignment) lives in `src-tauri/injection/chat-appearance.js` and `src-tauri/injection/chat-appearance.css`.
- Run the app with `pnpm dev` (builds Rust and a sandboxed preload; relaunch after source edits); dev builds expose DevTools on 127.0.0.1:9222 for Playwright `connectOverCDP`. `pnpm test` runs the Chromium fixture suites, `pnpm test:electron` verifies real Electron media decoding and native IPC, and `pnpm test:native` runs Rust tests. `pnpm build:dir` packages an app for the current platform in `dist/`.
- Discord's i18n table is a Proxy that answers every property; module lookups must require real functions and reject objects with made-up properties.
- Bubble rules must be scoped `[id^="chat-messages-"] > [data-lowcord-…]`: Discord's message padding and spacing are `!important` logical properties that otherwise win.
- Broad CSS selectors matching Discord class substrings (e.g. `container`) break nested Discord layouts like the attachment grid and hover toolbar; scope selectors narrowly.
- Unbubbled message text must set its own color, or it inherits black and disappears in dark mode.
- Themes: palettes and the picker live in `src-tauri/injection/themes.js`; `themes.css` maps the palette onto Discord's semantic tokens, then holds `/* @theme <id> */` blocks. Only the active theme's CSS is injected; Discord's own look adds nothing. Keep text one size across themes: theme fonts render through `font-size-adjust` at gg sans's x-height (.47), because fallbacks differ a lot (Menlo is ~16% taller than gg sans).
- A rule matched against every element (e.g. a universal `::selection`) added ~15% to Discord's style recalc. Put highlight colors on `:root::selection` (highlights inherit) and keep Discord class-substring selectors as the styled element, never an ancestor.
