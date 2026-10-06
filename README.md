# koibill

koibill is a Linux desktop PDF reading workspace with a PDF annotator on the left and a persistent tabbed browser on the right. The browser opens ChatGPT by default, and selected PDF text can be inserted into or sent to ChatGPT, Claude, Gemini, Perplexity, or DeepSeek through the PDF context menu.

## Features

- PDF.js rendering, selectable text, search, thumbnails, page navigation, zoom presets, fit-width, fit-page, and rotation
- Focus reading with line, sentence, and paragraph spotlights, adjustable surrounding visibility, in-place magnification, and keyboard stepping
- Colored highlights and freehand pens, object eraser, undo, and redo
- Named, switchable workspaces with copied PDFs and portable, atomic manifests
- Sandboxed Chromium tabs with persistent sessions, polished independent zoom, crash/load recovery, popups-as-tabs, and HTTPS-only URLs
- Best-effort multi-provider **Ask AI** handoff with visible provider selection, retry, external-open, and explicit clipboard fallback
- Resizable split workspace with a globally collapsible Browser/Notes/Graph pane and monochrome application chrome
- Restorable multi-PDF tabs with independent reading and annotation state
- A cross-document research tray with numbered, citation-aware prompts for five AI providers
- Notes and automatically linked AI conversations on highlights and ink when a provider exposes a stable conversation URL
- One PDF-wide Markdown note plus independent per-page notes, with explicit lazy creation, autosave, edit/split/preview modes, and beautifully typeset previews
- One infinite Graph Notes canvas per PDF, with movable idea cards, connections, personal Markdown, and PDF/AI/Web source provenance
- Deterministic offline keyword headers for newly appended graph excerpts, with no LLM or network dependency
- Instant Browser/Notes/Graph switching while all three workspaces stay alive

## Development

Requirements: Node.js 22 or newer and pnpm.

```bash
pnpm install
pnpm dev
```

Useful checks:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Build the Linux installers:

```bash
pnpm dist:linux
```

Artifacts are written to `dist/` as an x86_64 AppImage and amd64 Debian package.

## Workspace folders

koibill creates named workspaces under `~/Documents/koibill-workspaces` by default. Each workspace has a `workspace.json` manifest and a `books/` directory. Importing `Book.pdf` copies it into a unique `books/koibill-Book--<id>/` bundle; koibill works only with that managed copy. Document metadata and annotations live in `metadata.json`, the PDF-wide note is `notes/document.md`, page notes use names such as `notes/page-0007.md`, and the book's visual idea graph is `graph.json`. The workspace root can be changed in Settings without moving previously registered workspaces.

## Security model

The local renderer and remote browser pages run in sandboxed, context-isolated processes. Browser tabs have no preload bridge, Node.js access, or direct filesystem access. Website permissions and in-app downloads are denied in this first release. Only HTTPS navigation is accepted.

The AI integrations operate against the providers' public website UIs rather than official APIs. Composer insertion is intentionally best-effort and falls back to retry, copy, and open-externally controls if a site changes or the user needs to sign in.
