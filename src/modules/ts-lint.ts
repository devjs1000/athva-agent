// TypeScript/TSX/JSX linting via Web Worker
// Uses the real TypeScript compiler for syntax + semantic diagnostics

let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, (annotations: any[]) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(
      new URL("./ts-lint.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = (e) => {
      const { id, annotations } = e.data;
      const resolve = pending.get(id);
      if (resolve) {
        pending.delete(id);
        resolve(annotations);
      }
    };
  }
  return worker;
}

export function lintTypeScript(
  fileName: string,
  code: string
): Promise<Array<{ row: number; column: number; text: string; type: string }>> {
  return new Promise((resolve) => {
    const id = ++requestId;
    pending.set(id, resolve);
    getWorker().postMessage({ id, fileName, code });
  });
}

// File extensions that should use TS linting
const TS_EXTENSIONS = new Set(["ts", "tsx", "jsx"]);

export function shouldUseTsLint(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  return TS_EXTENSIONS.has(ext);
}

export function getTsFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (ext === "tsx") return "file.tsx";
  if (ext === "jsx") return "file.jsx";
  return "file.ts";
}
