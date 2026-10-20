#!/usr/bin/env node
/**
 * LDtk 1.5.3 MCP bridge.
 *
 * Drives a privately launched LDtk instance through Chrome DevTools Protocol
 * over --remote-debugging-pipe (fd 3/4, ASCIIZ JSON). No network port is opened.
 *
 * LDtk renderer.js is a Haxe IIFE, so App / page_Editor are not on window.
 * The bridge leaks those closures once via Debugger.evaluateOnCallFrame on
 * App.onAppResize (event-driven; Heaps rAF does not run while occluded),
 * then pumps dn.Process with setTimeout and calls 1.5.3 editor entry points.
 * Launch may flash LDtk for a few hundred ms; the previous frontmost app is
 * restored and later tools must not activate LDtk.
 *
 * Security: this protocol is equivalent to executing arbitrary JavaScript
 * inside LDtk. Only a child instance started by this process is ever touched.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const DEFAULT_LDTK = "/Applications/LDtk.app/Contents/MacOS/LDtk";
const EXPECTED_APP_VERSION = "1.5.3";
const LEAK_GLOBAL = "__ldtkMcp";
const MCP_PROTOCOL = "2024-11-05";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function log(...args) {
  process.stderr.write("[ldtk-mcp] " + args.map(String).join(" ") + "\n");
}

function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function listProcesses() {
  try {
    return execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" })
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        const sp = trimmed.search(/\s/);
        if (sp < 0) {
          return null;
        }
        const pid = Number(trimmed.slice(0, sp));
        const args = trimmed.slice(sp).trim();
        if (!Number.isFinite(pid) || !args) {
          return null;
        }
        return { pid, args };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

const LDTK_MAIN = "/Applications/LDtk.app/Contents/MacOS/LDtk";

function listMainLdtkPids() {
  return listProcesses()
    .filter((p) => p.args === LDTK_MAIN || p.args.startsWith(LDTK_MAIN + " "))
    .map((p) => p.pid);
}

function listBridgeStragglers() {
  return listProcesses().filter((p) => {
    const isLdtk =
      p.args === LDTK_MAIN ||
      p.args.startsWith(LDTK_MAIN + " ") ||
      p.args.includes("/Applications/LDtk.app/Contents/Frameworks/LDtk Helper");
    if (!isLdtk || !p.args.includes("--user-data-dir=")) {
      return false;
    }
    return p.args.includes("ldtk-mcp-ud-") || p.args.includes("ldtk-mcp-evidence");
  });
}

function frontmostAppHfs() {
  try {
    return execFileSync("osascript", ["-e", "path to frontmost application as text"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

function hfsToPosixApp(hfs) {
  if (!hfs) {
    return "";
  }
  const trimmed = String(hfs).replace(/:$/, "");
  const parts = trimmed.split(":");
  if (parts.length < 2) {
    return trimmed;
  }
  return "/" + parts.slice(1).join("/");
}

function sameFrontApp(a, b) {
  return hfsToPosixApp(a).toLowerCase() === hfsToPosixApp(b).toLowerCase();
}

function isLdtkFront(hfs) {
  return /\/LDtk\.app$/i.test(hfsToPosixApp(hfs));
}

function restoreFrontApp(hfs) {
  const posix = hfsToPosixApp(hfs);
  if (!posix) {
    return;
  }
  try {
    execFileSync("open", ["-a", posix], { timeout: 5000 });
  } catch (err) {
    log("restoreFrontApp", err.message);
  }
}

function parseLdtkJson(text) {
  const i = text.indexOf("{");
  if (i < 0) {
    throw new Error("no JSON object in file");
  }
  return JSON.parse(text.slice(i));
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function collectProjectFiles(projectPath) {
  const abs = path.resolve(projectPath);
  const files = [abs];
  const stem = path.basename(abs, path.extname(abs));
  const side = path.join(path.dirname(abs), stem);
  if (fs.existsSync(side) && fs.statSync(side).isDirectory()) {
    for (const name of fs.readdirSync(side)) {
      if (name === "backups") {
        continue;
      }
      const p = path.join(side, name);
      if (fs.statSync(p).isFile() && (name.endsWith(".ldtkl") || name.endsWith(".ldtk") || name.endsWith(".json"))) {
        files.push(p);
      }
    }
  }
  return files;
}

function hashProject(projectPath) {
  const out = {};
  for (const f of collectProjectFiles(projectPath)) {
    out[f] = sha256File(f);
  }
  return out;
}

function inspectAutoLayerTiles(projectPath) {
  const abs = path.resolve(projectPath);
  const root = parseLdtkJson(fs.readFileSync(abs, "utf8"));
  const defs = (root.defs && root.defs.layers) || [];
  const ruleLayerIds = new Set(
    defs
      .filter((l) => (l.autoRuleGroups || []).length > 0)
      .map((l) => l.identifier),
  );
  const layers = [];
  function walkLevel(level, file) {
    const instances = level.layerInstances || [];
    for (const li of instances) {
      const id = li.__identifier;
      const tiles = li.autoLayerTiles || [];
      const hasRules = ruleLayerIds.has(id);
      if (hasRules || tiles.length > 0) {
        layers.push({
          file: path.basename(file),
          level: level.identifier,
          layer: id,
          type: li.__type,
          autoLayerTiles: tiles.length,
          hasRules,
        });
      }
    }
  }
  if (root.externalLevels) {
    const stem = path.basename(abs, path.extname(abs));
    const side = path.join(path.dirname(abs), stem);
    if (fs.existsSync(side)) {
      for (const name of fs.readdirSync(side)) {
        if (!name.endsWith(".ldtkl")) {
          continue;
        }
        const fp = path.join(side, name);
        const level = parseLdtkJson(fs.readFileSync(fp, "utf8"));
        walkLevel(level, fp);
      }
    }
  } else {
    for (const level of root.levels || []) {
      walkLevel(level, abs);
    }
  }
  return {
    jsonVersion: root.jsonVersion || null,
    appVersion: root.__header__ && root.__header__.appVersion,
    iid: root.iid,
    layers,
  };
}

class CdpPipe {
  constructor(writeStream, readStream) {
    this.writeStream = writeStream;
    this.readStream = readStream;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.readStream.on("data", (chunk) => this._onData(chunk));
    this.readStream.on("end", () => this._failAll(new Error("CDP pipe ended")));
    this.readStream.on("error", (err) => this._failAll(err));
    this.writeStream.on("error", (err) => this._failAll(err));
  }

  on(method, fn) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, []);
    }
    this.listeners.get(method).push(fn);
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const z = this.buf.indexOf(0);
      if (z < 0) {
        break;
      }
      const text = this.buf.subarray(0, z).toString("utf8");
      this.buf = this.buf.subarray(z + 1);
      if (!text) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(text);
      } catch (err) {
        log("bad CDP JSON", err.message);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      const fns = this.listeners.get(msg.method) || [];
      for (const fn of fns) {
        try {
          fn(msg.params || {}, msg);
        } catch (err) {
          log("event handler", msg.method, err.message);
        }
      }
    }
  }

  _failAll(err) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 30000) {
    if (this.closed) {
      return Promise.reject(new Error("CDP pipe closed"));
    }
    const id = ++this.nextId;
    const msg = { id, method, params };
    if (sessionId) {
      msg.sessionId = sessionId;
    }
    const payload = JSON.stringify(msg) + "\0";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP timeout: " + method));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.writeStream.write(payload);
    });
  }

  close() {
    this.closed = true;
  }
}

class LdtkSession {
  constructor() {
    this.child = null;
    this.cdp = null;
    this.sessionId = null;
    this.userDataDir = null;
    this.owned = false;
    this.version = null;
    this.consoleErrors = [];
    this.foreignMainPids = [];
    this.projectPath = null;
    this.leaked = false;
    this.callerFrontmost = null;
    this.focusFlashMs = 0;
    this.focusStolen = false;
    this._focusTimer = null;
  }

  async launch({ ldtkPath = DEFAULT_LDTK, userDataDir = null, occlude = false } = {}) {
    this.occludeOnLaunch = !!occlude;
    if (this.child && this.child.exitCode == null) {
      return this.status();
    }
    if (!fs.existsSync(ldtkPath)) {
      throw new Error("LDtk binary not found: " + ldtkPath);
    }
    this.foreignMainPids = listMainLdtkPids();
    this.callerFrontmost = frontmostAppHfs();
    this.focusFlashMs = 0;
    this.focusStolen = false;
    this._stolenAt = null;
    this.userDataDir = userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "ldtk-mcp-ud-"));
    fs.mkdirSync(this.userDataDir, { recursive: true });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      ldtkPath,
      [
        "--remote-debugging-pipe",
        "--user-data-dir=" + this.userDataDir,
        "--no-first-run",
        "--disable-crash-reporter",
      ],
      {
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
        env,
      },
    );
    this.child = child;
    this.owned = true;
    child.stderr.on("data", (d) => {
      const s = d.toString();
      if (s.trim()) {
        log("ldtk-stderr", s.trim().slice(0, 400));
      }
    });
    child.on("exit", (code, signal) => {
      log("ldtk exit", code, signal);
      this.owned = this.child === child ? false : this.owned;
    });
    if (!child.stdio[3] || !child.stdio[4]) {
      throw new Error("failed to create CDP pipes on fd 3/4");
    }
    this.cdp = new CdpPipe(child.stdio[3], child.stdio[4]);
    try {
      return await this._connectAfterSpawn();
    } catch (err) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await this._waitChildExit(2000);
      if (this.child && this.child.exitCode == null) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
      this._cleanupUserData();
      this.owned = false;
      throw err;
    }
  }

  async _connectAfterSpawn() {
    this.cdp.on("Runtime.consoleAPICalled", (params) => {
      const type = params.type;
      if (type === "error" || type === "warning") {
        const text = (params.args || []).map((a) => a.value || a.description || "").join(" ");
        this.consoleErrors.push({ type, text, ts: nowMs() });
        if (this.consoleErrors.length > 200) {
          this.consoleErrors.shift();
        }
      }
    });
    this.cdp.on("Log.entryAdded", (params) => {
      const e = params.entry || {};
      if (e.level === "error" || e.level === "warning") {
        this.consoleErrors.push({ type: e.level, text: e.text || "", ts: nowMs() });
      }
    });
    const ver = await this._waitFor(() => this.cdp.send("Browser.getVersion"), {
      timeout: 20000,
      label: "Browser.getVersion",
    });
    this.version = ver;
    const page = await this._waitFor(
      async () => {
        const { targetInfos } = await this.cdp.send("Target.getTargets");
        return (targetInfos || []).find(
          (t) => t.type === "page" && t.url && t.url.includes("app.html"),
        );
      },
      { timeout: 30000, label: "app.html target" },
    );
    const attached = await this.cdp.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    await this.cdp.send("Runtime.enable", {}, this.sessionId);
    try {
      await this.cdp.send("Log.enable", {}, this.sessionId);
    } catch {
      /* optional */
    }
    try {
      await this.cdp.send("Page.enable", {}, this.sessionId);
    } catch {
      /* optional */
    }
    try {
      await this.cdp.send("Page.setWebLifecycleState", { state: "active" }, this.sessionId);
    } catch {
      /* Electron 24 may not implement this */
    }
    try {
      await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, this.sessionId);
    } catch {
      /* optional */
    }
    await this._restoreCallerFocus({ waitMs: 400 });
    await this._waitForAppConstructor();
    if (this.occludeOnLaunch) {
      await this._occludeWindow();
    }
    await this._leakInternals();
    await this._restoreCallerFocus({ waitMs: 800 });
    await this._waitFor(
      async () => {
        const r = await this.eval(`!!(${LEAK_GLOBAL} && ${LEAK_GLOBAL}.App && ${LEAK_GLOBAL}.App.ME)`);
        return r === true;
      },
      { timeout: 20000, label: "App.ME" },
    );
    await this.eval(`(() => {
      const A = window.${LEAK_GLOBAL}.App;
      try { A.ME.settings.v.openLastProject = false; } catch (e) {}
      try { A.ME.settings.v.startFullScreen = false; } catch (e) {}
      try { A.ME.settings.v.autoInstallUpdates = false; } catch (e) {}
      try { A.ME.settings.save(); } catch (e) {}
      try { window.${LEAK_GLOBAL}.ui_Modal.closeAll(); } catch (e) {}
      return true;
    })()`);
    return this.status();
  }

  async _pageDiagnostics() {
    try {
      return await this.eval(`({
        readyState: document.readyState,
        hidden: document.hidden,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        title: document.title,
        onresize: typeof window.onresize,
        onfocus: typeof window.onfocus,
        pageHtmlLen: (document.getElementById("page") && document.getElementById("page").innerHTML.length) || 0,
        bodyClass: document.body ? document.body.className : null
      })`);
    } catch (err) {
      return { diagError: String(err.message || err) };
    }
  }

  async _waitForAppConstructor() {
    try {
      await this._waitFor(
        async () => (await this.eval(`typeof window.onresize`)) === "function",
        { timeout: 15000, interval: 200, label: "window.onresize (App constructed)" },
      );
    } catch (err) {
      const diag = await this._pageDiagnostics();
      throw new Error(
        "App constructor did not bind window.onresize (Heaps/WebGL may still be starting). " +
          err.message +
          " diag=" +
          JSON.stringify(diag),
      );
    }
  }

  async _occludeWindow() {
    let via = "none";
    try {
      const targetId = await this._appTargetId();
      const win = await this.cdp.send("Browser.getWindowForTarget", { targetId });
      await this.cdp.send("Browser.setWindowBounds", {
        windowId: win.windowId,
        bounds: { windowState: "minimized" },
      });
      via = "Browser.setWindowBounds:minimized";
    } catch (err) {
      log("Browser window bounds unavailable:", err.message);
    }
    try {
      if (this.callerFrontmost) {
        restoreFrontApp(this.callerFrontmost);
        via = via === "none" ? "restore caller" : via + "+restore caller";
      }
    } catch (err) {
      log("occlude restore:", err.message);
    }
    try {
      await this.eval(`(() => { try { window.blur(); } catch (e) {} return true; })()`);
    } catch {
      /* ignore */
    }
    const vis = await this._pageDiagnostics();
    vis.occludeVia = via;
    log("occlude", JSON.stringify(vis));
    return vis;
  }

  _noteFrontmost() {
    const cur = frontmostAppHfs();
    if (isLdtkFront(cur) && !sameFrontApp(cur, this.callerFrontmost)) {
      this.focusStolen = true;
      if (this._stolenAt == null) {
        this._stolenAt = nowMs();
      }
    } else if (
      this._stolenAt != null &&
      sameFrontApp(cur, this.callerFrontmost) &&
      this.focusFlashMs === 0
    ) {
      this.focusFlashMs = Math.max(1, nowMs() - this._stolenAt);
    }
    return cur;
  }

  async _restoreCallerFocus({ waitMs = 600 } = {}) {
    if (!this.callerFrontmost) {
      return { ok: true, skipped: true };
    }
    const deadline = nowMs() + waitMs;
    let tries = 0;
    while (nowMs() < deadline) {
      const cur = this._noteFrontmost();
      if (sameFrontApp(cur, this.callerFrontmost)) {
        return { ok: true, tries, frontmost: cur, flashMs: this.focusFlashMs };
      }
      restoreFrontApp(this.callerFrontmost);
      tries += 1;
      await sleep(40);
    }
    const cur = this._noteFrontmost();
    const ok = sameFrontApp(cur, this.callerFrontmost);
    if (!ok) {
      log("focus still", cur, "want", this.callerFrontmost);
    }
    return { ok, tries, frontmost: cur, flashMs: this.focusFlashMs };
  }

  async _leakInternals() {
    const sid = this.sessionId;
    const diagBefore = await this._pageDiagnostics();
    const meta = {
      diagBefore,
      scriptId: null,
      scriptUrl: null,
      lines: {},
      breakpoints: [],
    };
    const pausedWaiters = [];
    const onPaused = (params) => {
      for (const w of pausedWaiters.splice(0)) {
        w(params);
      }
    };
    this.cdp.on("Debugger.paused", onPaused);
    const scripts = [];
    this.cdp.on("Debugger.scriptParsed", (params) => {
      if (params.url && params.url.includes("renderer.js")) {
        scripts.push(params);
      }
    });
    await this.cdp.send("Debugger.enable", {}, sid);
    await sleep(250);
    const script = scripts[0];
    if (script) {
      meta.scriptId = script.scriptId;
      meta.scriptUrl = script.url;
    }
    const wanted = {
      onAppResize: ",onAppResize: function(ev)",
      onWindowFocus: ",onWindowFocus: function(ev)",
      updateAll: "dn_Process.updateAll",
    };
    if (meta.scriptId) {
      try {
        const src = await this.cdp.send("Debugger.getScriptSource", { scriptId: meta.scriptId }, sid);
        const lines = String(src.scriptSource || "").split("\n");
        for (const [name, needle] of Object.entries(wanted)) {
          const found = lines.findIndex((l) => l.includes(needle));
          if (found >= 0) {
            meta.lines[name] = found;
          }
        }
      } catch (err) {
        meta.scriptSourceError = err.message;
      }
    }
    if (meta.lines.onAppResize == null) {
      meta.lines.onAppResize = 3812;
    }
    if (meta.lines.onWindowFocus == null) {
      meta.lines.onWindowFocus = 3785;
    }
    if (meta.lines.updateAll == null) {
      meta.lines.updateAll = 5188;
    }
    const bpIds = [];
    for (const [name, lineNumber] of Object.entries(meta.lines)) {
      try {
        const bp = await this.cdp.send(
          "Debugger.setBreakpointByUrl",
          { lineNumber, urlRegex: "renderer\\.js" },
          sid,
        );
        bpIds.push(bp.breakpointId);
        meta.breakpoints.push({
          name,
          lineNumber,
          locations: bp.locations || [],
          breakpointId: bp.breakpointId,
        });
      } catch (err) {
        meta.breakpoints.push({ name, lineNumber, error: err.message });
      }
    }

    const waitPause = (ms) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("pause-timeout")), ms);
        pausedWaiters.push((params) => {
          clearTimeout(t);
          resolve(params);
        });
      });

    const pokeIife = () => {
      this.cdp
        .send(
          "Runtime.evaluate",
          {
            expression: `(() => {
              try { window.dispatchEvent(new Event("resize")); } catch (e) {}
              try {
                if (typeof window.onresize === "function") window.onresize({ target: window });
              } catch (e) {}
              try {
                if (typeof window.onfocus === "function") window.onfocus({ target: window });
              } catch (e) {}
              return true;
            })()`,
            returnByValue: true,
          },
          sid,
        )
        .catch(() => {});
    };

    pokeIife();
    let paused = null;
    try {
      paused = await waitPause(4000);
    } catch {
      try {
        await this.cdp.send(
          "Page.startScreencast",
          { format: "jpeg", quality: 10, everyNthFrame: 1 },
          sid,
        );
        meta.screencast = true;
      } catch (err) {
        meta.screencastError = err.message;
      }
      pokeIife();
      try {
        paused = await waitPause(6000);
      } catch {
        const diagAfter = await this._pageDiagnostics();
        throw new Error(
          "timed out leaking LDtk IIFE (no Debugger.paused). " +
            "Heaps main loop uses requestAnimationFrame and does not run while the window is occluded; " +
            "the bridge therefore breaks on window.onresize/onfocus (event-driven, not per-frame). " +
            "meta=" +
            JSON.stringify({ ...meta, diagAfter }),
        );
      }
    }

    const frame = (paused.callFrames || [])[0];
    if (!frame) {
      throw new Error("Debugger.paused without callFrames meta=" + JSON.stringify(meta));
    }
    meta.pausedFunction = frame.functionName;
    meta.pausedLine = frame.lineNumber;
    const leakExpr = `(() => {
      window.${LEAK_GLOBAL} = {
        App: App,
        page_Editor: page_Editor,
        ui_Modal: ui_Modal,
        Const: Const,
        ui_ProjectSaver: ui_ProjectSaver,
        ui_modal_Progress: typeof ui_modal_Progress !== "undefined" ? ui_modal_Progress : null,
        ui_modal_panel_EditAllAutoLayerRules: ui_modal_panel_EditAllAutoLayerRules,
        Boot: Boot,
        hxd_System: typeof hxd_System !== "undefined" ? hxd_System : null
      };
      return {
        leaked: true,
        hasAppME: !!(App && App.ME),
        version: Const && Const.RAW_APP_VERSION ? Const.RAW_APP_VERSION : null,
        via: ${JSON.stringify("callFrame")}
      };
    })()`;
    const leaked = await this.cdp.send(
      "Debugger.evaluateOnCallFrame",
      { callFrameId: frame.callFrameId, expression: leakExpr, returnByValue: true },
      sid,
    );
    try {
      await this.cdp.send("Debugger.resume", {}, sid);
    } catch {
      /* ignore */
    }
    for (const id of bpIds) {
      if (!id) {
        continue;
      }
      try {
        await this.cdp.send("Debugger.removeBreakpoint", { breakpointId: id }, sid);
      } catch {
        /* ignore */
      }
    }
    try {
      await this.cdp.send("Debugger.disable", {}, sid);
    } catch {
      /* ignore */
    }
    try {
      await this.cdp.send("Page.stopScreencast", {}, sid);
    } catch {
      /* ignore */
    }
    const value = leaked && leaked.result && leaked.result.value;
    if (!value || !value.leaked) {
      throw new Error("failed to leak LDtk internals: " + JSON.stringify({ leaked, meta }));
    }
    this.leaked = true;
    log("leaked via", meta.pausedFunction, "line", meta.pausedLine);
    await this._ensureLoopWhileHidden();
    return value;
  }

  async _ensureLoopWhileHidden() {
    const r = await this.eval(`(() => {
      const L = window.${LEAK_GLOBAL};
      const sys = L.hxd_System;
      if (!sys) return { patched: false, reason: "no hxd_System" };
      if (window.__ldtkMcpLoopPatched) return { patched: true, already: true };
      const orig = sys.loopFunc;
      let last = 0;
      const wrapped = function() {
        const now = Date.now();
        if (now - last < 12) return;
        last = now;
        if (orig) orig();
      };
      sys.loopFunc = wrapped;
      sys.fpsLimit = 30;
      window.__ldtkMcpLoopPatched = true;
      const tick = function() {
        window.setTimeout(tick, 33);
        wrapped();
      };
      tick();
      try { L.App.ME.requestCpu(true); } catch (e) {}
      return { patched: true };
    })()`);
    log("loop patch", JSON.stringify(r));
    return r;
  }

  async eval(expression, timeoutMs = 30000) {
    const r = await this.cdp.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      this.sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails) {
      const desc =
        (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
        r.exceptionDetails.text;
      throw new Error("Runtime.evaluate: " + desc);
    }
    return r.result ? r.result.value : undefined;
  }

  async _waitFor(fn, { timeout = 15000, interval = 150, label = "condition" } = {}) {
    const t0 = nowMs();
    let lastErr = null;
    while (nowMs() - t0 < timeout) {
      try {
        const v = await fn();
        if (v) {
          return v;
        }
      } catch (err) {
        lastErr = err;
      }
      await sleep(interval);
    }
    throw new Error("timeout waiting for " + label + (lastErr ? " (" + lastErr.message + ")" : ""));
  }

  async _waitIdle({ timeout = 60000 } = {}) {
    await this._waitFor(
      async () => {
        const r = await this.eval(`(() => {
          const L = window.${LEAK_GLOBAL};
          const progress = L.ui_modal_Progress && L.ui_modal_Progress.hasAny ? L.ui_modal_Progress.hasAny() : false;
          const saver = L.ui_ProjectSaver && L.ui_ProjectSaver.hasAny ? L.ui_ProjectSaver.hasAny() : false;
          return !progress && !saver;
        })()`);
        return r === true;
      },
      { timeout, interval: 200, label: "LDtk idle (no Progress/ProjectSaver)" },
    );
  }

  async _dismissModals() {
    await this.eval(`(() => {
      const L = window.${LEAK_GLOBAL};
      try { L.ui_Modal.closeAll(); } catch (e) {}
      return true;
    })()`);
  }

  async _requestCpu() {
    await this.eval(`(() => {
      try { window.${LEAK_GLOBAL}.App.ME.requestCpu(true); } catch (e) {}
      return true;
    })()`);
  }

  status() {
    const ua = (this.version && this.version.userAgent) || "";
    const m = /LDtk\/([0-9.]+)/.exec(ua);
    return {
      running: !!(this.child && this.child.exitCode == null),
      pid: this.child ? this.child.pid : null,
      userDataDir: this.userDataDir,
      transport: "remote-debugging-pipe",
      bind: "pipe:fd3/fd4",
      appVersion: m ? m[1] : this.version && this.version.product,
      userAgent: ua,
      expectedVersion: EXPECTED_APP_VERSION,
      versionOk: !m || m[1] === EXPECTED_APP_VERSION,
      leaked: this.leaked,
      projectPath: this.projectPath,
      foreignMainPids: this.foreignMainPids,
      callerFrontmost: this.callerFrontmost,
      frontmostNow: frontmostAppHfs(),
      focusFlashMs: this.focusFlashMs,
      focusStolen: this.focusStolen,
    };
  }

  async openProject(projectPath) {
    this._requireRunning();
    const abs = path.resolve(projectPath);
    if (!fs.existsSync(abs)) {
      throw new Error("project not found: " + abs);
    }
    await this._dismissModals();
    await this.eval(`(() => {
      window.${LEAK_GLOBAL}.openState = { done: false, ok: false, error: null };
      const App = window.${LEAK_GLOBAL}.App;
      App.ME.loadProject(${JSON.stringify(abs)}, null, function(p) {
        window.${LEAK_GLOBAL}.openState.done = true;
        window.${LEAK_GLOBAL}.openState.ok = p != null;
      });
      return true;
    })()`);
    await this._waitFor(
      async () => {
        const st = await this.eval(`window.${LEAK_GLOBAL}.openState`);
        if (st && st.done) {
          return st;
        }
        const hasEditor = await this.eval(`!!(window.${LEAK_GLOBAL}.page_Editor && window.${LEAK_GLOBAL}.page_Editor.ME)`);
        if (hasEditor) {
          return { done: true, ok: true, via: "editor" };
        }
        return null;
      },
      { timeout: 120000, interval: 250, label: "loadProject" },
    );
    await this._waitIdle({ timeout: 120000 });
    await sleep(400);
    await this._dismissModals();
    await sleep(200);
    await this._dismissModals();
    this.projectPath = abs;
    const info = await this.eval(`(() => {
      const L = window.${LEAK_GLOBAL};
      const ed = L.page_Editor.ME;
      if (!ed) return { ok: false, error: "editor not ready" };
      try { L.App.ME.settings.setProjectTrust(ed.project.iid, true); } catch (e) {}
      return {
        ok: true,
        iid: ed.project.iid,
        file: ed.project.filePath && ed.project.filePath.full,
        jsonVersion: ed.project.jsonVersion,
        worldMode: ed.worldMode,
        curLevel: ed.curLevel ? ed.curLevel.identifier : null
      };
    })()`);
    if (!info || !info.ok) {
      throw new Error((info && info.error) || "open_project failed");
    }
    await this._restoreCallerFocus({ waitMs: 400 });
    return info;
  }

  async listLevels() {
    this._requireEditor();
    const levels = await this.eval(`(() => {
      const ed = window.${LEAK_GLOBAL}.page_Editor.ME;
      const worlds = ed.project.worlds || [];
      const levels = [];
      for (let wi = 0; wi < worlds.length; wi++) {
        const w = worlds[wi];
        const arr = w.levels || [];
        for (let i = 0; i < arr.length; i++) {
          const l = arr[i];
          levels.push({
            identifier: l.identifier,
            uid: l.uid,
            iid: l.iid,
            worldIid: w.iid,
            worldIdentifier: w.identifier,
            pxWid: l.pxWid,
            pxHei: l.pxHei
          });
        }
      }
      return {
        current: ed.curLevel ? ed.curLevel.identifier : null,
        currentUid: ed.curLevelId,
        worldMode: !!ed.worldMode,
        levels
      };
    })()`);
    await this._restoreCallerFocus({ waitMs: 300 });
    return levels;
  }

  async selectLevel(id) {
    this._requireEditor();
    const r = await this.eval(`(() => {
      const ed = window.${LEAK_GLOBAL}.page_Editor.ME;
      const worlds = ed.project.worlds || [];
      const want = ${JSON.stringify(String(id))};
      let found = null;
      for (let wi = 0; wi < worlds.length; wi++) {
        const arr = worlds[wi].levels || [];
        for (let i = 0; i < arr.length; i++) {
          const l = arr[i];
          if (l.identifier === want || String(l.uid) === want || l.iid === want) {
            found = l;
            break;
          }
        }
      }
      if (!found) return { ok: false, error: "level not found: " + want };
      ed.selectLevel(found, true);
      try { ed.camera.fit(true); } catch (e) { try { ed.camera.fit(); } catch (e2) {} }
      return { ok: true, identifier: found.identifier, uid: found.uid, iid: found.iid, worldMode: ed.worldMode };
    })()`);
    if (!r || !r.ok) {
      throw new Error((r && r.error) || "select_level failed");
    }
    await this._requestCpu();
    await sleep(600);
    await this._restoreCallerFocus({ waitMs: 400 });
    return r;
  }

  async worldView() {
    this._requireEditor();
    const r = await this.eval(`(() => {
      const ed = window.${LEAK_GLOBAL}.page_Editor.ME;
      ed.setWorldMode(true);
      try { ed.camera.fit(true); } catch (e) { try { ed.camera.fit(); } catch (e2) {} }
      return { ok: true, worldMode: ed.worldMode, current: ed.curLevel ? ed.curLevel.identifier : null };
    })()`);
    await this._requestCpu();
    await sleep(800);
    await this._restoreCallerFocus({ waitMs: 400 });
    return r;
  }

  async screenshot({ target = "window", outPath, includeContent = false } = {}) {
    this._requireRunning();
    if (target === "world") {
      await this.worldView();
    } else if (target === "level") {
      this._requireEditor();
      await this.eval(`(() => {
        const ed = window.${LEAK_GLOBAL}.page_Editor.ME;
        if (ed.worldMode) ed.setWorldMode(false);
        try { ed.camera.fit(true); } catch (e) { try { ed.camera.fit(); } catch (e2) {} }
        return true;
      })()`);
      await this._requestCpu();
      await sleep(600);
    }
    await this._requestCpu();
    await sleep(250);
    let clip = undefined;
    if (target === "level" || target === "world") {
      const box = await this.eval(`(() => {
        const c = document.getElementById("webgl");
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
      })()`);
      if (box && box.width > 8 && box.height > 8) {
        clip = box;
      }
    }
    const params = { format: "png", fromSurface: true };
    if (clip) {
      params.clip = clip;
    }
    const shot = await this.cdp.send("Page.captureScreenshot", params, this.sessionId, 60000);
    const buf = Buffer.from(shot.data, "base64");
    const dest = outPath || path.join(os.tmpdir(), "ldtk-mcp-" + target + "-" + nowMs() + ".png");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    const result = {
      path: dest,
      bytes: buf.length,
      target,
      clippedToCanvas: !!clip,
    };
    if (includeContent) {
      result.pngBase64 = shot.data;
    }
    await this._restoreCallerFocus({ waitMs: 400 });
    return result;
  }

  async _appTargetId() {
    const { targetInfos } = await this.cdp.send("Target.getTargets");
    const page = (targetInfos || []).find((t) => t.type === "page" && t.url && t.url.includes("app.html"));
    return page ? page.targetId : undefined;
  }

  async applyRulesAndSave() {
    this._requireEditor();
    if (!this.projectPath) {
      throw new Error("no project opened");
    }
    const before = hashProject(this.projectPath);
    await this._waitIdle({ timeout: 30000 });
    await this._dismissModals();
    const started = await this.eval(`(() => {
      const L = window.${LEAK_GLOBAL};
      const ed = L.page_Editor.ME;
      window.${LEAK_GLOBAL}.saveState = { done: false, started: false, error: null, layers: [] };
      try {
        const worlds = ed.project.worlds || [];
        for (let wi = 0; wi < worlds.length; wi++) {
          const levels = worlds[wi].levels || [];
          for (let i = 0; i < levels.length; i++) {
            const level = levels[i];
            const layers = level.layerInstances || [];
            for (let j = 0; j < layers.length; j++) {
              const li = layers[j];
              if (typeof li.applyAllRules !== "function") {
                continue;
              }
              const def = typeof li.get_def === "function" ? li.get_def() : li.def;
              const isAuto = def && typeof def.isAutoLayer === "function" && def.isAutoLayer();
              if (isAuto) {
                li.clearAllAutoTilesCache();
                li.applyAllRules();
                // Layer caches and external-level JSON caches are independent in LDtk 1.5.3.
                // The editor invalidation used by GUI changes makes ProjectSaver serialize the new tiles.
                ed.invalidateLevelCache(level);
                window.${LEAK_GLOBAL}.saveState.layers.push({
                  level: level.identifier,
                  layer: def.identifier,
                  generatedTiles: li.toJson().autoLayerTiles.length
                });
              }
            }
          }
        }
        ed.needSaving = true;
        window.${LEAK_GLOBAL}.saveState.started = true;
        ed.onSave(false, null, function() {
          window.${LEAK_GLOBAL}.saveState.done = true;
        });
        const saverBusy = (L.ui_ProjectSaver && L.ui_ProjectSaver.hasAny && L.ui_ProjectSaver.hasAny())
          || (L.ui_ProjectSaver && L.ui_ProjectSaver.QUEUE && L.ui_ProjectSaver.QUEUE.length > 0);
        if (!saverBusy) {
          return { ok: false, error: "onSave did not start ProjectSaver (editor locked or modal)" };
        }
        return { ok: true, locked: false };
      } catch (e) {
        window.${LEAK_GLOBAL}.saveState.error = String(e);
        return { ok: false, error: String(e) };
      }
    })()`, 180000);
    if (!started || !started.ok) {
      throw new Error((started && started.error) || "apply_rules failed to start");
    }
    await this._waitFor(
      async () => {
        const st = await this.eval(`window.${LEAK_GLOBAL}.saveState`);
        return st && st.done;
      },
      { timeout: 180000, interval: 300, label: "ProjectSaver complete" },
    );
    await this._waitIdle({ timeout: 60000 });
    await sleep(200);
    const after = hashProject(this.projectPath);
    const changedFiles = [];
    for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[f] !== after[f]) {
        changedFiles.push(path.basename(f));
      }
    }
    const inspect = inspectAutoLayerTiles(this.projectPath);
    const layers = await this.eval(`window.${LEAK_GLOBAL}.saveState.layers`);
    for (const generated of layers || []) {
      const written = inspect.layers.find((li) => li.level === generated.level && li.layer === generated.layer);
      if (!written || written.autoLayerTiles !== generated.generatedTiles) {
        throw new Error("ProjectSaver wrote stale auto-layer tiles: " + JSON.stringify({ generated, written }));
      }
    }
    await this._restoreCallerFocus({ waitMs: 400 });
    return {
      saved: true,
      changed: changedFiles.length > 0,
      changedFiles,
      appliedLayers: layers || [],
      jsonVersion: inspect.jsonVersion,
      autoLayerTiles: inspect.layers,
    };
  }

  async getErrors() {
    this._requireRunning();
    const fromApp = await this.eval(`(() => {
      const L = window.${LEAK_GLOBAL};
      const out = { log: [], page: null, editor: null };
      try {
        const entries = (L.App.LOG && L.App.LOG.entries) || [];
        const n = entries.length;
        for (let i = Math.max(0, n - 80); i < n; i++) {
          const e = entries[i];
          if (!e) continue;
          const tag = e.tag || "";
          const critical = !!e.critical;
          if (critical || tag === "error" || tag === "ERROR" || /error|fail/i.test(String(e.str || ""))) {
            out.log.push({ tag, str: String(e.str || ""), critical });
          }
        }
      } catch (e) {
        out.logError = String(e);
      }
      try {
        const ed = L.page_Editor && L.page_Editor.ME;
        if (ed && ed.curLevel) {
          out.editor = {
            level: ed.curLevel.identifier,
            needSaving: !!ed.needSaving
          };
        }
        out.page = L.App.ME && L.App.ME.curPageProcess ? String(L.App.ME.curPageProcess) : null;
      } catch (e) {}
      try {
        out.modalCount = L.ui_Modal.ALL ? L.ui_Modal.ALL.length : null;
      } catch (e) {}
      return out;
    })()`);
    await this._restoreCallerFocus({ waitMs: 300 });
    return {
      console: this.consoleErrors.slice(-50),
      app: fromApp,
    };
  }

  async quit() {
    if (!this.child || this.child.exitCode != null) {
      this._cleanupUserData();
      return { quit: true, alreadyExited: true, foreignMainPids: this.foreignMainPids };
    }
    if (!this.owned) {
      throw new Error("refusing to quit a process not started by this bridge");
    }
    const pid = this.child.pid;
    try {
      await this.eval(`(() => {
        try { window.${LEAK_GLOBAL}.App.ME.exit(true); return true; } catch (e) { return String(e); }
      })()`);
    } catch {
      /* process may already be going away */
    }
    const exited = await this._waitChildExit(8000);
    if (!exited) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      await this._waitChildExit(4000);
    }
    if (this.child.exitCode == null && this.child.signalCode == null) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      await this._waitChildExit(2000);
    }
    this._killStragglers(pid);
    this._cleanupUserData();
    if (this.callerFrontmost) {
      restoreFrontApp(this.callerFrontmost);
    }
    this.cdp && this.cdp.close();
    this.owned = false;
    this.leaked = false;
    this.sessionId = null;
    this.projectPath = null;
    return {
      quit: true,
      pid,
      foreignMainPids: this.foreignMainPids,
      foreignStillAlive: this.foreignMainPids.filter((p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      }),
    };
  }

  _killStragglers(mainPid) {
    if (!this.userDataDir) {
      return;
    }
    const needle = this.userDataDir;
    for (const proc of listProcesses()) {
      if (proc.pid === mainPid) {
        continue;
      }
      if (!proc.args.includes("/Applications/LDtk.app/") || !proc.args.includes(needle)) {
        continue;
      }
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
    }
  }

  _cleanupUserData() {
    if (!this.userDataDir) {
      return;
    }
    try {
      fs.rmSync(this.userDataDir, { recursive: true, force: true });
    } catch (err) {
      log("cleanup user-data-dir", err.message);
    }
  }

  async _waitChildExit(timeout) {
    if (!this.child || this.child.exitCode != null || this.child.signalCode != null) {
      return true;
    }
    const child = this.child;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, timeout);
      const onExit = () => {
        clearTimeout(t);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }

  _requireRunning() {
    if (!this.child || this.child.exitCode != null || !this.cdp || !this.sessionId) {
      throw new Error("LDtk is not running; call launch first");
    }
  }

  _requireEditor() {
    this._requireRunning();
    if (!this.leaked) {
      throw new Error("LDtk internals not leaked");
    }
  }
}

const TOOLS = [
  {
    name: "launch",
    description:
      "Start a private LDtk 1.5.3 instance owned by this bridge (isolated --user-data-dir, CDP over --remote-debugging-pipe). Never attaches to a user-opened LDtk.",
    inputSchema: {
      type: "object",
      properties: {
        ldtk_path: { type: "string", description: "Path to LDtk executable. Default: /Applications/LDtk.app/Contents/MacOS/LDtk" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_project",
    description: "Open an .ldtk project in the managed instance via App.ME.loadProject.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to a .ldtk file" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_levels",
    description: "List levels in the open project (identifier, uid, iid).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "select_level",
    description: "Select a level by identifier, uid, or iid and fit the camera (page.Editor.selectLevel).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Level identifier, uid, or iid" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "world_view",
    description: "Switch the editor to world view (page.Editor.setWorldMode(true)) and fit the camera.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "screenshot",
    description: "Capture a PNG of the LDtk window, current level canvas, or world-view canvas.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["window", "level", "world"], description: "Default window" },
        path: { type: "string", description: "Destination PNG path" },
        include_content: { type: "boolean", description: "If true, also return base64 PNG in the MCP result" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "apply_rules_and_save",
    description:
      "Force LayerInstance.applyAllRules on every auto-layer, then Editor.onSave so LDtk itself recomputes autoLayerTiles and writes JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_errors",
    description: "Return LDtk App.LOG error/warning entries plus CDP console errors.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "quit",
    description: "Quit and clean up only the LDtk instance started by this bridge. Alias: close.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "close",
    description: "Same as quit: close only the bridge-owned LDtk instance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const session = new LdtkSession();

async function callTool(name, args = {}) {
  switch (name) {
    case "launch":
      return session.launch({ ldtkPath: args.ldtk_path || DEFAULT_LDTK });
    case "open_project":
      return session.openProject(args.path);
    case "list_levels":
      return session.listLevels();
    case "select_level":
      return session.selectLevel(args.id);
    case "world_view":
      return session.worldView();
    case "screenshot":
      return session.screenshot({
        target: args.target || "window",
        outPath: args.path,
        includeContent: !!args.include_content,
      });
    case "apply_rules_and_save":
      return session.applyRulesAndSave();
    case "get_errors":
      return session.getErrors();
    case "quit":
    case "close":
      return session.quit();
    default:
      throw new Error("unknown tool: " + name);
  }
}

function mcpResult(obj, extraContent = []) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  return {
    content: [{ type: "text", text }, ...extraContent],
  };
}

function mcpError(err) {
  return {
    content: [{ type: "text", text: String(err && err.message ? err.message : err) }],
    isError: true,
  };
}

async function handleMcp(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: msg && msg.id, error: { code: -32600, message: "invalid JSON-RPC" } };
  }
  if (msg.method && msg.method.startsWith("notifications/")) {
    return null;
  }
  const id = msg.id;
  try {
    if (msg.method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "ldtk-mcp", version: VERSION },
        },
      };
    }
    if (msg.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (msg.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    }
    if (msg.method === "tools/call") {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      try {
        const value = await callTool(name, args);
        const extra = [];
        if (name === "screenshot" && args.include_content && value && value.pngBase64) {
          extra.push({ type: "image", data: value.pngBase64, mimeType: "image/png" });
        }
        return { jsonrpc: "2.0", id, result: mcpResult(value, extra) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: mcpError(err) };
      }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + msg.method } };
  } catch (err) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: String(err.message || err) } };
  }
}

async function* readStdinMessages() {
  process.stdin.setEncoding("utf8");
  let buf = "";
  let mode = null;
  for await (const chunk of process.stdin) {
    buf += chunk;
    while (true) {
      if (mode === null) {
        if (buf.startsWith("Content-Length:") || buf.startsWith("content-length:")) {
          mode = "lsp";
        } else if (buf.includes("\n")) {
          mode = "ndjson";
        } else {
          break;
        }
      }
      if (mode === "lsp") {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          break;
        }
        const header = buf.slice(0, headerEnd);
        const m = /Content-Length:\s*(\d+)/i.exec(header);
        if (!m) {
          throw new Error("missing Content-Length");
        }
        const len = Number(m[1]);
        const start = headerEnd + 4;
        if (buf.length < start + len) {
          break;
        }
        const json = buf.slice(start, start + len);
        buf = buf.slice(start + len);
        yield JSON.parse(json);
      } else {
        const nl = buf.indexOf("\n");
        if (nl < 0) {
          break;
        }
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) {
          continue;
        }
        yield JSON.parse(line);
      }
    }
  }
}

function writeMcp(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(json + "\n");
}

async function runMcp() {
  const stop = async () => {
    try {
      if (session.owned) {
        await session.quit();
      }
    } catch (err) {
      log("shutdown quit", err.message);
    }
  };
  process.on("SIGINT", () => {
    stop().finally(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    stop().finally(() => process.exit(143));
  });
  for await (const msg of readStdinMessages()) {
    const reply = await handleMcp(msg);
    if (reply) {
      writeMcp(reply);
    }
  }
  await stop();
}

function copyProjectForTest(repo, destRoot) {
  const src = path.join(repo, "data", "ldtk");
  const dest = path.join(destRoot, "data", "ldtk");
  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => !p.includes(`${path.sep}backups${path.sep}`) && !p.endsWith(`${path.sep}backups`),
  });
  const assetSrc = path.join(repo, "assets");
  const assetDest = path.join(destRoot, "assets");
  if (fs.existsSync(assetSrc) && !fs.existsSync(assetDest)) {
    fs.symlinkSync(assetSrc, assetDest);
  }
  const artSrc = path.join(repo, "art-src");
  const artDest = path.join(destRoot, "art-src");
  if (fs.existsSync(artSrc) && !fs.existsSync(artDest)) {
    fs.symlinkSync(artSrc, artDest);
  }
  return path.join(dest, "no-name-game.ldtk");
}

async function runSelftest() {
  const repo = repoRootFromHere();
  const evidence = path.join(repo, ".local", "ldtk-mcp-evidence");
  fs.mkdirSync(evidence, { recursive: true });
  const copyRoot = path.join(evidence, "project-copy");
  const projectPath = copyProjectForTest(repo, copyRoot);
  const foreignBefore = listMainLdtkPids();
  const summary = {
    foreignBefore,
    runs: [],
    leftover: [],
    foreignAfter: null,
  };
  log("selftest project", projectPath);
  log("foreign LDtk PIDs", foreignBefore.join(",") || "(none)");
  const plans = [
    { n: 1, dir: "run-1", occlude: false },
    { n: 2, dir: "run-2", occlude: false },
    { n: 3, dir: "run-3", occlude: false },
    { n: 4, dir: "run-occluded", occlude: true },
  ];
  for (const plan of plans) {
    const runDir = path.join(evidence, plan.dir);
    fs.mkdirSync(runDir, { recursive: true });
    const t0 = nowMs();
    const rec = { n: plan.n, occlude: plan.occlude, steps: {}, focus: { steps: {} } };
    const s = new LdtkSession();
    const checkFocus = (label, before) => {
      const after = frontmostAppHfs();
      const row = {
        before,
        after,
        same: sameFrontApp(before, after),
      };
      rec.focus.steps[label] = row;
      if (!row.same) {
        throw new Error("focus stolen at " + label + ": " + before + " -> " + after);
      }
      return after;
    };
    try {
      const r04Path = path.join(path.dirname(projectPath), "no-name-game", "r04_sorting_hall.ldtkl");
      const fixture = parseLdtkJson(fs.readFileSync(r04Path, "utf8"));
      const collision = fixture.layerInstances.find((li) => li.__identifier === "Collision");
      collision.autoLayerTiles = plan.n % 2 === 1 ? null : [];
      fs.writeFileSync(r04Path, JSON.stringify(fixture));
      rec.inputCache = collision.autoLayerTiles;
      rec.focus.initial = frontmostAppHfs();
      let f = rec.focus.initial;
      rec.steps.launch = await s.launch({
        userDataDir: path.join(runDir, "user-data"),
        occlude: plan.occlude,
      });
      checkFocus("launch", f);
      rec.focus.steps.launch.flashMs = s.focusFlashMs;
      rec.focus.steps.launch.stolen = s.focusStolen;
      f = rec.focus.steps.launch.after;
      rec.steps.open = await s.openProject(projectPath);
      f = checkFocus("open_project", f);
      rec.steps.world = await s.worldView();
      f = checkFocus("world_view", f);
      rec.steps.worldShot = await s.screenshot({
        target: "world",
        outPath: path.join(runDir, "world.png"),
      });
      f = checkFocus("screenshot_world", f);
      rec.steps.r04 = await s.selectLevel("r04_sorting_hall");
      f = checkFocus("select_level", f);
      rec.steps.r04Shot = await s.screenshot({
        target: "level",
        outPath: path.join(runDir, "r04_sorting_hall.png"),
      });
      f = checkFocus("screenshot_level", f);
      rec.steps.save = await s.applyRulesAndSave();
      f = checkFocus("apply_rules_and_save", f);
      const written = parseLdtkJson(fs.readFileSync(r04Path, "utf8"));
      const writtenCollision = written.layerInstances.find((li) => li.__identifier === "Collision");
      rec.nullOrEmptyCacheRecovered = (writtenCollision.autoLayerTiles || []).length > 0;
      if (!rec.nullOrEmptyCacheRecovered) {
        throw new Error("Native rules did not recover null/empty cache: " + (writtenCollision.autoLayerTiles || []).length);
      }
      rec.steps.guiRebuild = await s.eval(`(() => {
        const L = window.${LEAK_GLOBAL};
        const level = L.page_Editor.ME.project.worlds.flatMap((w) => w.levels)
          .find((level) => level.identifier === "r04_sorting_hall");
        const li = level.layerInstances.find((li) => li.get_def().identifier === "Collision");
        const panel = new L.ui_modal_panel_EditAllAutoLayerRules(li);
        panel.jContent.find("button.seed").trigger("click");
        for (const group of li.get_def().autoRuleGroups) {
          panel.invalidateRuleGroup(group);
        }
        panel.close();
        return { seed: li.seed, nativeGuiHandler: "EditAllAutoLayerRules.seed/onClose" };
      })()`);
      await s._waitIdle({ timeout: 180000 });
      f = checkFocus("native_gui_rebuild", f);
      const guiTiles = await s.eval(`(() => {
        const level = window.${LEAK_GLOBAL}.page_Editor.ME.project.worlds.flatMap((w) => w.levels)
          .find((level) => level.identifier === "r04_sorting_hall");
        return level.layerInstances.find((li) => li.get_def().identifier === "Collision").toJson().autoLayerTiles;
      })()`);
      rec.steps.guiComparisonSave = await s.applyRulesAndSave();
      f = checkFocus("gui_comparison_save", f);
      const comparisonLevel = parseLdtkJson(fs.readFileSync(r04Path, "utf8"));
      const comparisonLayer = comparisonLevel.layerInstances.find((li) => li.__identifier === "Collision");
      const canonical = (tiles) => JSON.stringify(tiles.map((tile) => JSON.stringify(tile)).sort());
      rec.guiComparison = {
        guiTiles: guiTiles.length,
        writtenTiles: comparisonLayer.autoLayerTiles.length,
        same: canonical(guiTiles) === canonical(comparisonLayer.autoLayerTiles),
        seedUnchanged: comparisonLayer.seed === rec.steps.guiRebuild.seed,
      };
      if (!rec.guiComparison.same || !rec.guiComparison.seedUnchanged || guiTiles.length === 0) {
        throw new Error("Bridge tiles differ from native GUI recalculation: " + JSON.stringify(rec.guiComparison));
      }
      rec.steps.errors = await s.getErrors();
      f = checkFocus("get_errors", f);
      rec.steps.quit = await s.quit();
      f = checkFocus("quit", f);
      rec.focus.final = f;
      rec.focus.ok = Object.values(rec.focus.steps).every((row) => row.same);
      rec.ok = !!(
        rec.focus.ok &&
        rec.nullOrEmptyCacheRecovered && rec.guiComparison.same && rec.guiComparison.seedUnchanged &&
        rec.steps.save &&
        rec.steps.save.jsonVersion &&
        rec.steps.save.autoLayerTiles &&
        rec.steps.save.autoLayerTiles.some((l) => l.hasRules && l.autoLayerTiles > 0) &&
        rec.steps.worldShot &&
        rec.steps.r04Shot
      );
      rec.ms = nowMs() - t0;
      rec.shots = {
        world: rec.steps.worldShot.path,
        r04: rec.steps.r04Shot.path,
      };
    } catch (err) {
      rec.ok = false;
      rec.error = String(err && err.stack ? err.stack : err);
      rec.ms = nowMs() - t0;
      try {
        await s.quit();
      } catch {
        /* ignore */
      }
    }
    summary.runs.push(rec);
    log("run", plan.n, plan.occlude ? "occluded" : "normal", rec.ok ? "ok" : "FAIL", rec.ms + "ms");
    if (!rec.ok) {
      break;
    }
  }
  summary.foreignAfter = listMainLdtkPids();
  summary.foreignUntouched =
    foreignBefore.slice().sort().join(",") === summary.foreignAfter.slice().sort().join(",");
  summary.leftover = listBridgeStragglers();
  const outPath = path.join(evidence, "selftest-summary.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  const allOk =
    summary.runs.length === 4 &&
    summary.runs.every((r) => r.ok && r.focus && r.focus.ok) &&
    summary.runs.some((r) => r.occlude) &&
    summary.foreignUntouched &&
    summary.leftover.length === 0;
  if (!allOk) {
    process.exitCode = 1;
  }
}

async function runMcpFocusProbe() {
  const repo = repoRootFromHere();
  const evidence = path.join(repo, ".local", "ldtk-mcp-evidence");
  fs.mkdirSync(evidence, { recursive: true });
  const copyRoot = path.join(evidence, "project-copy");
  const projectPath = fs.existsSync(path.join(copyRoot, "data", "ldtk", "no-name-game.ldtk"))
    ? path.join(copyRoot, "data", "ldtk", "no-name-game.ldtk")
    : copyProjectForTest(repo, copyRoot);
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => process.stderr.write(d));
  const pending = new Map();
  const flush = () => {
    while (true) {
      const nl = out.indexOf("\n");
      if (nl < 0) {
        break;
      }
      const line = out.slice(0, nl).trim();
      out = out.slice(nl + 1);
      if (!line) {
        continue;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const resolve = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  };
  child.stdout.on("data", (d) => {
    out += d;
    flush();
  });
  let nextId = 1;
  const rpc = (method, params) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("rpc timeout " + method)), 180000);
      pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
  };
  const steps = [];
  const initial = frontmostAppHfs();
  await rpc("initialize", {
    protocolVersion: MCP_PROTOCOL,
    capabilities: {},
    clientInfo: { name: "focus-probe", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const calls = [
    ["launch", {}],
    ["open_project", { path: projectPath }],
    ["select_level", { id: "r04_sorting_hall" }],
    ["screenshot", { target: "level", path: path.join(evidence, "mcp-probe-level.png") }],
    ["world_view", {}],
    ["screenshot", { target: "world", path: path.join(evidence, "mcp-probe-world.png") }],
    ["quit", {}],
  ];
  for (const [name, args] of calls) {
    const before = frontmostAppHfs();
    const t0 = nowMs();
    const reply = await rpc("tools/call", { name, arguments: args });
    const after = frontmostAppHfs();
    const isErr = !!(reply.error || (reply.result && reply.result.isError));
    steps.push({
      name,
      ms: nowMs() - t0,
      before,
      after,
      same: sameFrontApp(before, after),
      error: isErr,
    });
    log("mcp-probe", name, steps[steps.length - 1].same ? "focus-ok" : "FOCUS-STOLEN", after);
    if (isErr) {
      log("mcp-probe error", JSON.stringify(reply).slice(0, 400));
    }
  }
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const summary = {
    initial,
    steps,
    allSame: steps.every((s) => s.same && !s.error),
    foreign: listMainLdtkPids(),
  };
  fs.writeFileSync(path.join(evidence, "mcp-focus-probe.json"), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (!summary.allSame) {
    process.exitCode = 1;
  }
}

function printHelp() {
  process.stdout.write(`ldtk-mcp ${VERSION}
stdio MCP server that drives a private LDtk 1.5.3 via --remote-debugging-pipe.

Usage:
  node ldtk-mcp.mjs                 # MCP stdio server
  node ldtk-mcp.mjs --selftest      # 3 normal + 1 occluded run, with focus asserts
  node ldtk-mcp.mjs --mcp-focus-probe
  node ldtk-mcp.mjs --help
`);
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  printHelp();
} else if (argv.includes("--selftest")) {
  runSelftest().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  });
} else if (argv.includes("--mcp-focus-probe")) {
  runMcpFocusProbe().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  });
} else {
  runMcp().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  });
}
