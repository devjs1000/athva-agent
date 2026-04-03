import ts from "typescript";

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  strict: false,
  noEmit: true,
  allowJs: true,
  esModuleInterop: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noResolve: true,
  isolatedModules: true,
  skipLibCheck: true,
};

// Minimal ambient declarations so common globals don't produce noise
const LIB_SOURCE = `
declare var console: { log(...args: any[]): void; error(...args: any[]): void; warn(...args: any[]): void; info(...args: any[]): void; debug(...args: any[]): void; };
declare var setTimeout: (cb: (...args: any[]) => void, ms?: number, ...args: any[]) => number;
declare var clearTimeout: (id: number) => void;
declare var setInterval: (cb: (...args: any[]) => void, ms?: number, ...args: any[]) => number;
declare var clearInterval: (id: number) => void;
declare var fetch: (url: string, init?: any) => Promise<any>;
declare var window: any;
declare var document: any;
declare var navigator: any;
declare var localStorage: any;
declare var sessionStorage: any;
declare function require(mod: string): any;
declare var process: any;
declare var module: any;
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var Promise: any;
declare var Map: any;
declare var Set: any;
declare var WeakMap: any;
declare var WeakSet: any;
declare var Symbol: any;
declare var Array: any;
declare var Object: any;
declare var String: any;
declare var Number: any;
declare var Boolean: any;
declare var Date: any;
declare var RegExp: any;
declare var Error: any;
declare var JSON: any;
declare var Math: any;
declare var parseInt: (s: string, radix?: number) => number;
declare var parseFloat: (s: string) => number;
declare var isNaN: (v: any) => boolean;
declare var isFinite: (v: any) => boolean;
declare var encodeURIComponent: (s: string) => string;
declare var decodeURIComponent: (s: string) => string;
declare var alert: (msg?: any) => void;
declare var confirm: (msg?: string) => boolean;
declare var prompt: (msg?: string, defaultVal?: string) => string | null;
declare var crypto: any;
declare var URL: any;
declare var URLSearchParams: any;
declare var AbortController: any;
declare var Headers: any;
declare var Request: any;
declare var Response: any;
declare var FormData: any;
declare var Blob: any;
declare var File: any;
declare var FileReader: any;
declare var TextEncoder: any;
declare var TextDecoder: any;
declare var Event: any;
declare var EventTarget: any;
declare var CustomEvent: any;
declare var HTMLElement: any;
declare var Element: any;
declare var Node: any;
declare var NodeList: any;
declare var requestAnimationFrame: (cb: (t: number) => void) => number;
declare var cancelAnimationFrame: (id: number) => void;
declare var queueMicrotask: (cb: () => void) => void;
declare var structuredClone: <T>(val: T) => T;
declare namespace React {
  function createElement(type: any, props?: any, ...children: any[]): any;
  function useState<T>(init: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void];
  function useEffect(cb: () => any, deps?: any[]): void;
  function useRef<T>(init?: T): { current: T };
  function useMemo<T>(cb: () => T, deps: any[]): T;
  function useCallback<T extends (...args: any[]) => any>(cb: T, deps: any[]): T;
  function useContext<T>(ctx: any): T;
  function useReducer<S, A>(reducer: (s: S, a: A) => S, init: S): [S, (a: A) => void];
  function memo<T>(comp: T): T;
  function forwardRef<T, P>(render: (props: P, ref: any) => any): any;
  function createContext<T>(defaultValue: T): any;
  function lazy<T>(factory: () => Promise<{ default: T }>): T;
  function Fragment(...args: any[]): any;
  type FC<P = {}> = (props: P) => any;
  type ReactNode = any;
  type CSSProperties = any;
  type ChangeEvent<T = any> = any;
  type MouseEvent<T = any> = any;
  type FormEvent<T = any> = any;
  type KeyboardEvent<T = any> = any;
}
declare namespace JSX {
  interface Element {}
  interface IntrinsicElements { [tag: string]: any; }
}
declare var React: typeof React;
`;

function getDiagnostics(fileName: string, code: string) {
  const files: Record<string, string> = {
    [fileName]: code,
    "lib.d.ts": LIB_SOURCE,
  };

  const host: ts.CompilerHost = {
    getSourceFile: (name, target) => {
      const src = files[name];
      if (src === undefined) return undefined;
      return ts.createSourceFile(name, src, target, true);
    },
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name in files,
    readFile: (name) => files[name],
  };

  const program = ts.createProgram([fileName], compilerOptions, host);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) return [];

  const allDiagnostics = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  // Filter out "cannot find module" noise (code 2307) and some other noisy ones
  const suppressCodes = new Set([
    2307, // Cannot find module
    2304, // Cannot find name (too noisy without full type defs)
    2580, // Cannot find name 'require'
    7016, // Could not find declaration file
    2503, // Cannot find namespace
  ]);

  return allDiagnostics
    .filter((d) => d.file && d.start !== undefined && !suppressCodes.has(d.code))
    .map((d) => {
      const { line, character } = d.file!.getLineAndCharacterOfPosition(d.start!);
      return {
        row: line,
        column: character,
        text: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        type:
          d.category === ts.DiagnosticCategory.Error
            ? "error"
            : d.category === ts.DiagnosticCategory.Warning
              ? "warning"
              : "info",
      };
    });
}

self.onmessage = (e: MessageEvent) => {
  const { id, fileName, code } = e.data;
  try {
    const annotations = getDiagnostics(fileName, code);
    (self as any).postMessage({ id, annotations });
  } catch (err: any) {
    (self as any).postMessage({ id, annotations: [], error: err.message });
  }
};
