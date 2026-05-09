export interface IdeLogEntry {
  ts: number;
  level: "log" | "info" | "warn" | "error";
  message: string;
}

const MAX_LOGS = 1200;
const logs: IdeLogEntry[] = [];
let initialized = false;

function push(level: IdeLogEntry["level"], message: string) {
  logs.push({ ts: Date.now(), level, message });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function serializeArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`.trim();
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

export function initIdeLogsCapture() {
  if (initialized) return;
  initialized = true;

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    push("log", serializeArgs(args));
    original.log(...args);
  };
  console.info = (...args: unknown[]) => {
    push("info", serializeArgs(args));
    original.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    push("warn", serializeArgs(args));
    original.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("error", serializeArgs(args));
    original.error(...args);
  };

  window.addEventListener("error", (event) => {
    const msg = event.error instanceof Error
      ? `${event.error.name}: ${event.error.message}\n${event.error.stack ?? ""}`.trim()
      : `${event.message} (${event.filename}:${event.lineno}:${event.colno})`;
    push("error", msg);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}\n${event.reason.stack ?? ""}`.trim()
      : String(event.reason);
    push("error", `Unhandled promise rejection: ${reason}`);
  });

  push("info", "IDE log capture initialized");
}

export function getIdeLogsSnapshot(limit = 250): IdeLogEntry[] {
  if (limit <= 0) return [];
  return logs.slice(-limit);
}

