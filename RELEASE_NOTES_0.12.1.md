# koibill 0.12.1

This patch focuses on reader stability, browser recovery, and day-to-day interface polish.

## Fixed

- PDF rendering cancellation during zooming, page virtualization, reflow crops, reloads, and shutdown no longer produces uncaught errors.
- Embedded browser tabs now use bounded recovery and replace crashed or persistently unresponsive browser surfaces.
- Application dialogs, menus, and reader popovers reliably hide the embedded browser layer while open.
- Unexpected React rendering failures show a recovery screen instead of leaving an unexplained white window.
- Narrow research sidebars and browser recovery notices remain readable and usable.

## Improved

- Notes and Graph load on first use, reducing the initial renderer bundle by about one megabyte, and remain mounted afterward.
- Added an isolated Electron smoke test covering workspace creation, PDF import, zoom, Semantic Reflow, right-pane modes, collapse/expand, and restart restoration.
- Direct development dependencies are pinned for reproducible builds.

## Compatibility notes

- Workspace and book formats are unchanged.
- Existing browser logins remain in koibill's global browser profile.
- Ask AI still depends on third-party web interfaces. ChatGPT, Claude, Gemini, Perplexity, and DeepSeek may require adapter updates when their websites change; koibill does not bypass sign-in, regional restrictions, or anti-bot checks.
- This build was smoke-tested under X11. A Wayland session was not available on the build host.
