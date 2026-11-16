# dsh-session-rehome

Move one DeepSeek Harness conversation **into another workspace, in place**: history, title, archive
state and the **session id** all stay the same. Nothing is copied and no new conversation is created.

Entry point: the **…** menu on a conversation row in the sidebar → **Move to another workspace…** →
pick a target → move.

> DSH cannot do this by itself: there is no API to change a session's workspace, because membership
> is derived from the session log's header `cwd`. This plugin performs the real relocation — move the
> log, rewrite the header `cwd`, update the workspace registry. See [How it works](#how-it-works).

中文说明见 [README.zh.md](README.zh.md) · one-line install: `dsh plugin --profile <profile> add dsh-session-rehome`

## Install

```bash
dsh plugin --profile <profile> add dsh-session-rehome
```

In DSH Desktop you can also use **Plugins → Add plugin** and enter `dsh-session-rehome` (or this
repo's local path).

Restart DSH once afterwards — the host half is a Node module and is not loaded until then — then
refresh the page so the menu item appears.

## Use

1. Hover a conversation in the sidebar and click **…**;
2. Click **Move to another workspace…** — the dialog lists only the *other* workspaces;
3. Pick one and confirm. The sidebar updates and the conversation appears under the target;
4. Open it and keep chatting: its `cwd`, file-sandbox root and tool working directory are now the
   new folder.

If you moved the conversation that is currently open on screen, **refresh the page once** before
opening it again — the browser still holds the old copy.

## What it refuses

Each of these returns a stable error code and touches no bytes:

| Situation | Code |
|---|---|
| The conversation is mid-turn (agent status `running`) | `session-running` |
| Never written to disk (no message sent yet) | `session-not-stored` |
| A subagent session (`origin: subagent` or `delegationDepth > 0`) | `subagent-session` |
| The same id appears in more than one project directory | `duplicate-log` |
| The session directory holds several generations, or unknown extra files | `multiple-generations` / `session-dir-has-extras` |
| The target workspace directory does not exist | `workspace-missing` |
| Buffered writes could not be flushed | `flush-failed` |

**A conversation that is mid-turn is refused rather than moved.** That turn can append at any
moment, and relocating the directory inside that window makes it write to a path that no longer
exists. This is the central trade-off against plugins that move running conversations.

## How it works

In DSH, which workspace a session belongs to is **computed** from the session log's header `cwd`
(`Workspace.candidateMatches` compares `realpath(header.cwd)` with the workspace path), and the log's
directory name is derived from the same string (`projectKey`). A relocation therefore has to do all
three of these:

1. move the log from `<sessions root>/<projectKey(old cwd)>/<session id>/` to
   `<sessions root>/<projectKey(new cwd)>/<session id>/`;
2. rewrite the header `cwd` in the first frame — **only that frame is re-compressed; every event
   frame after it stays byte-for-byte identical**;
3. `attachSession` on the target workspace and `detachSession` on the source.

If the session is currently resident (`ctx.sessions` has it, or it holds an open write handle), the
in-memory `header.cwd` and the write handle's header are updated too, so later writes land in the new
place.

Three orderings cannot be swapped — each was found the hard way:

- **Re-index the registry's header cache before attaching.** The registry indexes headers once at
  startup; without a re-index `attachSession` validates against the cached old `cwd` and refuses with
  `its cwd resolves to <old path>`.
- **Detach before attaching.** Otherwise the id is accounted by both workspaces at once and
  `validateStoredState` throws `accounted by both` on the next start — **the whole app fails to boot**.
- **Flush the write handle before moving files.** A buffered batch that lands after the move follows
  the deleted inode and is lost.

### Publishing is a three-step rename, not a single `rename`

1. write the new log into the target directory as `<generation>.relocate-tmp` — not a canonical
   generation name, so the backend cannot see it yet;
2. rename the source log to `<generation>.relocate-old`;
3. rename the temp file to its canonical name, then delete the old one and remove the empty directory.

That guarantees **there are never two canonical-name logs at the same time** (the backend aborts the
entire listing when it finds one id in two project directories).

### If a move is interrupted

Should the process die between steps 2 and 3, both files still exist:

- new data: `<target dir>/session.v4.jsonl.zstd.relocate-tmp`
- old data: `<source dir>/session.v4.jsonl.zstd.relocate-old`

Renaming each back to `session.v4.jsonl.zstd` recovers it. The plugin log records both paths.

## Log and endpoints

Plugin log: `$DSH_HOME/logs/session-rehome.log` (default `~/.dsh/logs/session-rehome.log`) — one line
per event: client-bundle state at mount, source/target paths and byte counts per move, the error code
of every refusal.

Same-origin, owner only. Failures are always `{"ok": false, "code": "...", "message": "..."}`.

| Endpoint | Method | Body | Result |
|---|---|---|---|
| `/session-rehome/workspaces` | GET | — | `{ ok, workspaces: [{ id, title, path, sessionIds }] }` |
| `/session-rehome/move` | POST | `{ sessionId, workspaceId }` | `{ ok, sessionId, from, to, workspace, storage, memory, ... }` |

## Tests

```bash
npm test    # node test/rehome.test.mjs
```

20 assertions, all against synthetic data — no real session is touched: frame structure, byte
preservation, the header's closed key set and key order, the `projectKey(cwd)` ↔ directory-name
invariant, and every refusal condition.

## Known limits

- **A conversation that is mid-turn cannot be moved** — wait for it to finish.
- A session belongs to exactly one workspace; that is DSH's model, not the plugin's choice.
- It uses a few package-private entry points (`sessionPersistence.tracker.writers`,
  `workspaceRegistry.headers`, `replaceHeaderIndex`, the write handle's `header` slot). Each is
  feature-detected: when it is missing the plugin degrades or aborts instead of half-finishing.
  These may change between DSH rc releases.
- **Verified against DSH 0.2.1-rc.5** (Windows / Node 24). Other versions are untested.
- Requires Node ≥ 22.15 for built-in zstd.

## Related plugins

Two mature implementations already exist; pick by need:

- [`dsh-session-relocate`](https://www.npmjs.com/package/dsh-session-relocate) — also moves
  **running** conversations, plus drag-and-drop, batch moves and subagent cascades. The most complete.
- [`dsh-move-to-workspace`](https://www.npmjs.com/package/dsh-move-to-workspace) — copies the
  transcript into a new session and archives the original (**the session id changes**).

`dsh-session-rehome` is deliberately the minimal one: a real move, same session id, running
conversations refused, small enough to audit line by line.

## License

MIT
