# Notes

A free, lightweight, local-first notes app. Your notes are plain Markdown files in a folder you choose. No dependencies, no build step, no accounts: just Node.js.

## Run

```sh
node server.js [notesDir] [port]
# e.g.
node server.js ~/Notes          # http://localhost:4777
```

`notesDir` defaults to `./notes` and `port` to `4777` (or `$PORT`). Requires Node.js 18+. You can point it at an existing Obsidian vault or any folder of `.md` files.

## Features

- **Markdown files on disk**: subfolders work (`folder/name`); anything else that reads Markdown can open them.
- **Wikilinks**: `[[Note]]` and `[[Note|alias]]`. Links to missing notes are created on click. Renaming a note updates links to it.
- **Backlinks**: each note shows which notes link to it.
- **Graph view**: force-directed graph of notes and links; drag, pan, zoom, click to open.
- **Tags**: write `#tag` or `#parent/child`; filter from the sidebar chips.
- **Search**: full-text across all notes, with snippets.
- **Quick switcher**: jump to or create a note.
- **Autosave** and automatic dark mode.
- **Git sync**: optional, manual or every 2 minutes.

## Shortcuts

| Key | Action |
|---|---|
| Ctrl/Cmd+K | Quick switcher (jump or create) |
| Ctrl/Cmd+N | New note |
| Ctrl/Cmd+E | Toggle edit / preview |
| Ctrl/Cmd+G | Toggle graph view |
| Ctrl/Cmd+S | Save now |

## Sync

The notes folder is just files, so sync uses git:

1. Create an empty **private** repo on your git host.
2. Click **Sync** (bottom of the sidebar) and enter the remote URL (`https://…`, `ssh://…` or `git@host:user/repo.git`).
3. Each sync commits changes, pulls with rebase, and pushes. On a conflict the rebase is aborted and an error is shown; nothing is lost locally.
4. Tick **Auto** to sync every 2 minutes while the tab is visible.

Authentication is whatever git already uses on your machine (SSH keys, credential helper). Prefer iCloud, Dropbox or Syncthing? Point the app at a folder inside one and ignore the Sync button.

## Security

- Listens on `127.0.0.1` only and rejects requests whose `Host` isn't localhost (DNS-rebinding) or whose `Origin` is another site.
- Note paths are confined to the notes folder.
- Sync remotes are limited to `https://`, `ssh://` and `git@host:path` URLs.
- There is no authentication: anyone with access to your local machine's port can read your notes. Don't expose the port.

## Layout

```
server.js        zero-dependency HTTP server + file/git API
public/index.html  the whole UI (HTML, CSS, JS)
```

## Limits

No tables, images or syntax highlighting in preview yet; the graph layout is O(n²), fine for a few hundred notes; the layout is not designed for phones.
