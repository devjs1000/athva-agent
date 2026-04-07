// Tailwind CSS class name autocomplete for Ace editor
// Provides suggestions when typing inside class/className attributes in HTML/JSX/TSX

import type ace from "ace-builds";

let enabled = false;

export function setTailwindEnabled(val: boolean) {
  enabled = val;
}

export function isTailwindEnabled(): boolean {
  return enabled;
}

// Subset of most-used Tailwind classes (v3), organized by category
const TW_CLASSES: string[] = [
  // Layout
  "block", "inline-block", "inline", "flex", "inline-flex", "grid", "inline-grid", "hidden", "contents",
  "container", "mx-auto",
  // Flex
  "flex-row", "flex-col", "flex-row-reverse", "flex-col-reverse", "flex-wrap", "flex-nowrap",
  "flex-1", "flex-auto", "flex-initial", "flex-none", "grow", "grow-0", "shrink", "shrink-0",
  "items-start", "items-center", "items-end", "items-stretch", "items-baseline",
  "justify-start", "justify-center", "justify-end", "justify-between", "justify-around", "justify-evenly",
  "self-auto", "self-start", "self-center", "self-end", "self-stretch",
  // Grid
  "grid-cols-1", "grid-cols-2", "grid-cols-3", "grid-cols-4", "grid-cols-5", "grid-cols-6", "grid-cols-12",
  "grid-rows-1", "grid-rows-2", "grid-rows-3", "grid-rows-4", "grid-rows-6",
  "col-span-1", "col-span-2", "col-span-3", "col-span-4", "col-span-6", "col-span-12", "col-span-full",
  "gap-0", "gap-1", "gap-2", "gap-3", "gap-4", "gap-5", "gap-6", "gap-8", "gap-10", "gap-12",
  "gap-x-1", "gap-x-2", "gap-x-4", "gap-x-6", "gap-x-8",
  "gap-y-1", "gap-y-2", "gap-y-4", "gap-y-6", "gap-y-8",
  // Spacing
  "p-0", "p-1", "p-2", "p-3", "p-4", "p-5", "p-6", "p-8", "p-10", "p-12", "p-16",
  "px-0", "px-1", "px-2", "px-3", "px-4", "px-5", "px-6", "px-8", "px-10", "px-12",
  "py-0", "py-1", "py-2", "py-3", "py-4", "py-5", "py-6", "py-8", "py-10", "py-12",
  "pt-0", "pt-1", "pt-2", "pt-3", "pt-4", "pt-6", "pt-8",
  "pb-0", "pb-1", "pb-2", "pb-3", "pb-4", "pb-6", "pb-8",
  "pl-0", "pl-1", "pl-2", "pl-3", "pl-4", "pl-6", "pl-8",
  "pr-0", "pr-1", "pr-2", "pr-3", "pr-4", "pr-6", "pr-8",
  "m-0", "m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-8", "m-auto",
  "mx-0", "mx-1", "mx-2", "mx-3", "mx-4", "mx-6", "mx-8", "mx-auto",
  "my-0", "my-1", "my-2", "my-3", "my-4", "my-6", "my-8", "my-auto",
  "mt-0", "mt-1", "mt-2", "mt-3", "mt-4", "mt-6", "mt-8", "mt-auto",
  "mb-0", "mb-1", "mb-2", "mb-3", "mb-4", "mb-6", "mb-8",
  "ml-0", "ml-1", "ml-2", "ml-3", "ml-4", "ml-6", "ml-8", "ml-auto",
  "mr-0", "mr-1", "mr-2", "mr-3", "mr-4", "mr-6", "mr-8",
  "space-x-1", "space-x-2", "space-x-3", "space-x-4", "space-x-6", "space-x-8",
  "space-y-1", "space-y-2", "space-y-3", "space-y-4", "space-y-6", "space-y-8",
  // Sizing
  "w-0", "w-1", "w-2", "w-3", "w-4", "w-5", "w-6", "w-8", "w-10", "w-12", "w-16", "w-20", "w-24", "w-32", "w-40", "w-48", "w-56", "w-64",
  "w-full", "w-screen", "w-auto", "w-1/2", "w-1/3", "w-2/3", "w-1/4", "w-3/4", "w-fit", "w-min", "w-max",
  "h-0", "h-1", "h-2", "h-3", "h-4", "h-5", "h-6", "h-8", "h-10", "h-12", "h-16", "h-20", "h-24", "h-32", "h-40", "h-48", "h-56", "h-64",
  "h-full", "h-screen", "h-auto", "h-fit", "h-min", "h-max",
  "min-w-0", "min-w-full", "min-w-min", "min-w-max",
  "min-h-0", "min-h-full", "min-h-screen",
  "max-w-xs", "max-w-sm", "max-w-md", "max-w-lg", "max-w-xl", "max-w-2xl", "max-w-3xl", "max-w-4xl", "max-w-5xl", "max-w-6xl", "max-w-7xl", "max-w-full", "max-w-none",
  // Typography
  "text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl", "text-5xl",
  "font-thin", "font-light", "font-normal", "font-medium", "font-semibold", "font-bold", "font-extrabold",
  "italic", "not-italic",
  "text-left", "text-center", "text-right", "text-justify",
  "underline", "line-through", "no-underline",
  "uppercase", "lowercase", "capitalize", "normal-case",
  "leading-none", "leading-tight", "leading-normal", "leading-relaxed", "leading-loose",
  "tracking-tighter", "tracking-tight", "tracking-normal", "tracking-wide", "tracking-wider", "tracking-widest",
  "truncate", "text-ellipsis", "text-clip",
  "whitespace-normal", "whitespace-nowrap", "whitespace-pre", "whitespace-pre-line", "whitespace-pre-wrap",
  "break-words", "break-all",
  // Colors
  "text-white", "text-black", "text-transparent",
  "text-gray-50", "text-gray-100", "text-gray-200", "text-gray-300", "text-gray-400", "text-gray-500", "text-gray-600", "text-gray-700", "text-gray-800", "text-gray-900",
  "text-red-500", "text-red-600", "text-red-700",
  "text-blue-500", "text-blue-600", "text-blue-700",
  "text-green-500", "text-green-600", "text-green-700",
  "text-yellow-500", "text-yellow-600",
  "text-indigo-500", "text-indigo-600",
  "text-purple-500", "text-purple-600",
  "text-pink-500", "text-pink-600",
  "bg-white", "bg-black", "bg-transparent",
  "bg-gray-50", "bg-gray-100", "bg-gray-200", "bg-gray-300", "bg-gray-400", "bg-gray-500", "bg-gray-600", "bg-gray-700", "bg-gray-800", "bg-gray-900",
  "bg-red-50", "bg-red-100", "bg-red-500", "bg-red-600", "bg-red-700",
  "bg-blue-50", "bg-blue-100", "bg-blue-500", "bg-blue-600", "bg-blue-700",
  "bg-green-50", "bg-green-100", "bg-green-500", "bg-green-600", "bg-green-700",
  "bg-yellow-50", "bg-yellow-100", "bg-yellow-500",
  "bg-indigo-50", "bg-indigo-100", "bg-indigo-500", "bg-indigo-600",
  "bg-purple-50", "bg-purple-100", "bg-purple-500", "bg-purple-600",
  // Borders
  "border", "border-0", "border-2", "border-4", "border-8",
  "border-t", "border-b", "border-l", "border-r",
  "border-solid", "border-dashed", "border-dotted", "border-none",
  "border-gray-200", "border-gray-300", "border-gray-400", "border-gray-500",
  "border-red-500", "border-blue-500", "border-green-500",
  "border-transparent", "border-white", "border-black",
  "rounded", "rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-2xl", "rounded-3xl", "rounded-full", "rounded-none",
  "rounded-t", "rounded-b", "rounded-l", "rounded-r",
  "rounded-tl", "rounded-tr", "rounded-bl", "rounded-br",
  // Effects
  "shadow-sm", "shadow", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl", "shadow-inner", "shadow-none",
  "opacity-0", "opacity-25", "opacity-50", "opacity-75", "opacity-100",
  "ring-0", "ring-1", "ring-2", "ring-4", "ring-8", "ring-inset",
  "ring-gray-300", "ring-blue-500",
  // Backgrounds
  "bg-gradient-to-t", "bg-gradient-to-b", "bg-gradient-to-l", "bg-gradient-to-r", "bg-gradient-to-tl", "bg-gradient-to-tr", "bg-gradient-to-bl", "bg-gradient-to-br",
  "from-blue-500", "from-purple-500", "from-green-500", "from-red-500",
  "to-blue-500", "to-purple-500", "to-green-500", "to-red-500",
  "via-blue-500", "via-purple-500",
  // Position
  "static", "fixed", "absolute", "relative", "sticky",
  "top-0", "top-1", "top-2", "top-4", "top-8", "top-auto",
  "bottom-0", "bottom-1", "bottom-2", "bottom-4", "bottom-auto",
  "left-0", "left-1", "left-2", "left-4", "left-auto",
  "right-0", "right-1", "right-2", "right-4", "right-auto",
  "inset-0", "inset-x-0", "inset-y-0",
  "z-0", "z-10", "z-20", "z-30", "z-40", "z-50", "z-auto",
  // Overflow
  "overflow-auto", "overflow-hidden", "overflow-visible", "overflow-scroll",
  "overflow-x-auto", "overflow-x-hidden", "overflow-y-auto", "overflow-y-hidden",
  // Transform
  "scale-0", "scale-50", "scale-75", "scale-90", "scale-95", "scale-100", "scale-105", "scale-110", "scale-125", "scale-150",
  "rotate-0", "rotate-1", "rotate-2", "rotate-3", "rotate-6", "rotate-12", "rotate-45", "rotate-90", "rotate-180",
  "translate-x-0", "translate-x-1", "translate-x-2", "translate-x-4",
  "translate-y-0", "translate-y-1", "translate-y-2", "translate-y-4",
  // Transitions
  "transition", "transition-all", "transition-colors", "transition-opacity", "transition-shadow", "transition-transform", "transition-none",
  "duration-75", "duration-100", "duration-150", "duration-200", "duration-300", "duration-500", "duration-700",
  "ease-linear", "ease-in", "ease-out", "ease-in-out",
  "delay-75", "delay-100", "delay-150", "delay-200", "delay-300",
  // Cursor
  "cursor-auto", "cursor-default", "cursor-pointer", "cursor-wait", "cursor-text", "cursor-move", "cursor-not-allowed",
  // Pointer events
  "pointer-events-none", "pointer-events-auto",
  // Select
  "select-none", "select-text", "select-all", "select-auto",
  // Responsive prefixes (added as completions)
  "sm:", "md:", "lg:", "xl:", "2xl:",
  // State prefixes
  "hover:", "focus:", "active:", "disabled:", "group-hover:", "dark:",
];

/**
 * Check if cursor is inside a class/className attribute value
 */
function isInClassAttribute(session: ace.Ace.EditSession, row: number, col: number): boolean {
  const line = session.getLine(row).substring(0, col);
  // Match class="...", className="...", className={`...`, className={'...
  // Look backwards for an unclosed class attribute
  const classMatch = line.match(/(?:class|className)\s*=\s*(?:{[`'"]|["'])[^"'`]*$/);
  return !!classMatch;
}

/**
 * Extract the partial class name being typed (word at cursor)
 */
function getPartialClass(session: ace.Ace.EditSession, row: number, col: number): string {
  const line = session.getLine(row).substring(0, col);
  const match = line.match(/([\w:/-]*)$/);
  return match ? match[1] : "";
}

/**
 * Create an Ace completer for Tailwind CSS classes
 */
export function createTailwindCompleter(): ace.Ace.Completer {
  return {
    identifierRegexps: [/[\w:/-]/],
    getCompletions(
      _editor: ace.Ace.Editor,
      session: ace.Ace.EditSession,
      pos: ace.Ace.Point,
      _prefix: string,
      callback: ace.Ace.CompleterCallback
    ) {
      if (!enabled) { callback(null, []); return; }

      const mode = session.getMode() as any;
      const modeName: string = mode?.$id || "";
      // Only in HTML, JSX, TSX modes
      if (
        !modeName.includes("html") &&
        !modeName.includes("jsx") &&
        !modeName.includes("tsx")
      ) {
        callback(null, []);
        return;
      }

      if (!isInClassAttribute(session, pos.row, pos.column)) {
        callback(null, []);
        return;
      }

      const partial = getPartialClass(session, pos.row, pos.column);

      const results = TW_CLASSES
        .filter((c) => !partial || c.startsWith(partial) || c.includes(partial))
        .slice(0, 50)
        .map((c) => ({
          caption: c,
          value: c,
          score: c.startsWith(partial) ? 1000 : 500,
          meta: "tailwind",
        }));

      callback(null, results);
    },
  } as ace.Ace.Completer;
}
