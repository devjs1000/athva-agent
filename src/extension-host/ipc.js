"use strict";

// Framed newline-delimited JSON over stdout/stdin.
// Each message is a single JSON line — the renderer splits on '\n'.

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function onMessage(handler) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop(); // incomplete last line stays in buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handler(JSON.parse(trimmed));
      } catch {}
    }
  });
  process.stdin.resume();
}

module.exports = { send, onMessage };
