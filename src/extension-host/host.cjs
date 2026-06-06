"use strict";

// Athva Extension Host — runs as a child Node.js process.
// Loads a single VS Code extension and bridges it to the renderer over stdio IPC.
//
// argv: node host.cjs <extensionMainPath> <extensionId> <installPath>

const path = require("path");
const os = require("os");
const fs = require("fs");
const { send, onMessage } = require("./ipc.cjs");

// Claude/Copilot/other modern extensions may rely on explicit resource
// management symbols even when running under older embedded Node runtimes.
if (!Symbol.dispose) Symbol.dispose = Symbol.for("Symbol.dispose");
if (!Symbol.asyncDispose) Symbol.asyncDispose = Symbol.for("Symbol.asyncDispose");
if (!Object.prototype[Symbol.dispose]) {
  Object.defineProperty(Object.prototype, Symbol.dispose, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function hostNoopDispose() {},
  });
}
if (!Object.prototype[Symbol.asyncDispose]) {
  Object.defineProperty(Object.prototype, Symbol.asyncDispose, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: async function hostNoopAsyncDispose() {},
  });
}
// Copilot chat and similar extensions expect Web Crypto on global scope.
try {
  const nodeCrypto = require("crypto");
  const webCrypto = nodeCrypto?.webcrypto;
  if (webCrypto) {
    globalThis.crypto = webCrypto;
    global.crypto = webCrypto;
  }
} catch {}

try {
  if (!globalThis.crypto) {
    const nodeCrypto = require("crypto");
    if (nodeCrypto?.webcrypto) globalThis.crypto = nodeCrypto.webcrypto;
  }
} catch {}

// Some extensions assume browser-like File is available in the runtime.
try {
  if (typeof globalThis.File === "undefined" && typeof globalThis.Blob !== "undefined") {
    globalThis.File = class File extends Blob {
      constructor(parts, name, options = {}) {
        super(parts, options);
        this.name = String(name || "");
        this.lastModified = Number(options.lastModified || Date.now());
      }
    };
  }
} catch {}

const [,, extMain, extId, installPath] = process.argv;

if (!extMain) {
  send({ type: "error", message: "host.cjs requires <extensionMainPath> as first arg" });
  process.exit(1);
}

// Prevent extensions from terminating the host process directly.
const _hostProcessExit = process.exit.bind(process);
process.exit = function patchedProcessExit(code = 0) {
  const numericCode = Number(code || 0);
  if (numericCode === 0) return;
  throw new Error(`Extension requested process.exit(${numericCode})`);
};

process.on("uncaughtException", (err) => {
  const msg = err && typeof err.message === "string" ? err.message : String(err);
  const stack = err && typeof err.stack === "string" ? err.stack.split("\n").slice(0, 25).join("\n") : "";
  send({ type: "error", message: msg, stack });
});

process.on("unhandledRejection", (reason) => {
  const msg = reason && typeof reason.message === "string" ? reason.message : String(reason);
  const stack = reason && typeof reason.stack === "string" ? reason.stack.split("\n").slice(0, 25).join("\n") : "";
  send({ type: "error", message: msg, stack });
});

// Some VSIX bundles ship a Linux-only native Claude binary. On macOS this throws
// spawn "Unknown system error -8" (exec format). Reroute to user's installed
// `claude` CLI when we detect that specific bundled path.
function patchChildProcessForClaudeBinaryCompatibility() {
  if (process.platform !== "darwin") return;
  const cp = require("child_process");
  const targetSuffix = `${path.sep}resources${path.sep}native-binary${path.sep}claude`;
  const isBundledClaudePath = (cmd) =>
    typeof cmd === "string" && cmd.includes("anthropic.claude-code") && cmd.endsWith(targetSuffix);

  const mapCommand = (cmd) => (isBundledClaudePath(cmd) ? "claude" : cmd);

  const origSpawn = cp.spawn;
  cp.spawn = function patchedSpawn(command, args, options) {
    return origSpawn.call(this, mapCommand(command), args, options);
  };

  const origSpawnSync = cp.spawnSync;
  cp.spawnSync = function patchedSpawnSync(command, args, options) {
    return origSpawnSync.call(this, mapCommand(command), args, options);
  };

  const origExecFile = cp.execFile;
  cp.execFile = function patchedExecFile(file, args, options, callback) {
    return origExecFile.call(this, mapCommand(file), args, options, callback);
  };
}
patchChildProcessForClaudeBinaryCompatibility();

// Override require('vscode') before loading the extension
const Module = require("module");
const origLoad = Module._load;
const shimPath = path.resolve(__dirname, "vscode-shim.cjs");
const vscode = require(shimPath);

Module._load = function (req, parent, isMain) {
  if (req === "vscode") return vscode;
  if (req === "node:sqlite" || req === "sqlite" || req === "node:sqlite3") {
    // Node < 22 has no built-in node:sqlite. Return a no-op compatibility stub.
    class DatabaseSync {
      constructor() {}
      prepare() {
        return {
          run() { return { changes: 0, lastInsertRowid: 0 }; },
          get() { return undefined; },
          all() { return []; },
          iterate() { return [][Symbol.iterator](); },
        };
      }
      exec() {}
      close() {}
      transaction(fn) { return (...args) => fn(...args); }
    }
    return { DatabaseSync, default: { DatabaseSync } };
  }
  return origLoad.call(this, req, parent, isMain);
};

// Buffer messages that arrive before the extension is activated.
// setWorkspace fires workspaceFoldersEmitter which extensions listen to —
// if it arrives before _initDefaults is called, config lookups return undefined.
let _activated = false;
const _msgQueue = [];
onMessage(async (msg) => {
  if (!_activated) { _msgQueue.push(msg); return; }
  await vscode._handleMessage(msg);
});

function flushQueue() {
  _activated = true;
  for (const msg of _msgQueue) {
    vscode._handleMessage(msg).catch(() => {});
  }
  _msgQueue.length = 0;
}

// Build a Uri-like object from a filesystem path
function makeUri(fsPath) {
  return {
    scheme: "file",
    authority: "",
    path: fsPath,
    query: "",
    fragment: "",
    fsPath,
    toString: () => `file://${fsPath}`,
    with: (change) => makeUri(change.path ?? fsPath),
  };
}

// Resolve system binaries that extensions may need (ripgrep, etc.)
function resolveSystemBinaries() {
  const rg = process.platform === "win32" ? "rg.exe" : "rg";

  // Bundled binary lives next to host.cjs (works in both dev and production)
  const bundled = path.join(__dirname, rg);
  if (fs.existsSync(bundled)) return { "todo-tree.ripgrep.ripgrep": bundled };

  // Try to find via shell with augmented PATH
  try {
    const { execSync } = require("child_process");
    const augPath = "/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/opt/ripgrep/bin";
    const found = execSync(
      `PATH="${augPath}:$PATH" command -v ${rg} 2>/dev/null`,
      { encoding: "utf8", timeout: 2000, shell: "/bin/sh" }
    ).trim();
    if (found && fs.existsSync(found)) return { "todo-tree.ripgrep.ripgrep": found };
  } catch {}

  // Static fallbacks
  for (const p of [`/opt/homebrew/bin/${rg}`, `/usr/local/bin/${rg}`, `/usr/bin/${rg}`]) {
    if (fs.existsSync(p)) return { "todo-tree.ripgrep.ripgrep": p };
  }
  return {};
}

// Extract default values from contributes.configuration schema
function extractConfigDefaults(packageJSON) {
  const defaults = {};
  const configs = packageJSON?.contributes?.configuration;
  if (!configs) return defaults;
  const sections = Array.isArray(configs) ? configs : [configs];
  for (const section of sections) {
    for (const [key, def] of Object.entries(section.properties || {})) {
      if ("default" in def) defaults[key] = def.default;
    }
  }
  return defaults;
}

function ensurePlatformBinaryFallback(extensionRoot) {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;

  const binRoot = path.join(extensionRoot, "bin");
  const nativeDir = path.join(binRoot, "macos-aarch64");
  const x64Dir = path.join(binRoot, "macos-x86_64");

  if (fs.existsSync(nativeDir) || !fs.existsSync(x64Dir)) return;

  try {
    fs.symlinkSync(x64Dir, nativeDir, "dir");
    return;
  } catch {}

  try {
    fs.mkdirSync(nativeDir, { recursive: true });
    for (const entry of fs.readdirSync(x64Dir, { withFileTypes: true })) {
      const sourcePath = path.join(x64Dir, entry.name);
      const targetPath = path.join(nativeDir, entry.name);
      if (fs.existsSync(targetPath)) continue;
      if (entry.isDirectory()) {
        fs.cpSync(sourcePath, targetPath, { recursive: true });
      } else {
        fs.copyFileSync(sourcePath, targetPath);
        try {
          const stat = fs.statSync(sourcePath);
          fs.chmodSync(targetPath, stat.mode);
        } catch {}
      }
    }
  } catch {}
}

function ensureExecutableBits(extensionRoot) {
  const binRoot = path.join(extensionRoot, "bin");
  if (!fs.existsSync(binRoot)) return;

  const visit = (dirPath) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const stat = fs.statSync(entryPath);
        const execMask = 0o111;
        if ((stat.mode & execMask) === execMask) continue;
        fs.chmodSync(entryPath, stat.mode | 0o755);
      } catch {}
    }
  };

  visit(binRoot);
}

// Load and activate the extension
async function main() {
  try {
    const extensionRoot = fs.existsSync(path.join(installPath, "extension", "package.json"))
      ? path.join(installPath, "extension")
      : installPath;

    ensurePlatformBinaryFallback(extensionRoot);
    ensureExecutableBits(extensionRoot);

    // Read package.json for metadata and schema defaults
    let packageJSON = {};
    const pkgCandidates = [
      path.join(extensionRoot, "package.json"),
      path.join(installPath, "package.json"),
    ];
    for (const p of pkgCandidates) {
      try { packageJSON = JSON.parse(fs.readFileSync(p, "utf8")); break; } catch {}
    }

    // Seed the shim with schema-defined config defaults so extensions get
    // correct zero-values (e.g. {} for tagGroups) rather than undefined.
    // System binaries (e.g. ripgrep) are resolved and merged in so extensions
    // that require them work without manual user configuration.
    const configDefaults = { ...extractConfigDefaults(packageJSON), ...resolveSystemBinaries() };
    if (extId === "GitHub.copilot-chat") {
      configDefaults["chat.allowAnonymousAccess"] = true;
    }
    vscode._initDefaults(configDefaults);

    const ext = require(path.resolve(extMain));
    if (!ext || typeof ext.activate !== "function") {
      send({ type: "error", message: "Extension has no activate() export" });
      return;
    }

    const safeId = extId.replace(/[^a-z0-9]/gi, "_");
    const storagePath = path.join(os.tmpdir(), `athva-ext-${safeId}`);
    const globalStoragePath = path.join(os.tmpdir(), `athva-ext-global-${safeId}`);
    const logPath = path.join(os.tmpdir(), `athva-ext-log-${safeId}`);

    // Ensure storage dirs exist — some extensions mkdir on their own, others assume it exists
    for (const dir of [storagePath, globalStoragePath, logPath]) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    }

    const context = {
      subscriptions: {
        _items: [],
        push(...items) { this._items.push(...items); },
      },
      extensionPath: extensionRoot,
      extensionUri: makeUri(extensionRoot),
      storagePath,
      storageUri: makeUri(storagePath),
      globalStoragePath,
      globalStorageUri: makeUri(globalStoragePath),
      logPath,
      logUri: makeUri(logPath),
      extensionMode: 1, // Production
      workspaceState: {
        _data: {},
        get(key, defaultValue) { return this._data[key] ?? defaultValue; },
        update(key, value) { this._data[key] = value; return Promise.resolve(); },
        keys() { return Object.keys(this._data); },
      },
      globalState: {
        _data: {},
        get(key, defaultValue) { return this._data[key] ?? defaultValue; },
        update(key, value) { this._data[key] = value; return Promise.resolve(); },
        setKeysForSync(keys) {},
        keys() { return Object.keys(this._data); },
      },
      secrets: {
        get: () => Promise.resolve(undefined),
        store: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        onDidChange: { event: () => ({ dispose: () => {} }) },
      },
      asAbsolutePath(relativePath) { return path.join(extensionRoot, relativePath); },
      environmentVariableCollection: {
        persistent: false, description: undefined,
        replace() {}, append() {}, prepend() {}, get() { return undefined; },
        forEach() {}, delete() {}, clear() {},
        getScoped() { return this; }, [Symbol.iterator]() { return [][Symbol.iterator](); },
      },
      extension: { id: extId, extensionPath: extensionRoot, isActive: true, packageJSON },
      languageModelAccessInformation: { canSendRequest: () => undefined, onDidChange: () => ({ dispose: () => {} }) },
    };

    await ext.activate(context);
    flushQueue();
    send({ type: "activated", extensionId: extId });
  } catch (e) {
    flushQueue();
    const msg = e && typeof e.message === "string" ? e.message : String(e);
    const stack = e && typeof e.stack === "string"
      ? e.stack.split("\n").slice(0, 25).join("\n")
      : "";
    send({ type: "error", message: msg, stack });
  }
}

main();
