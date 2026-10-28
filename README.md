# Example — a Kehikot module

<!-- One paragraph: what a person gets from this module, in their words. Rewrite it when you make the module yours. -->
Short notes about the epic you are working on, kept with the project and filed
under the parts of the epic you had picked when you wrote them.

- **Follows the parts you pick.** Pick parts in Kehikot's bar and Example shows
  only the notes written under them; with none picked, the whole epic.
- **Open notes wait in your Inbox.** Each open note of the epic is in Kehikot's
  Inbox until you tick it off.
- **View › Open notes / All notes.** One switch in the container's header.
- **Agents read, you write.** An agent on the kehikko reads the notes with
  `list_notes`; adding, finishing and removing are yours.

## Skills

<!-- One bullet per skill: what typing it does. Only a person runs a skill. -->
- **`/example`**: an agent reads the notes of this epic and tells you which are
  still open. Offered in Kehikot's Settings › Skills like any module's.

## Data

<!-- Every file this module keeps, and where. Only ever under .kehikot/<folder>/. -->
- `<project>/.kehikot/example/notes.json` — the notes, with the epic and parts
  each was written under.

## Try it

1. `bun install`, then `bun run stub`: the module, framed the way Kehikot frames
   it, with a project, an epic and three parts to pick.
2. Push the repository to GitHub, then in Kehikot: the modules list › **Install
   from repository…** › `owner/repo`. Kehikot reads it with your own `gh`,
   installs its newest release (or `main`, before the first), and starts it.

## Development

```
bun test               # the manifest, the doors, the store, the storage boundary, the header, the Inbox, the page
bun run typecheck
bun run stub           # look at it, framed, without Kehikot
```

If the module needs a newer Kehikot than someone has, or is too old for theirs,
Kehikot says so in the module's container, with the button that updates the right
one. It works this out from the manifest, so there is nothing to write for it
([Whether a module and a host fit](https://github.com/Jalez/kehikko-protocol/blob/main/docs/fit.md)).

How it is built and released, and the rules a change keeps: [CLAUDE.md](CLAUDE.md).
The whole guide: [Building a module](https://github.com/Jalez/kehikko-protocol/blob/main/docs/building-a-module.md).

## Starting a module from this template

This repository is a GitHub template. Make yours with
`gh repo create <owner>/kehikko-<name> --template Jalez/kehikko-module-template --private --clone`
(or `--public`), then, inside it:

```
bun install
bun run rename <name>      # the id, the name, the data folder, the skill and a free port
bun install && bun test
```

Or type `/kehikot-module` in Claude Code: Kehikot's own skill asks what the
module is for, writes a one-page design with you, and builds it from here.
