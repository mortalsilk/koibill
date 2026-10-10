# koibill 0.12.1

This release fixes PDF render cancellation errors and makes embedded browser recovery less fragile. It also cuts some startup work and adds an Electron smoke test.

## Fixed

- Cancelling a PDF render during zooming, page virtualization, reflow, reload, or shutdown no longer produces an uncaught error.
- If an embedded browser tab crashes or stops responding, koibill now rebuilds that browser surface and limits automatic retries.
- Opening an application dialog, menu, or reader popover now hides the embedded browser layer until the overlay closes.
- React renderer failures now show a recovery screen instead of leaving a blank window.
- Research sidebar labels and browser recovery notices now fit in narrow panes.

## Improved

- Notes and Graph now load when first opened instead of at startup. This cuts roughly one megabyte from the initial renderer bundle; both panes stay mounted after loading.
- The new Electron smoke test runs in a temporary profile and covers workspace creation, PDF import, zoom, Semantic Reflow, right-pane switching, collapse and expansion, and restart restoration.
- Development dependencies are pinned so builds use the same tool versions.

## Compatibility notes

- There are no changes to workspace or book formats.
- Browser logins remain in koibill's global browser profile.
- Ask AI continues to automate the ChatGPT, Claude, Gemini, Perplexity, and DeepSeek websites. Those pages change often, so their adapters may need updates. koibill does not bypass sign-in, regional restrictions, or anti-bot checks.
- This build was smoke-tested on X11. Wayland was not available on the build machine.
