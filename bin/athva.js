#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

function main() {
  const args = process.argv.slice(2);
  const target = args[0] ?? ".";
  const absPath = path.resolve(process.cwd(), target);

  // macOS: use `open` to launch the installed app and pass args through to Tauri.
  if (process.platform === "darwin") {
    const appName = process.env.ATHVA_APP_NAME || "Athva";
    const result = spawnSync("open", ["-a", appName, "--args", absPath], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  // Other platforms: try executing a binary named `athva` if present (packaged app),
  // otherwise fall back to a helpful error.
  const result = spawnSync("athva", [absPath], { stdio: "inherit" });
  if (result.status === 0) process.exit(0);
  console.error("Athva launcher: unsupported platform or app not installed. On macOS, install the app and run `athva .` again.");
  process.exit(result.status ?? 1);
}

main();

