# ldtk-mcp

stdio MCP server that drives a **privately launched** LDtk 1.5.3 window so agents can open a project, switch world/level views, screenshot, and let LDtk itself recompute auto-layer tiles and save — without computer-use or attaching to the user’s editor.

Requires **Node 22+** (global `WebSocket` is unused; CDP talks over pipes). **No npm/pip packages.**

## Principle

LDtk 1.5.3 is Electron 24 / Chromium 112. It has no script API. This bridge starts **its own** LDtk process with:

- `--user-data-dir=<temp>` so settings/logs/caches never touch `~/Library/Application Support/LDtk`
- `--remote-debugging-pipe` (Chrome DevTools Protocol on inherited **fd 3 / fd 4**, ASCIIZ JSON). **No TCP port is opened.**

Haxe compiles `renderer.js` as an IIFE, so `App` / `page_Editor` are not on `window`. Heaps’ main loop is `requestAnimationFrame` (`hxd.System.browserLoop`); Chrome **does not fire rAF** while the LDtk window is occluded, minimized, or on another Space — so a breakpoint on `Boot.update` never hits in the background (the round-1 failure mode).

After attach the bridge therefore:

1. Breaks on **event-driven** IIFE methods (`window.onresize` / `onfocus`, bound in `App`’s constructor) and dispatches those events — no frame, no OS focus steal.
2. `Debugger.evaluateOnCallFrame` stores constructors on `window.__ldtkMcp`.
3. Replaces the Heaps loop with a `setTimeout` pump so `dn.Process` / save / auto-layers keep running while the window stays in the background.

Further calls use the 1.5.3 editor entry points (MIT, [deepnight/ldtk v1.5.3](https://github.com/deepnight/ldtk/tree/v1.5.3)):

| Action | Symbol | Source |
| --- | --- | --- |
| Open project | `App.loadProject` | `src/electron.renderer/App.hx` |
| List / select level | `page.Editor.selectLevel` | `src/electron.renderer/page/Editor.hx` |
| World view | `page.Editor.setWorldMode` | same |
| Recompute auto tiles | `data.inst.LayerInstance.applyAllRules` | `src/electron.renderer/data/inst/LayerInstance.hx` |
| Invalidate external-level serialization | `page.Editor.invalidateLevelCache` | `src/electron.renderer/page/Editor.hx` |
| Save (also runs AutoLayers + write) | `page.Editor.onSave` → `ui.ProjectSaver` | `Editor.hx`, `src/electron.renderer/ui/ProjectSaver.hx` |

LDtk upgrades can break this: IIFE line numbers, compiled names (`page_Editor`, `ui_Modal`, `hxd_System`), `window.onresize` binding, or Electron dropping `--remote-debugging-pipe`.

## Run

```bash
# MCP stdio server
node tools/ldtk-mcp/ldtk-mcp.mjs

# Original game-project integration check (requires fixtures not included here):
# copy data/ldtk → .local/ldtk-mcp-evidence/project-copy/,
# then open → world screenshot → r04 screenshot → apply rules + save → quit, ×3
# plus a 4th run with the LDtk window minimized (no foreground required).
# Each run starts with a null/empty R04 cache and compares the rebuilt tiles
# with the native GUI rule panel's seed/invalidation/onClose path.
node tools/ldtk-mcp/ldtk-mcp.mjs --selftest
```

Default binary: `/Applications/LDtk.app/Contents/MacOS/LDtk` (must be 1.5.3).

## Register

Codex (`~/.codex/config.toml` or project config):

```toml
[mcp_servers.ldtk]
command = "node"
args = ["/absolute/path/to/game-project-tools/tools/ldtk-mcp/ldtk-mcp.mjs"]
```

Claude Code:

```bash
claude mcp add ldtk -- node /absolute/path/to/game-project-tools/tools/ldtk-mcp/ldtk-mcp.mjs
```

## Tools

`launch`, `open_project`, `list_levels`, `select_level`, `world_view`, `screenshot`, `apply_rules_and_save`, `get_errors`, `quit` (alias `close`).

`screenshot.target`: `window` | `level` | `world`. Writes a PNG path; set `include_content` to also return image bytes.

`apply_rules_and_save` returns both native `generatedTiles` per applied layer and the actual on-disk `autoLayerTiles` counts. It rejects a save whose counts differ.

The `--selftest` and `--mcp-focus-probe` modes require the original game project's
`data/ldtk`, R04 level, and referenced art assets. Those fixtures are not included
in this tools repository. Normal MCP operation accepts your own LDtk project
through `open_project`.

## Null/empty cache recovery (2026-10-07)

An imported R04 IntGrid can have `autoLayerTiles: null` or `[]`. Calling `LayerInstance.applyAllRules()` alone rebuilds the native layer cache, but LDtk 1.5.3 can retain the level's `_cachedJson`; ProjectSaver then writes the old empty array. The bridge clears the native tile cache, runs LDtk's rules, and calls the editor's `invalidateLevelCache(level)` before saving. This uses the same serialization invalidation as native GUI changes and does not implement a second rule engine.

The self-test alternates null and empty input caches, requires nonzero written R04 tiles, then triggers the native GUI rule panel's seed button and invalidation/close path. A second bridge rebuild must match every GUI-generated tile at the same seed, including a minimized-window run. Every operation checks caller focus and only the bridge's own process is closed. A launch can still briefly activate LDtk as described below; later operations must preserve focus.

## Isolation

- Never attaches to, or quits an LDtk the bridge did not spawn.
- `quit`/`close` only kill the child and its `--user-data-dir`.
- Record foreign `MacOS/LDtk` PIDs at `launch`; they must still be alive after `quit`.
- Does **not** leave LDtk in the foreground. `launch` snapshots `path to frontmost application` and restores it with `open -a` (no Accessibility). Other tools never call `Target.activateTarget` / `Page.bringToFront`. LDtk’s own `BrowserWindow.show()` on `ready-to-show` can flash the new window; the bridge restores focus immediately after attach. Screenshots use `Page.captureScreenshot({ fromSurface: true })` on the unfocused window.

## Security

**The debugging protocol is arbitrary code execution inside LDtk** (file system, project JSON, renderer). Only the child started by this server is exposed, and only over inherited pipes — not `127.0.0.1` and not the LAN. Do not point this server at a user-owned LDtk, and do not pass `--remote-debugging-port` on a shared machine.

## Limits

- macOS + LDtk 1.5.3 only (tested Electron 24.8.8).
- Needs a real display (Heaps/WebGL). Not headless. Does **not** need the LDtk window to be visible or focused; the loop is pumped with `setTimeout`.
- Cannot use Electron `showInactive()`: that API lives in the main process and LDtk 1.5.3 only exposes `showWindow`/`hideWindow`/`minimize` IPC. Hiding/minimizing would blank screenshots, so the window stays shown in the background.
- Launch flash: LDtk main calls `mainWindow.show()` after `loadFile`; that activates. Restoring the previous app typically takes a few hundred ms (measured in `--selftest` as `focus.steps.launch.flashMs`). Later tools must not change the frontmost app.
- Tries CDP `Page.setWebLifecycleState` / `Emulation.setFocusEmulationEnabled` as extras; the event-driven leak does not rely on them.
- First open may flash Changelog / backup-suggestion modals; the bridge dismisses them.
- Leak failures include page `visibilityState`, `document.hidden`, breakpoint locations, and script URL — not a bare timeout.
- `apply_rules_and_save` is only as correct as LDtk’s own rule engine (that is the point).
- Does not replace computer-use for drawing tiles by hand.

## Why not the other options

- **macOS System Events / screencapture**: needs Accessibility permission (not requested here), and is the slow path Codex already has.
- **Reimplement auto-layer rules in Node**: LDtk’s matcher, stamps, break-on-match, and export filtering are large and version-sensitive; a parallel engine would drift from `autoLayerTiles` LDtk writes.
