---
name: guide
description: Use when a message comes from the Hermes IDE window, carries a [[ Element picked ]] block, or asks about the IDE. What the IDE is, what it shows the user, and how to work with it.
---

# Working with Hermes IDE

Hermes IDE is a plugin in the user's own Hermes setup (`hermes-ide`, by Coeus Institute). It opens a chat in its own Hermes Desktop window and puts a code workspace beside the chat: a file Explorer (with Search and Source Control), a CodeMirror editor with tabs, and their project's running web UI. The chat in that window is this chat, the same session, not a copy.

A turn from the IDE window carries a short "[Hermes IDE]" note. When you see it, the user is looking at their code and the running page while they talk to you.

## What the user sees and does

- **Explorer.** The folder is the chat's working directory (Open Folder can change it). Files, workspace search and git status.
- **Editor.** Tabs, find, go to line, Quick Open. Ctrl+L adds the selection to the chat as an `@file:path:from-to` reference; Ctrl+K sends you a request to edit the selected lines ("Edit lines 12-30 of src/App.tsx: ...").
- **Your edits.** When you write a file that is open in their editor, the tab reloads with an inline diff against the text before your turn, and they Keep or Undo it (whole edit or per hunk). Unsaved edits of theirs are never overwritten: they get a conflict view instead. So edit files normally with your file tools; do not ask them to reload.
- **Project UI.** The IDE finds the project's web UI (Vite, Next.js, Nuxt, Remix, SvelteKit, Astro, Angular, CRA and similar, or a static site), runs its dev server after the user trusts the project, and shows the page. Do not start a second dev server for a project the IDE is already running; if you need the URL or the server's output, ask, or read the project's scripts. After you change UI code the dev server usually hot-reloads; the user can reload the page from the IDE.
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

## Tools

- `ide_open` with `path` (and `line`) opens a file at a line in the user's editor, in this chat's IDE window, opening the window if needed. Use it when you point at code ("the handler is here"). With `url` it offers a page in the IDE.
- `desktop_preview` (Hermes' own tool) with `action: "open"` and a `url` shows a page in the app's Browser pane.

## Good to know

- The IDE reaches files on the agent's machine through its own routes; it refuses Hermes credential files (`.env`, `auth.json`, token files) on every route.
- Two builds exist: the catalog build (the page opens in the app's Browser pane; the Explorer is a panel beside the editor) and the full build (the IDE has its own Browser column). The user's messages are the same in both.
- The user may also open this chat in the main Hermes window; the "[Hermes IDE]" note appears only while the IDE window for this chat is open, or when a message carries a picked element.
