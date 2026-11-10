# Release notes

One file per release, `<version>.md`, holding only that release's "What's new"
bullets. The release workflow refuses to publish a version without one, and puts
it on the release page, which is what Kehikot shows when it offers the update.

How to write them: the rules for the Kehikot app's own notes,
[kehikko-desktop's CLAUDE.md, "Release notes"](https://github.com/Jalez/kehikko-desktop/blob/main/CLAUDE.md#release-notes),
from this module's side:

- 1–5 bullets, each `- **Short bold lead.** One or two plain sentences.`
- What a person sees in this module, can now do, or no longer suffers.
- No commit hashes, PR numbers, file or function names, protocol versions,
  install text or hype. Never invent.
- "Bug fixes and improvements", TODO, TBD and placeholders are refused, and so is
  a file without bullets.

When a release changes what an agent session sees or may do (a new or changed
tool, a rule, a guard), end the file with a `## For agents` section: one or two
bullets in the agent's terms, tool names welcome. Sessions already running are
told them once, at their next prompt after the update; people never see them in
Kehikot. A release with nothing new for agents has no section.
