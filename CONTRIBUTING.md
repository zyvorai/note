# Contributing to Plainnote

Thanks for helping! Plainnote is a small, fast, local-first notes app and we want to keep it that way.

## Ground rules

- **Zero runtime dependencies.** No `npm install` for users, no bundlers, no frameworks. If a feature needs a library, it probably belongs elsewhere.
- **Notes stay plain Markdown files.** Nothing may require a database or a proprietary format.
- **Local and private by default.** No telemetry, no network calls without an explicit opt-in.
- Keep it light: fewer lines beat more features.

## Getting started

```sh
git clone https://github.com/zyvorai/note && cd note
node server.js ./notes 4777     # http://localhost:4777  (Node.js 20+)
npm test                        # unit, API and headless-Chrome UI tests
```

The browser test needs Chrome, Edge or Chromium and is skipped if none is found. `UI_SHOTS=dir npm test` saves screenshots; `node scripts/screenshots.js` regenerates the website images in `docs/assets/`.

## Project layout

| Path | What lives there |
|---|---|
| `server.js` | zero-dependency HTTP server and file/git API |
| `public/index.html` | the whole UI (HTML, CSS, JS) |
| `public/md.js` | Markdown renderer and editor helpers (pure functions, shared with tests) |
| `desktop/` | macOS wrapper (Swift), cross-platform launcher, icon generator |
| `scripts/` | single-file executable build, screenshot generator |
| `docs/` | the website (GitHub Pages) |
| `tests/` | unit, API and browser tests |

## Making a change

1. Open an issue first for anything big, so we can agree on the shape.
2. Branch from `main`, keep the change focused.
3. Add or update tests. Pure logic goes in `tests/md.test.js`, behaviour in `tests/ui.test.js`, routes in `tests/server.test.js`.
4. Run `npm test` and make sure it passes.
5. Open a pull request describing what and why, with a screenshot for UI changes (light and dark).

## Security

Please don't file security problems as public issues. See [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the [MIT License](LICENSE).
