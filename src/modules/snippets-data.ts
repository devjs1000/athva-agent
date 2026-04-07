// Language-specific code snippets for quick insertion

export interface Snippet {
  prefix: string;
  label: string;
  body: string;
  description: string;
}

export interface SnippetCategory {
  id: string;
  label: string;
  icon: string; // SVG path
  snippets: Snippet[];
}

const TS_SNIPPETS: Snippet[] = [
  { prefix: "fn", label: "Function", body: "function ${1:name}(${2:params}): ${3:void} {\n  $0\n}", description: "Typed function" },
  { prefix: "afn", label: "Arrow Function", body: "const ${1:name} = (${2:params}): ${3:void} => {\n  $0\n};", description: "Typed arrow function" },
  { prefix: "iface", label: "Interface", body: "interface ${1:Name} {\n  ${2:key}: ${3:type};\n}", description: "Interface declaration" },
  { prefix: "type", label: "Type Alias", body: "type ${1:Name} = ${2:string};", description: "Type alias" },
  { prefix: "enum", label: "Enum", body: "enum ${1:Name} {\n  ${2:Value},\n}", description: "Enum declaration" },
  { prefix: "class", label: "Class", body: "class ${1:Name} {\n  constructor(${2:params}) {\n    $0\n  }\n}", description: "Class with constructor" },
  { prefix: "generic", label: "Generic Function", body: "function ${1:name}<${2:T}>(${3:arg}: ${2:T}): ${2:T} {\n  return $0;\n}", description: "Generic function" },
  { prefix: "trycatch", label: "Try/Catch", body: "try {\n  $0\n} catch (error: unknown) {\n  const msg = error instanceof Error ? error.message : String(error);\n  console.error(msg);\n}", description: "Try/catch with typed error" },
  { prefix: "promise", label: "Promise", body: "new Promise<${1:void}>((resolve, reject) => {\n  $0\n});", description: "Typed promise" },
  { prefix: "readonly", label: "Readonly Type", body: "Readonly<${1:Type}>", description: "Readonly wrapper" },
  { prefix: "partial", label: "Partial Type", body: "Partial<${1:Type}>", description: "Partial wrapper" },
  { prefix: "record", label: "Record Type", body: "Record<${1:string}, ${2:unknown}>", description: "Record type" },
];

const JS_SNIPPETS: Snippet[] = [
  { prefix: "fn", label: "Function", body: "function ${1:name}(${2:params}) {\n  $0\n}", description: "Function declaration" },
  { prefix: "afn", label: "Arrow Function", body: "const ${1:name} = (${2:params}) => {\n  $0\n};", description: "Arrow function" },
  { prefix: "class", label: "Class", body: "class ${1:Name} {\n  constructor(${2:params}) {\n    $0\n  }\n}", description: "ES6 class" },
  { prefix: "for", label: "For Loop", body: "for (let ${1:i} = 0; ${1:i} < ${2:arr}.length; ${1:i}++) {\n  $0\n}", description: "For loop" },
  { prefix: "forof", label: "For...of", body: "for (const ${1:item} of ${2:arr}) {\n  $0\n}", description: "For...of loop" },
  { prefix: "forin", label: "For...in", body: "for (const ${1:key} in ${2:obj}) {\n  $0\n}", description: "For...in loop" },
  { prefix: "map", label: "Array Map", body: "${1:arr}.map((${2:item}) => {\n  return $0;\n})", description: "Array map" },
  { prefix: "filter", label: "Array Filter", body: "${1:arr}.filter((${2:item}) => $0)", description: "Array filter" },
  { prefix: "reduce", label: "Array Reduce", body: "${1:arr}.reduce((${2:acc}, ${3:item}) => {\n  return $0;\n}, ${4:initial})", description: "Array reduce" },
  { prefix: "trycatch", label: "Try/Catch", body: "try {\n  $0\n} catch (error) {\n  console.error(error);\n}", description: "Try/catch block" },
  { prefix: "promise", label: "Promise", body: "new Promise((resolve, reject) => {\n  $0\n});", description: "Promise constructor" },
  { prefix: "async", label: "Async Function", body: "async function ${1:name}(${2:params}) {\n  $0\n}", description: "Async function" },
  { prefix: "fetch", label: "Fetch Request", body: "const res = await fetch('${1:url}');\nconst data = await res.json();", description: "Fetch API call" },
  { prefix: "iife", label: "IIFE", body: "(() => {\n  $0\n})();", description: "Immediately invoked function" },
  { prefix: "destruct", label: "Destructure", body: "const { ${1:key} } = ${2:obj};", description: "Object destructuring" },
  { prefix: "switch", label: "Switch", body: "switch (${1:key}) {\n  case ${2:value}:\n    $0\n    break;\n  default:\n    break;\n}", description: "Switch statement" },
];

const HTML_SNIPPETS: Snippet[] = [
  { prefix: "html5", label: "HTML5 Boilerplate", body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n  <title>${1:Document}</title>\n</head>\n<body>\n  $0\n</body>\n</html>', description: "Full HTML5 template" },
  { prefix: "div", label: "Div", body: '<div class="${1:name}">\n  $0\n</div>', description: "Div with class" },
  { prefix: "link", label: "CSS Link", body: '<link rel="stylesheet" href="${1:style.css}" />', description: "Stylesheet link" },
  { prefix: "script", label: "Script Tag", body: '<script src="${1:main.js}"></script>', description: "Script tag" },
  { prefix: "meta", label: "Meta Tag", body: '<meta name="${1:name}" content="${2:content}" />', description: "Meta tag" },
  { prefix: "a", label: "Anchor", body: '<a href="${1:#}">${2:Link}</a>', description: "Anchor link" },
  { prefix: "img", label: "Image", body: '<img src="${1:src}" alt="${2:alt}" />', description: "Image tag" },
  { prefix: "input", label: "Input", body: '<input type="${1:text}" id="${2:id}" name="${3:name}" placeholder="${4:placeholder}" />', description: "Input field" },
  { prefix: "form", label: "Form", body: '<form action="${1:#}" method="${2:post}">\n  $0\n  <button type="submit">Submit</button>\n</form>', description: "Form element" },
  { prefix: "ul", label: "Unordered List", body: "<ul>\n  <li>${1:item}</li>\n  <li>${2:item}</li>\n</ul>", description: "UL list" },
  { prefix: "table", label: "Table", body: "<table>\n  <thead>\n    <tr>\n      <th>${1:Header}</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <td>${2:Data}</td>\n    </tr>\n  </tbody>\n</table>", description: "Table structure" },
  { prefix: "section", label: "Section", body: '<section id="${1:name}">\n  <h2>${2:Title}</h2>\n  $0\n</section>', description: "Section with heading" },
];

const CSS_SNIPPETS: Snippet[] = [
  { prefix: "flex", label: "Flexbox Center", body: "display: flex;\nalign-items: center;\njustify-content: center;", description: "Flex center" },
  { prefix: "grid", label: "CSS Grid", body: "display: grid;\ngrid-template-columns: repeat(${1:3}, 1fr);\ngap: ${2:16px};", description: "Grid layout" },
  { prefix: "media", label: "Media Query", body: "@media (max-width: ${1:768px}) {\n  $0\n}", description: "Media query" },
  { prefix: "var", label: "CSS Variable", body: "--${1:name}: ${2:value};", description: "CSS custom property" },
  { prefix: "transition", label: "Transition", body: "transition: ${1:all} ${2:0.2s} ${3:ease};", description: "CSS transition" },
  { prefix: "animation", label: "Keyframes", body: "@keyframes ${1:name} {\n  from { $0 }\n  to { }\n}", description: "Keyframe animation" },
  { prefix: "shadow", label: "Box Shadow", body: "box-shadow: ${1:0} ${2:2px} ${3:8px} rgba(0, 0, 0, ${4:0.15});", description: "Box shadow" },
  { prefix: "reset", label: "Box Reset", body: "margin: 0;\npadding: 0;\nbox-sizing: border-box;", description: "Reset box model" },
  { prefix: "truncate", label: "Text Truncate", body: "white-space: nowrap;\noverflow: hidden;\ntext-overflow: ellipsis;", description: "Truncate text" },
  { prefix: "abs-center", label: "Absolute Center", body: "position: absolute;\ntop: 50%;\nleft: 50%;\ntransform: translate(-50%, -50%);", description: "Absolute center" },
  { prefix: "glass", label: "Glassmorphism", body: "background: rgba(255, 255, 255, 0.1);\nbackdrop-filter: blur(10px);\n-webkit-backdrop-filter: blur(10px);\nborder: 1px solid rgba(255, 255, 255, 0.15);\nborder-radius: 12px;", description: "Glass effect" },
];

const REACT_SNIPPETS: Snippet[] = [
  { prefix: "rfc", label: "Functional Component", body: 'export default function ${1:Component}() {\n  return (\n    <div>\n      $0\n    </div>\n  );\n}', description: "React functional component" },
  { prefix: "rafce", label: "Arrow Component (export)", body: 'const ${1:Component} = () => {\n  return (\n    <div>\n      $0\n    </div>\n  );\n};\n\nexport default ${1:Component};', description: "Arrow component with export" },
  { prefix: "useState", label: "useState Hook", body: "const [${1:state}, set${2:State}] = useState(${3:initial});", description: "useState hook" },
  { prefix: "useEffect", label: "useEffect Hook", body: "useEffect(() => {\n  $0\n\n  return () => {};\n}, [${1:deps}]);", description: "useEffect with cleanup" },
  { prefix: "useRef", label: "useRef Hook", body: "const ${1:ref} = useRef<${2:HTMLDivElement}>(null);", description: "useRef hook" },
  { prefix: "useMemo", label: "useMemo Hook", body: "const ${1:value} = useMemo(() => {\n  return $0;\n}, [${2:deps}]);", description: "useMemo hook" },
  { prefix: "useCallback", label: "useCallback Hook", body: "const ${1:fn} = useCallback((${2:params}) => {\n  $0\n}, [${3:deps}]);", description: "useCallback hook" },
  { prefix: "context", label: "Context + Provider", body: 'import { createContext, useContext } from "react";\n\nconst ${1:Name}Context = createContext<${2:Type} | null>(null);\n\nexport function use${1:Name}() {\n  const ctx = useContext(${1:Name}Context);\n  if (!ctx) throw new Error("use${1:Name} must be inside provider");\n  return ctx;\n}', description: "Context with hook" },
  { prefix: "children", label: "Props with Children", body: "interface ${1:Props} {\n  children: React.ReactNode;\n}", description: "Children prop type" },
];

const PYTHON_SNIPPETS: Snippet[] = [
  { prefix: "def", label: "Function", body: "def ${1:name}(${2:params}):\n    $0", description: "Function definition" },
  { prefix: "class", label: "Class", body: "class ${1:Name}:\n    def __init__(self${2:, params}):\n        $0", description: "Class with init" },
  { prefix: "if", label: "If/Else", body: 'if ${1:condition}:\n    $0\nelse:\n    pass', description: "If/else block" },
  { prefix: "for", label: "For Loop", body: "for ${1:item} in ${2:iterable}:\n    $0", description: "For loop" },
  { prefix: "with", label: "With (Context Manager)", body: 'with open("${1:file}", "${2:r}") as ${3:f}:\n    $0', description: "Context manager" },
  { prefix: "try", label: "Try/Except", body: "try:\n    $0\nexcept ${1:Exception} as e:\n    print(e)", description: "Try/except block" },
  { prefix: "main", label: "Main Guard", body: 'if __name__ == "__main__":\n    $0', description: "Main entry guard" },
  { prefix: "list", label: "List Comprehension", body: "[${1:x} for ${1:x} in ${2:iterable} if ${3:condition}]", description: "List comprehension" },
  { prefix: "lambda", label: "Lambda", body: "lambda ${1:x}: ${2:x + 1}", description: "Lambda function" },
  { prefix: "dataclass", label: "Dataclass", body: 'from dataclasses import dataclass\n\n@dataclass\nclass ${1:Name}:\n    ${2:field}: ${3:str}', description: "Dataclass" },
];

// SVG path data for icons (16x16 viewBox)
const ICONS = {
  ts: '<path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2zm7.5 4.5V14h1V6.5h3V5.5h-7v1h3z" fill="#3178c6"/>',
  js: '<path d="M0 2a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2z" fill="#f0db4f"/><text x="8" y="12" text-anchor="middle" fill="#323330" font-size="8" font-weight="700">JS</text>',
  html: '<path d="M1 0l1.275 14.4L8 16l5.725-1.6L15 0H1zm11.2 4.6H5.2l.2 2.2h6.6l-.6 6.4L8 14.4l-3.4-1.2-.2-2.8h2.2l.1 1.4 1.3.4 1.3-.4.1-2.2H4.8L4.2 3.4h7.6l-.6 1.2z" fill="#e44d26"/>',
  css: '<path d="M1 0l1.275 14.4L8 16l5.725-1.6L15 0H1zm11 5.2H5.8l.2 2h5.8l-.6 6.2L8 14.4l-3.2-1-.2-2.6h2l.1 1.3 1.3.4 1.3-.4.2-2H4.6l-.4-5.4h7.6L11.6 5.2z" fill="#264de4"/>',
  react: '<circle cx="8" cy="8" r="1.5" fill="#61dafb"/><ellipse cx="8" cy="8" rx="7" ry="2.8" fill="none" stroke="#61dafb" stroke-width="0.7"/><ellipse cx="8" cy="8" rx="7" ry="2.8" fill="none" stroke="#61dafb" stroke-width="0.7" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="7" ry="2.8" fill="none" stroke="#61dafb" stroke-width="0.7" transform="rotate(120 8 8)"/>',
  python: '<path d="M8 0C4.8 0 5.1 1.4 5.1 1.4v1.4h3v.5H3.2S0 3 0 6.2s2.8.3 2.8.3h1.7v-1.5s-.1-2.8 2.7-2.8h3.6S13 2.4 13 .3 10.4 0 8 0zM5.8 1a.8.8 0 1 1 0 1.6.8.8 0 0 1 0-1.6z" fill="#3776ab"/><path d="M8 16c3.2 0 2.9-1.4 2.9-1.4v-1.4h-3v-.5h4.9S16 13 16 9.8s-2.8-.3-2.8-.3h-1.7v1.5s.1 2.8-2.7 2.8H5.2S3 13.6 3 15.7 5.6 16 8 16zm2.2-1a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6z" fill="#ffd43b"/>',
};

export const SNIPPET_CATEGORIES: SnippetCategory[] = [
  { id: "typescript", label: "TypeScript", icon: ICONS.ts, snippets: TS_SNIPPETS },
  { id: "javascript", label: "JavaScript", icon: ICONS.js, snippets: JS_SNIPPETS },
  { id: "html", label: "HTML", icon: ICONS.html, snippets: HTML_SNIPPETS },
  { id: "css", label: "CSS", icon: ICONS.css, snippets: CSS_SNIPPETS },
  { id: "react", label: "React / JSX", icon: ICONS.react, snippets: REACT_SNIPPETS },
  { id: "python", label: "Python", icon: ICONS.python, snippets: PYTHON_SNIPPETS },
];
