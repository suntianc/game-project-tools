# Game Project Tools

MCP tools used in a 2D game project.

## LDtk MCP

[Source and setup](tools/ldtk-mcp/README.md) · [Server](tools/ldtk-mcp/ldtk-mcp.mjs)

A dependency-free Node.js bridge for LDtk 1.5.3 on macOS. It launches an isolated
editor instance over a private Chrome DevTools Protocol pipe, opens projects,
switches levels, captures screenshots, and runs LDtk's native auto-layer rules
before saving.

Requires Node.js 22+, LDtk 1.5.3, and a macOS desktop session.

```sh
node tools/ldtk-mcp/ldtk-mcp.mjs
```

Register that command in an MCP client, then use `launch` and `open_project` with
your own `.ldtk` file. No game content or private MCP client configuration is
included. The original game's integration-test fixtures are not bundled.

## Related open-source tools

- [Krita MCP](https://github.com/SanSaSane/krita-mcp): image editing and layer-based asset preparation.
- [TwelveTake REAPER MCP](https://github.com/TwelveTake-Studios/reaper-mcp): music production and REAPER control.

## Provenance

The LDtk server is copied unchanged from `tools/ldtk-mcp/ldtk-mcp.mjs` in the local
game project. Its setup documentation uses portable example paths. Related
tools retain their respective upstream authorship and licenses.
