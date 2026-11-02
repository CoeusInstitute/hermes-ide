---
name: guide
description: Use when a request mentions the IDE (open the project's UI, show a file, the IDE browser), comes from the Hermes IDE window, or carries a [[ Element picked ]] block. Which ide_open call to make, what it reports, and how to answer element picks.
---

# Working with Hermes IDE

Hermes IDE is a plugin in the user's own Hermes setup (`hermes-ide`, by Coeus Institute). It opens a chat in its own Hermes Desktop window and puts a code workspace beside the chat: a file Explorer (with Search and Source Control), a CodeMirror editor with tabs, and their project's running web UI. The chat in that window is this chat, the same session, not a copy. A turn from the IDE window carries a short "[Hermes IDE]" note.

## What to do for common requests

| The user asks | Do this |
|---|---|
| "Open / run / start / show / preview the project's UI (app, site, dev server) in the IDE (browser)" | `ide_open` with `ui: true`. Nothing else. |
| "Open X in the IDE", "show me where Y is" | `ide_open` with `path` (and `line`). |
| "Show this page in the IDE" (a page that is already running) | `ide_open` with `url`. |
| "Open this project / folder in the IDE" | The user chooses the folder in the IDE (Open Folder, or a new IDE workspace from the IDE button). If this chat should work there, change your working directory as you normally would; the IDE follows the chat's folder. |

`ide_open` waits for the IDE window and returns what it actually did:

| status | Meaning | What to tell the user |
|---|---|---|
| `running` (with `url`) | The project's dev server is up and the page is in the IDE's Browser. | Say it is open, with the URL. |
| `needs_trust` | The IDE found the project's UI but runs nothing unasked: it is showing **Always run for this project / Run once / Not now** in its Browser (catalog build: its Run view). | Ask them to click Always run or Run once in the IDE. Do not try to start it another way. |
| `starting` | Installing dependencies or starting; the IDE shows the page when it is ready. | Say it is starting. |
| `opened` | The file or page is shown. | Nothing more to do. |
| `no_ui` | No web UI was found in the IDE's folder (`detail` says what was looked for). | Say so; Python web UIs (Streamlit, Flask, Django) are not detected. If they run one, `ide_open` with its `url`. |
| `no_folder` | The IDE has no folder open. | Ask them to open the project folder in the IDE. |
| `no_window` | No Hermes IDE window answered (Hermes Desktop closed, the plugin's Desktop half off, or the gateway not restarted after an update). | Tell them that, plainly. |
| `error` | It failed; `detail` has the reason (for a dev server, its last output). | Report the reason; fix the project if the output shows a code error. |

Never, for the IDE:

- start the dev server yourself (`npm run dev` in a terminal, background or not). The IDE runs and stops its own servers; yours duplicates it on another port, and a background process keeps this chat marked as working until it is killed;
- inspect or drive the IDE window with screenshots, computer use, CDP, `netstat` or by reading the plugin's source: `ide_open`'s answer is the IDE's own report;
- retry the same call in a loop. One call, then tell the user what it said.

## What the user sees and does

- **Explorer.** The folder is the chat's working directory (Open Folder can change it). Files, workspace search and git status.
- **Editor.** Tabs, find, go to line, Quick Open. Ctrl+L adds the selection to the chat as an `@file:path:from-to` reference; Ctrl+K sends you a request to edit the selected lines ("Edit lines 12-30 of src/App.tsx: ...").
- **Your edits.** When you write a file that is open in their editor, the tab reloads with an inline diff against the text before your turn, and they Keep or Undo it (whole edit or per hunk). Unsaved edits of theirs are never overwritten: they get a conflict view instead. So edit files normally with your file tools; do not ask them to reload.
- **Project UI.** After you change UI code the dev server usually hot-reloads; the user can reload the page from the IDE.
- **Element picker.** The user clicks an element on the running page and the IDE puts a token in the composer that expands, when they send, into a block like this:

```
[[ Element picked in the IDE browser (http://localhost:5173/):
- selector: `button.cta-button` (<button> 87×35), text "Mark all done"
- component: App › TaskList › DoneButton (React)
- attributes: type="button"
- html: `<button class="cta-button">Mark all done</button>`
- styles: display: inline-block; color: rgb(255, 255, 255); background-color: rgb(99, 102, 241); ...
- source: @file:src/components/DoneButton.tsx:14
]]
```

Each `[[ ... ]]` block is one element, between the opening `[[` and the closing `]]`. Several blocks mean several elements. Treat the element as what the user means by "this", "that button", "here".

## Answering an element pick

1. Find the code that renders it. Prefer, in order: the `source:` reference (a development build named the component's own file and line); the `component:` names (search for the component); the `likely source:` references (a search of the project for its id, text or class); then the selector, classes and text.
2. Use the computed `styles` to explain what you see (they are the browser's resolved values, not the stylesheet's source). Find the rule that sets them before changing it: a Tailwind class, a CSS module, a styled-component, a global stylesheet.
3. Change the source, not the built output (`dist/`, `.next/`, `build/`).
4. Say what you changed in a sentence; the user sees the diff in their editor and the result in the page.

## Good to know

- `desktop_preview` (Hermes' own tool) with `action: "open"` and a `url` shows a page in the app's Browser pane. In the catalog build of the IDE, a `running` answer says to use it to show the page.
- The IDE reaches files on the agent's machine through its own routes; it refuses Hermes credential files (`.env`, `auth.json`, token files) on every route.
- Two builds exist: the catalog build (the page opens in the app's Browser pane; the Explorer is a panel beside the editor) and the full build (the IDE has its own Browser column). The user's messages are the same in both.
- The "[Hermes IDE]" note appears while the IDE window for this chat is open, or when a message carries a picked element.
