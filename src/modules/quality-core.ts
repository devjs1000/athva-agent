import ts from "typescript";

export type QualitySeverity = "low" | "medium" | "high";
export type QualityRiskLevel = "low" | "medium" | "high";
export type NamingConventionKey =
  | "camelCase"
  | "snake_case"
  | "PascalCase"
  | "kebab-case"
  | "UPPER_CASE"
  | "unknown";

export interface QualityPanelConfig {
  namingConvention?: Exclude<NamingConventionKey, "UPPER_CASE" | "unknown">;
  fileNamingConvention?: Exclude<NamingConventionKey, "unknown">;
  functionNamingConvention?: Exclude<NamingConventionKey, "unknown">;
  variableNamingConvention?: Exclude<NamingConventionKey, "unknown">;
  classNamingConvention?: Exclude<NamingConventionKey, "unknown">;
  constantNamingConvention?: Exclude<NamingConventionKey, "unknown">;
  complexityThreshold?: number;
  maxFunctionLength?: number;
  ignorePaths?: string[];
}

export interface QualitySourceFile {
  path: string;
  relativePath: string;
  content: string;
}

export interface QualityPackageManifest {
  path: string;
  relativePath: string;
  content: string;
}

export interface QualityViolation {
  type: keyof QualitySections;
  severity: QualitySeverity;
  file: string;
  message: string;
  line?: number;
}

export interface SectionSummary {
  score: number;
  issueCount: number;
}

export interface NamingSection extends SectionSummary {
  filePatterns: Record<string, number>;
  functionPatterns: Record<string, number>;
  variablePatterns: Record<string, number>;
  classPatterns: Record<string, number>;
  constantPatterns: Record<string, number>;
  dominantConvention: string;
  violations: QualityViolation[];
}

export interface ImportsSection extends SectionSummary {
  totalImports: number;
  uniqueExternalPackages: number;
  internalExternalRatio: {
    internal: number;
    external: number;
  };
  unusedImports: number;
  circularDependencies: string[][];
  deepImportChains: number;
  namedExports: number;
  defaultExports: number;
  unusedExports: number;
  reExportChains: number;
  duplicateExports: number;
  violations: QualityViolation[];
}

export interface ComplexitySection extends SectionSummary {
  averageCyclomaticComplexity: number;
  maxCyclomaticComplexity: number;
  averageFunctionLength: number;
  maxFunctionLength: number;
  maxNestingDepth: number;
  fileSizeDistribution: {
    small: number;
    medium: number;
    large: number;
  };
  highComplexityFunctions: number;
  oversizedFunctions: number;
  largeFiles: number;
  violations: QualityViolation[];
}

export interface QualitySection extends SectionSummary {
  duplicateCodeBlocks: number;
  commentDensity: number;
  todoCount: number;
  consoleStatements: number;
  debuggerStatements: number;
  tryCatchCount: number;
  unhandledPromises: number;
  codeSmellDensity: number;
  maintainabilityIndicators: string[];
  violations: QualityViolation[];
}

export interface TypesSection extends SectionSummary {
  applicable: boolean;
  anyUsageCount: number;
  missingTypesCount: number;
  unsafeCasts: number;
  typeCoverage: number;
  violations: QualityViolation[];
}

export interface ArchitectureSection extends SectionSummary {
  dependencyGraph: Record<string, string[]>;
  layerViolations: number;
  moduleBoundaryViolations: number;
  dependencyDirectionViolations: number;
  tightCouplingHotspots: Array<{
    file: string;
    fanIn: number;
    fanOut: number;
  }>;
  violations: QualityViolation[];
}

export interface DependenciesSection extends SectionSummary {
  totalDependencies: number;
  unusedDependencies: string[];
  duplicatePackages: string[];
  versionInconsistencies: Array<{
    packageName: string;
    versions: string[];
  }>;
  outdatedPackagesStatus: "not-scanned-offline";
  violations: QualityViolation[];
}

export interface SecuritySection extends SectionSummary {
  hardcodedSecrets: number;
  unsafePatterns: number;
  missingInputValidation: number;
  vulnerableDependenciesStatus: "not-scanned-offline";
  violations: QualityViolation[];
}

export interface QualitySections {
  naming: NamingSection;
  imports: ImportsSection;
  complexity: ComplexitySection;
  quality: QualitySection;
  types: TypesSection;
  architecture: ArchitectureSection;
  dependencies: DependenciesSection;
  security: SecuritySection;
}

export interface QualityReport {
  generatedAt: string;
  config: Required<QualityPanelConfig>;
  summary: {
    score: number;
    riskLevel: QualityRiskLevel;
    totalFiles: number;
    totalIssues: number;
  };
  sections: QualitySections;
  insights: string[];
  violations: QualityViolation[];
}

export interface QualityAnalysisInput {
  rootPath: string;
  files: QualitySourceFile[];
  packageManifests?: QualityPackageManifest[];
  config?: QualityPanelConfig;
}

export interface QualityRulePlugin {
  key: keyof QualitySections;
  analyze: (context: AnalysisContext) => QualitySections[keyof QualitySections];
}

interface ImportBinding {
  localName: string;
  importedName: string;
  isTypeOnly: boolean;
  line: number;
}

interface ImportRecord {
  moduleName: string;
  line: number;
  isExternal: boolean;
  isDeepImport: boolean;
  bindings: ImportBinding[];
  resolvedInternalPath: string | null;
}

interface ExportRecord {
  name: string;
  kind: "named" | "default";
  line: number;
  source?: string;
  resolvedSourcePath?: string | null;
}

interface FunctionMetric {
  name: string;
  line: number;
  length: number;
  complexity: number;
  maxNestingDepth: number;
  hasValidation: boolean;
  requestAccesses: number;
}

interface PackageManifestData {
  path: string;
  relativePath: string;
  raw: PackageJsonLike | null;
  scripts: string[];
}

interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface ParsedFileData {
  path: string;
  relativePath: string;
  content: string;
  sourceFile: ts.SourceFile;
  lineCount: number;
  commentLines: number;
  todoCount: number;
  consoleStatements: number;
  debuggerStatements: number;
  tryCatchCount: number;
  unhandledPromises: number;
  fileConvention: NamingConventionKey;
  imports: ImportRecord[];
  exports: ExportRecord[];
  usedIdentifiers: Set<string>;
  functionPatterns: NamingConventionKey[];
  variablePatterns: NamingConventionKey[];
  classPatterns: NamingConventionKey[];
  constantPatterns: NamingConventionKey[];
  functionMetrics: FunctionMetric[];
  anyUsageCount: number;
  missingTypesCount: number;
  unsafeCasts: number;
  typedNodes: number;
  totalTypeNodes: number;
  namingViolations: QualityViolation[];
  requestValidationViolations: QualityViolation[];
  securityViolations: QualityViolation[];
}

interface AnalysisContext {
  rootPath: string;
  config: Required<QualityPanelConfig>;
  files: ParsedFileData[];
  packageManifests: PackageManifestData[];
  fileMap: Map<string, ParsedFileData>;
  graph: Map<string, Set<string>>;
  fanInMap: Map<string, number>;
  exportUsage: Map<string, number>;
  importedPackages: Set<string>;
}

const DEFAULT_CONFIG: Required<QualityPanelConfig> = {
  namingConvention: "camelCase",
  fileNamingConvention: "kebab-case",
  functionNamingConvention: "camelCase",
  variableNamingConvention: "camelCase",
  classNamingConvention: "PascalCase",
  constantNamingConvention: "UPPER_CASE",
  complexityThreshold: 10,
  maxFunctionLength: 50,
  ignorePaths: ["node_modules", "dist", "dist-cli", "build", "coverage", "target", ".next", "out"],
};

const SOURCE_FILE_RE = /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i;
const MODULE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const DUPLICATE_WINDOW_SIZE = 5;
const SECTION_WEIGHTS: Record<
  Exclude<keyof QualitySections, "dependencies">,
  number
> = {
  naming: 10,
  imports: 15,
  complexity: 20,
  quality: 15,
  types: 15,
  architecture: 15,
  security: 10,
};

const CONVENTION_ORDER: NamingConventionKey[] = [
  "camelCase",
  "snake_case",
  "PascalCase",
  "kebab-case",
  "UPPER_CASE",
  "unknown",
];

const IGNORE_ENTRY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "dist-cli",
  "build",
  "coverage",
  "target",
  ".next",
  "out",
  "__pycache__",
]);

const REQUEST_TOKENS = ["req", "request", "ctx", "context", "event"];
const VALIDATION_TOKENS = [
  "validate",
  "validator",
  "schema",
  "safeParse",
  "parse",
  "assert",
  "guard",
  "sanitize",
  "zod",
  "joi",
  "yup",
];

const LAYER_ORDER: Record<string, number> = {
  ui: 5,
  service: 4,
  domain: 3,
  data: 2,
  utility: 1,
  unknown: 0,
};

export function merge_quality_config(
  config: QualityPanelConfig | undefined
): Required<QualityPanelConfig> {
  const baseNaming = config?.namingConvention ?? DEFAULT_CONFIG.namingConvention;
  return {
    namingConvention: baseNaming,
    fileNamingConvention: config?.fileNamingConvention ?? DEFAULT_CONFIG.fileNamingConvention,
    functionNamingConvention: config?.functionNamingConvention ?? baseNaming,
    variableNamingConvention: config?.variableNamingConvention ?? baseNaming,
    classNamingConvention: config?.classNamingConvention ?? DEFAULT_CONFIG.classNamingConvention,
    constantNamingConvention: config?.constantNamingConvention ?? DEFAULT_CONFIG.constantNamingConvention,
    complexityThreshold: config?.complexityThreshold ?? DEFAULT_CONFIG.complexityThreshold,
    maxFunctionLength: config?.maxFunctionLength ?? DEFAULT_CONFIG.maxFunctionLength,
    ignorePaths: unique_strings([
      ...DEFAULT_CONFIG.ignorePaths,
      ...(config?.ignorePaths ?? []),
    ]),
  };
}

export function should_include_quality_file(
  relativePath: string,
  ignorePaths: string[]
): boolean {
  const normalized = normalize_path(relativePath);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => IGNORE_ENTRY_NAMES.has(part))) return false;
  if (
    ignorePaths.some((value) => {
      const normalizedIgnore = normalize_path(value).replace(/^\/+/, "");
      return normalized === normalizedIgnore || normalized.startsWith(`${normalizedIgnore}/`);
    })
  ) {
    return false;
  }
  return SOURCE_FILE_RE.test(normalized) && !normalized.endsWith(".min.js");
}

export function analyze_quality_project(
  input: QualityAnalysisInput,
  plugins: QualityRulePlugin[] = default_quality_plugins()
): QualityReport {
  const config = merge_quality_config(input.config);
  const normalizedFiles = input.files
    .map((file) => ({
      path: normalize_path(file.path),
      relativePath: normalize_path(file.relativePath).replace(/^\/+/, ""),
      content: file.content,
    }))
    .filter((file) => should_include_quality_file(file.relativePath, config.ignorePaths));

  const normalizedManifests = (input.packageManifests ?? []).map((manifest) => ({
    path: normalize_path(manifest.path),
    relativePath: normalize_path(manifest.relativePath).replace(/^\/+/, ""),
    content: manifest.content,
  }));

  const fileMap = new Map<string, QualitySourceFile>();
  normalizedFiles.forEach((file) => fileMap.set(file.relativePath, file));

  const parsedFiles = normalizedFiles.map((file) =>
    parse_quality_file(file, fileMap, config)
  );
  const graph = build_dependency_graph(parsedFiles);
  const fanInMap = build_fan_in_map(graph);
  const exportUsage = build_export_usage_map(parsedFiles, fileMap);
  const importedPackages = collect_imported_packages(parsedFiles);
  const packageManifests = normalizedManifests.map(parse_package_manifest);
  const fileDataMap = new Map(parsedFiles.map((file) => [file.relativePath, file]));

  const context: AnalysisContext = {
    rootPath: normalize_path(input.rootPath),
    config,
    files: parsedFiles,
    packageManifests,
    fileMap: fileDataMap,
    graph,
    fanInMap,
    exportUsage,
    importedPackages,
  };

  const sections = plugins.reduce((acc, plugin) => {
    acc[plugin.key] = plugin.analyze(context) as never;
    return acc;
  }, {} as QualitySections);

  const violations = sort_violations(
    (
      Object.values(sections)
        .flatMap((section) => section.violations)
    )
  );

  const summaryScore = calculate_overall_score(sections);
  const report: QualityReport = {
    generatedAt: new Date().toISOString(),
    config,
    summary: {
      score: summaryScore,
      riskLevel: determine_risk_level(summaryScore, violations),
      totalFiles: parsedFiles.length,
      totalIssues: violations.length,
    },
    sections,
    insights: build_insights(sections, violations),
    violations,
  };

  return report;
}

export function default_quality_plugins(): QualityRulePlugin[] {
  return [
    { key: "naming", analyze: analyze_naming_section },
    { key: "imports", analyze: analyze_imports_section },
    { key: "complexity", analyze: analyze_complexity_section },
    { key: "quality", analyze: analyze_quality_section },
    { key: "types", analyze: analyze_types_section },
    { key: "architecture", analyze: analyze_architecture_section },
    { key: "dependencies", analyze: analyze_dependencies_section },
    { key: "security", analyze: analyze_security_section },
  ];
}

function parse_quality_file(
  file: QualitySourceFile,
  fileMap: Map<string, QualitySourceFile>,
  config: Required<QualityPanelConfig>
): ParsedFileData {
  const scriptKind = detect_script_kind(file.relativePath);
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const lineCount = get_line_count(file.content);
  const commentLines = count_comment_lines(file.content);
  const todoCount = count_pattern_matches(file.content, /\b(?:TODO|FIXME|HACK|XXX)\b/g);
  const imports: ImportRecord[] = [];
  const exports: ExportRecord[] = [];
  const usedIdentifiers = new Set<string>();
  const functionPatterns: NamingConventionKey[] = [];
  const variablePatterns: NamingConventionKey[] = [];
  const classPatterns: NamingConventionKey[] = [];
  const constantPatterns: NamingConventionKey[] = [];
  const functionMetrics: FunctionMetric[] = [];
  const requestValidationViolations: QualityViolation[] = [];
  const securityViolations: QualityViolation[] = [];

  let consoleStatements = 0;
  let debuggerStatements = 0;
  let tryCatchCount = 0;
  let unhandledPromises = 0;
  let anyUsageCount = 0;
  let missingTypesCount = 0;
  let unsafeCasts = 0;
  let typedNodes = 0;
  let totalTypeNodes = 0;

  const register_used_identifier = (node: ts.Identifier) => {
    usedIdentifiers.add(node.text);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      imports.push(parse_import_record(node, sourceFile, file.relativePath, fileMap));
      return;
    }

    if (ts.isExportDeclaration(node)) {
      exports.push(...parse_export_declaration(node, sourceFile, file.relativePath, fileMap));
    }

    if (ts.isExportAssignment(node)) {
      exports.push({
        name: "default",
        kind: "default",
        line: get_line_number(sourceFile, node),
      });
    }

    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      functionMetrics.push(build_function_metric(node, sourceFile));
      const name = get_function_name(node);
      if (name) functionPatterns.push(detect_naming_convention(name));
      const validationViolation = inspect_request_validation(node, sourceFile, file.relativePath);
      if (validationViolation) requestValidationViolations.push(validationViolation);
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const isConstant =
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) === ts.NodeFlags.Const;
      if (isConstant) {
        constantPatterns.push(detect_naming_convention(name));
      } else {
        variablePatterns.push(detect_naming_convention(name));
      }
      totalTypeNodes += 1;
      if (node.type) typedNodes += 1;
      if (!node.type && should_require_type(node.initializer)) missingTypesCount += 1;
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      totalTypeNodes += 1;
      if (node.type) typedNodes += 1;
      else if (!node.initializer) missingTypesCount += 1;
    }

    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && !ts.isConstructorDeclaration(node)) {
      totalTypeNodes += 1;
      if ((node as ts.SignatureDeclarationBase).type) typedNodes += 1;
      else if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) missingTypesCount += 1;
    }

    if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      totalTypeNodes += 1;
      if (node.type) typedNodes += 1;
      else if (!node.initializer) missingTypesCount += 1;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      classPatterns.push(detect_naming_convention(node.name.text));
      if (has_export_modifier(node)) {
        exports.push({
          name: node.name.text,
          kind: "named",
          line: get_line_number(sourceFile, node.name),
        });
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name && has_export_modifier(node)) {
      exports.push({
        name: node.name.text,
        kind: "named",
        line: get_line_number(sourceFile, node.name),
      });
    }

    if (ts.isVariableStatement(node) && has_export_modifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          exports.push({
            name: declaration.name.text,
            kind: "named",
            line: get_line_number(sourceFile, declaration.name),
          });
        }
      }
    }

    if (ts.isTypeAliasDeclaration(node) && has_export_modifier(node)) {
      exports.push({
        name: node.name.text,
        kind: "named",
        line: get_line_number(sourceFile, node.name),
      });
    }

    if (ts.isInterfaceDeclaration(node) && has_export_modifier(node)) {
      exports.push({
        name: node.name.text,
        kind: "named",
        line: get_line_number(sourceFile, node.name),
      });
    }

    if (ts.isEnumDeclaration(node) && has_export_modifier(node)) {
      exports.push({
        name: node.name.text,
        kind: "named",
        line: get_line_number(sourceFile, node.name),
      });
    }

    if (ts.isIdentifier(node)) {
      register_used_identifier(node);
    }

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "console") {
      consoleStatements += 1;
    }

    if (ts.isDebuggerStatement(node)) {
      debuggerStatements += 1;
    }

    if (ts.isTryStatement(node)) {
      tryCatchCount += 1;
    }

    if (ts.isExpressionStatement(node) && is_unhandled_promise_expression(node.expression)) {
      unhandledPromises += 1;
    }

    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "Promise") {
      typedNodes += 1;
      totalTypeNodes += 1;
    }

    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      anyUsageCount += 1;
    }

    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      unsafeCasts += inspect_unsafe_cast(node);
      if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword) {
        anyUsageCount += 1;
      }
    }

    const secretViolation = inspect_security_violation(node, sourceFile, file.relativePath);
    if (secretViolation) securityViolations.push(secretViolation);

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const fileConvention = detect_naming_convention(strip_extension(get_basename(file.relativePath)));
  const namingViolations = collect_naming_violations(
    sourceFile,
    file.relativePath,
    fileConvention,
    functionPatterns,
    variablePatterns,
    classPatterns,
    constantPatterns,
    config
  );

  return {
    path: file.path,
    relativePath: file.relativePath,
    content: file.content,
    sourceFile,
    lineCount,
    commentLines,
    todoCount,
    consoleStatements,
    debuggerStatements,
    tryCatchCount,
    unhandledPromises,
    fileConvention,
    imports,
    exports,
    usedIdentifiers,
    functionPatterns,
    variablePatterns,
    classPatterns,
    constantPatterns,
    functionMetrics,
    anyUsageCount,
    missingTypesCount,
    unsafeCasts,
    typedNodes,
    totalTypeNodes,
    namingViolations,
    requestValidationViolations,
    securityViolations,
  };
}

function analyze_naming_section(context: AnalysisContext): NamingSection {
  const filePatterns = count_conventions(context.files.map((file) => file.fileConvention));
  const functionPatterns = count_conventions(context.files.flatMap((file) => file.functionPatterns));
  const variablePatterns = count_conventions(context.files.flatMap((file) => file.variablePatterns));
  const classPatterns = count_conventions(context.files.flatMap((file) => file.classPatterns));
  const constantPatterns = count_conventions(context.files.flatMap((file) => file.constantPatterns));

  const violations: QualityViolation[] = [];
  context.files.forEach((file) => {
    violations.push(...file.namingViolations);
  });

  const fileScore = calculate_convention_score(context.files.map((file) => file.fileConvention), context.config.fileNamingConvention);
  const functionScore = calculate_convention_score(context.files.flatMap((file) => file.functionPatterns), context.config.functionNamingConvention);
  const variableScore = calculate_convention_score(context.files.flatMap((file) => file.variablePatterns), context.config.variableNamingConvention);
  const classScore = calculate_convention_score(context.files.flatMap((file) => file.classPatterns), context.config.classNamingConvention);
  const constantScore = calculate_convention_score(context.files.flatMap((file) => file.constantPatterns), context.config.constantNamingConvention);
  const score = clamp_to_score(
    fileScore * 0.2 +
    functionScore * 0.3 +
    variableScore * 0.2 +
    classScore * 0.15 +
    constantScore * 0.15
  );

  return {
    score,
    issueCount: violations.length,
    filePatterns,
    functionPatterns,
    variablePatterns,
    classPatterns,
    constantPatterns,
    dominantConvention:
      get_dominant_convention(functionPatterns) ||
      get_dominant_convention(variablePatterns) ||
      context.config.functionNamingConvention,
    violations,
  };
}

function analyze_imports_section(context: AnalysisContext): ImportsSection {
  const totalImports = context.files.reduce((sum, file) => sum + file.imports.length, 0);
  const internalImports = context.files.reduce(
    (sum, file) => sum + file.imports.filter((record) => !record.isExternal).length,
    0
  );
  const externalImports = totalImports - internalImports;
  const uniqueExternalPackages = context.importedPackages.size;
  const unusedImports = context.files.reduce(
    (sum, file) => sum + count_unused_imports(file),
    0
  );
  const cycles = detect_cycles(context.graph);
  const deepImportChains = calculate_deep_import_chains(context.graph);
  const namedExports = context.files.reduce(
    (sum, file) => sum + file.exports.filter((record) => record.kind === "named").length,
    0
  );
  const defaultExports = context.files.reduce(
    (sum, file) => sum + file.exports.filter((record) => record.kind === "default").length,
    0
  );
  const duplicateExports = context.files.reduce(
    (sum, file) => sum + count_duplicate_exports(file.exports),
    0
  );
  const reExportChains = context.files.reduce(
    (sum, file) => sum + file.exports.filter((record) => Boolean(record.source)).length,
    0
  );
  const unusedExports = count_unused_exports(context);
  const violations: QualityViolation[] = [];

  context.files.forEach((file) => {
    file.imports.forEach((record) => {
      if (record.isDeepImport) {
        violations.push({
          type: "imports",
          severity: "low",
          file: file.relativePath,
          line: record.line,
          message: `Deep import detected: ${record.moduleName}`,
        });
      }
    });

    const unusedBindings = list_unused_import_bindings(file);
    unusedBindings.forEach((binding) => {
      violations.push({
        type: "imports",
        severity: "medium",
        file: file.relativePath,
        line: binding.line,
        message: `Imported symbol "${binding.localName}" is never used.`,
      });
    });

    const duplicateNames = find_duplicate_export_names(file.exports);
    duplicateNames.forEach((item) => {
      violations.push({
        type: "imports",
        severity: "medium",
        file: file.relativePath,
        line: item.line,
        message: `Duplicate export "${item.name}" detected in the same module.`,
      });
    });
  });

  cycles.forEach((cycle) => {
    const file = cycle[0] ?? "";
    violations.push({
      type: "imports",
      severity: "high",
      file,
      line: 1,
      message: `Circular dependency detected: ${cycle.join(" -> ")}`,
    });
  });

  const unusedExportViolations = build_unused_export_violations(context);
  violations.push(...unusedExportViolations);

  const score = clamp_to_score(
    100 -
      calculate_density_penalty(unusedImports + unusedExports, totalImports + namedExports + defaultExports, 90) -
      cycles.length * 10 -
      duplicateExports * 3 -
      Math.max(0, deepImportChains - 4) * 2
  );

  return {
    score,
    issueCount: violations.length,
    totalImports,
    uniqueExternalPackages,
    internalExternalRatio: {
      internal: internalImports,
      external: externalImports,
    },
    unusedImports,
    circularDependencies: cycles,
    deepImportChains,
    namedExports,
    defaultExports,
    unusedExports,
    reExportChains,
    duplicateExports,
    violations: sort_violations(violations),
  };
}

function analyze_complexity_section(context: AnalysisContext): ComplexitySection {
  const functionMetrics = context.files.flatMap((file) =>
    file.functionMetrics.map((metric) => ({ file: file.relativePath, ...metric }))
  );
  const averageCyclomaticComplexity = average(functionMetrics.map((metric) => metric.complexity));
  const maxCyclomaticComplexity = max_number(functionMetrics.map((metric) => metric.complexity));
  const averageFunctionLength = average(functionMetrics.map((metric) => metric.length));
  const maxFunctionLength = max_number(functionMetrics.map((metric) => metric.length));
  const maxNestingDepth = max_number(functionMetrics.map((metric) => metric.maxNestingDepth));
  const fileSizeDistribution = {
    small: context.files.filter((file) => file.lineCount < 150).length,
    medium: context.files.filter((file) => file.lineCount >= 150 && file.lineCount < 350).length,
    large: context.files.filter((file) => file.lineCount >= 350).length,
  };
  const highComplexityFunctions = functionMetrics.filter(
    (metric) => metric.complexity > context.config.complexityThreshold
  );
  const oversizedFunctions = functionMetrics.filter(
    (metric) => metric.length > context.config.maxFunctionLength
  );
  const largeFiles = context.files.filter((file) => file.lineCount >= 350);
  const violations: QualityViolation[] = [];

  highComplexityFunctions.forEach((metric) => {
    violations.push({
      type: "complexity",
      severity: "high",
      file: metric.file,
      line: metric.line,
      message: `Function "${metric.name}" exceeds complexity threshold (${metric.complexity} > ${context.config.complexityThreshold}).`,
    });
  });

  oversizedFunctions.forEach((metric) => {
    violations.push({
      type: "complexity",
      severity: "medium",
      file: metric.file,
      line: metric.line,
      message: `Function "${metric.name}" exceeds max function length (${metric.length} > ${context.config.maxFunctionLength}).`,
    });
  });

  largeFiles.forEach((file) => {
    violations.push({
      type: "complexity",
      severity: "medium",
      file: file.relativePath,
      line: 1,
      message: `Large file detected (${file.lineCount} lines). Consider splitting this module.`,
    });
  });

  const score = clamp_to_score(
    100 -
      highComplexityFunctions.length * 6 -
      oversizedFunctions.length * 3 -
      Math.max(0, largeFiles.length * 3) -
      Math.max(0, averageCyclomaticComplexity - 4) * 2 -
      calculate_threshold_pressure(functionMetrics.map((metric) => metric.complexity), context.config.complexityThreshold, 22) -
      calculate_threshold_pressure(functionMetrics.map((metric) => metric.length), context.config.maxFunctionLength, 16)
  );

  return {
    score,
    issueCount: violations.length,
    averageCyclomaticComplexity: round_number(averageCyclomaticComplexity),
    maxCyclomaticComplexity,
    averageFunctionLength: round_number(averageFunctionLength),
    maxFunctionLength,
    maxNestingDepth,
    fileSizeDistribution,
    highComplexityFunctions: highComplexityFunctions.length,
    oversizedFunctions: oversizedFunctions.length,
    largeFiles: largeFiles.length,
    violations: sort_violations(violations),
  };
}

function analyze_quality_section(context: AnalysisContext): QualitySection {
  const duplicateBlocks = detect_duplicate_blocks(context.files);
  const duplicateViolations = duplicateBlocks.map<QualityViolation>((block) => ({
    type: "quality",
    severity: "medium",
    file: block.files[0]?.file ?? "",
    line: block.files[0]?.line ?? 1,
    message: `Duplicate code block repeated across ${block.files.length} locations.`,
  }));
  const commentDensity = percentage(
    context.files.reduce((sum, file) => sum + file.commentLines, 0),
    context.files.reduce((sum, file) => sum + file.lineCount, 0)
  );
  const todoCount = context.files.reduce((sum, file) => sum + file.todoCount, 0);
  const consoleStatements = context.files.reduce((sum, file) => sum + file.consoleStatements, 0);
  const debuggerStatements = context.files.reduce((sum, file) => sum + file.debuggerStatements, 0);
  const tryCatchCount = context.files.reduce((sum, file) => sum + file.tryCatchCount, 0);
  const unhandledPromises = context.files.reduce((sum, file) => sum + file.unhandledPromises, 0);
  const violations: QualityViolation[] = [...duplicateViolations];

  context.files.forEach((file) => {
    if (file.todoCount > 0) {
      violations.push({
        type: "quality",
        severity: "low",
        file: file.relativePath,
        line: 1,
        message: `Outstanding TODO/FIXME markers detected (${file.todoCount}).`,
      });
    }

    if (file.consoleStatements > 0) {
      violations.push({
        type: "quality",
        severity: "low",
        file: file.relativePath,
        line: 1,
        message: `Console statements detected (${file.consoleStatements}).`,
      });
    }

    if (file.debuggerStatements > 0) {
      violations.push({
        type: "quality",
        severity: "medium",
        file: file.relativePath,
        line: 1,
        message: `Debugger statements should be removed before shipping.`,
      });
    }

    if (file.unhandledPromises > 0) {
      violations.push({
        type: "quality",
        severity: "medium",
        file: file.relativePath,
        line: 1,
        message: `Potentially unhandled promise chains detected (${file.unhandledPromises}).`,
      });
    }
  });

  const codeSmellDensity = round_number(
    percentage(
      duplicateBlocks.length + todoCount + consoleStatements + debuggerStatements + unhandledPromises,
      Math.max(context.files.length, 1)
    )
  );
  const maintainabilityIndicators = [
    commentDensity < 4 ? "Low comment density around complex code paths." : "Comment density is within a healthy range.",
    todoCount > context.files.length ? "TODO/FIXME churn is starting to accumulate." : "TODO/FIXME debt is contained.",
    unhandledPromises > 0 ? "Async control flow needs more explicit error handling." : "Async calls are mostly handled explicitly.",
  ];
  const score = clamp_to_score(
    100 -
      duplicateBlocks.length * 4 -
      todoCount * 1.5 -
      consoleStatements -
      debuggerStatements * 6 -
      unhandledPromises * 4 +
      (tryCatchCount > 0 ? 2 : 0)
  );

  return {
    score,
    issueCount: violations.length,
    duplicateCodeBlocks: duplicateBlocks.length,
    commentDensity: round_number(commentDensity),
    todoCount,
    consoleStatements,
    debuggerStatements,
    tryCatchCount,
    unhandledPromises,
    codeSmellDensity,
    maintainabilityIndicators,
    violations: sort_violations(violations),
  };
}

function analyze_types_section(context: AnalysisContext): TypesSection {
  const typeFiles = context.files.filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file.relativePath));
  const anyUsageCount = typeFiles.reduce((sum, file) => sum + file.anyUsageCount, 0);
  const missingTypesCount = typeFiles.reduce((sum, file) => sum + file.missingTypesCount, 0);
  const unsafeCasts = typeFiles.reduce((sum, file) => sum + file.unsafeCasts, 0);
  const typedNodes = typeFiles.reduce((sum, file) => sum + file.typedNodes, 0);
  const totalTypeNodes = typeFiles.reduce((sum, file) => sum + file.totalTypeNodes, 0);
  const typeCoverage = round_number(percentage(typedNodes, totalTypeNodes));
  const violations: QualityViolation[] = [];

  typeFiles.forEach((file) => {
    if (file.anyUsageCount > 0) {
      violations.push({
        type: "types",
        severity: "medium",
        file: file.relativePath,
        line: 1,
        message: `Explicit any usage detected (${file.anyUsageCount}).`,
      });
    }

    if (file.missingTypesCount > 0) {
      violations.push({
        type: "types",
        severity: "low",
        file: file.relativePath,
        line: 1,
        message: `Missing type annotations detected (${file.missingTypesCount}).`,
      });
    }

    if (file.unsafeCasts > 0) {
      violations.push({
        type: "types",
        severity: "medium",
        file: file.relativePath,
        line: 1,
        message: `Unsafe type assertions detected (${file.unsafeCasts}).`,
      });
    }
  });

  const score = typeFiles.length === 0
    ? 100
    : clamp_to_score(100 - anyUsageCount * 4 - missingTypesCount * 1.5 - unsafeCasts * 3 - Math.max(0, 85 - typeCoverage));

  return {
    score,
    issueCount: violations.length,
    applicable: typeFiles.length > 0,
    anyUsageCount,
    missingTypesCount,
    unsafeCasts,
    typeCoverage,
    violations: sort_violations(violations),
  };
}

function analyze_architecture_section(context: AnalysisContext): ArchitectureSection {
  const dependencyGraph = Object.fromEntries(
    [...context.graph.entries()].map(([file, imports]) => [file, [...imports].sort()])
  );
  const tightCouplingHotspots = [...context.graph.entries()]
    .map(([file, imports]) => ({
      file,
      fanIn: context.fanInMap.get(file) ?? 0,
      fanOut: imports.size,
    }))
    .filter((item) => item.fanIn >= 5 || item.fanOut >= 6)
    .sort((left, right) => right.fanIn + right.fanOut - (left.fanIn + left.fanOut))
    .slice(0, 10);

  const violations: QualityViolation[] = [];
  let layerViolations = 0;
  let moduleBoundaryViolations = 0;
  let dependencyDirectionViolations = 0;

  context.files.forEach((file) => {
    const sourceLayer = infer_layer(file.relativePath);
    file.imports.forEach((record) => {
      if (!record.resolvedInternalPath) return;
      const targetLayer = infer_layer(record.resolvedInternalPath);

      if (is_layer_violation(sourceLayer, targetLayer)) {
        layerViolations += 1;
        violations.push({
          type: "architecture",
          severity: "high",
          file: file.relativePath,
          line: record.line,
          message: `Layer violation detected: ${sourceLayer} imports ${targetLayer}.`,
        });
      }

      if (LAYER_ORDER[sourceLayer] < LAYER_ORDER[targetLayer] && sourceLayer !== "unknown" && targetLayer !== "unknown") {
        dependencyDirectionViolations += 1;
        violations.push({
          type: "architecture",
          severity: "medium",
          file: file.relativePath,
          line: record.line,
          message: `Dependency direction is inverted for ${record.moduleName}.`,
        });
      }

      const sourceFeature = get_top_level_feature(file.relativePath);
      const targetFeature = get_top_level_feature(record.resolvedInternalPath);
      if (
        sourceFeature &&
        targetFeature &&
        sourceFeature !== targetFeature &&
        count_relative_segments(record.moduleName) >= 2
      ) {
        moduleBoundaryViolations += 1;
        violations.push({
          type: "architecture",
          severity: "low",
          file: file.relativePath,
          line: record.line,
          message: `Module boundary leak: cross-feature deep relative import into "${record.resolvedInternalPath}".`,
        });
      }
    });
  });

  tightCouplingHotspots.forEach((item) => {
    if (item.fanIn + item.fanOut < 14) return;
    violations.push({
      type: "architecture",
      severity: "medium",
      file: item.file,
      line: 1,
      message: `Tight coupling hotspot detected (fan-in ${item.fanIn}, fan-out ${item.fanOut}).`,
    });
  });

  const score = clamp_to_score(
    100 -
      layerViolations * 8 -
      moduleBoundaryViolations * 2 -
      dependencyDirectionViolations * 4 -
      Math.max(0, tightCouplingHotspots.length * 2)
  );

  return {
    score,
    issueCount: violations.length,
    dependencyGraph,
    layerViolations,
    moduleBoundaryViolations,
    dependencyDirectionViolations,
    tightCouplingHotspots,
    violations: sort_violations(violations),
  };
}

function analyze_dependencies_section(context: AnalysisContext): DependenciesSection {
  const declaredPackages = new Map<
    string,
    Array<{ version: string; relativePath: string; group: string }>
  >();
  const duplicatePackages = new Set<string>();
  const unusedDependencies = new Set<string>();
  const violations: QualityViolation[] = [];

  context.packageManifests.forEach((manifest) => {
    if (!manifest.raw) return;
    const groups: Array<[string, Record<string, string> | undefined]> = [
      ["dependencies", manifest.raw.dependencies],
      ["devDependencies", manifest.raw.devDependencies],
      ["peerDependencies", manifest.raw.peerDependencies],
      ["optionalDependencies", manifest.raw.optionalDependencies],
    ];

    const seenInManifest = new Map<string, string>();
    groups.forEach(([groupName, deps]) => {
      Object.entries(deps ?? {}).forEach(([packageName, version]) => {
        const list = declaredPackages.get(packageName) ?? [];
        list.push({ version, relativePath: manifest.relativePath, group: groupName });
        declaredPackages.set(packageName, list);

        if (seenInManifest.has(packageName)) duplicatePackages.add(packageName);
        seenInManifest.set(packageName, groupName);

        const scriptText = manifest.scripts.join(" ");
        const isReferencedByScript = scriptText.includes(packageName);
        if (!context.importedPackages.has(packageName) && !isReferencedByScript && groupName === "dependencies") {
          unusedDependencies.add(packageName);
        }
      });
    });
  });

  const versionInconsistencies = [...declaredPackages.entries()]
    .map(([packageName, uses]) => ({
      packageName,
      versions: unique_strings(uses.map((use) => use.version)),
    }))
    .filter((item) => item.versions.length > 1);

  unusedDependencies.forEach((packageName) => {
    const firstUse = declaredPackages.get(packageName)?.[0];
    violations.push({
      type: "dependencies",
      severity: "low",
      file: firstUse?.relativePath ?? "package.json",
      line: 1,
      message: `Declared dependency "${packageName}" does not appear in imports or scripts.`,
    });
  });

  duplicatePackages.forEach((packageName) => {
    const firstUse = declaredPackages.get(packageName)?.[0];
    violations.push({
      type: "dependencies",
      severity: "medium",
      file: firstUse?.relativePath ?? "package.json",
      line: 1,
      message: `Package "${packageName}" is declared in multiple dependency groups.`,
    });
  });

  versionInconsistencies.forEach((item) => {
    const firstUse = declaredPackages.get(item.packageName)?.[0];
    violations.push({
      type: "dependencies",
      severity: "medium",
      file: firstUse?.relativePath ?? "package.json",
      line: 1,
      message: `Version inconsistency for "${item.packageName}": ${item.versions.join(", ")}.`,
    });
  });

  const totalDependencies = [...declaredPackages.keys()].length;
  const score = clamp_to_score(
    100 - unusedDependencies.size * 2 - duplicatePackages.size * 4 - versionInconsistencies.length * 5
  );

  return {
    score,
    issueCount: violations.length,
    totalDependencies,
    unusedDependencies: [...unusedDependencies].sort(),
    duplicatePackages: [...duplicatePackages].sort(),
    versionInconsistencies,
    outdatedPackagesStatus: "not-scanned-offline",
    violations: sort_violations(violations),
  };
}

function analyze_security_section(context: AnalysisContext): SecuritySection {
  const violations: QualityViolation[] = [];
  let hardcodedSecrets = 0;
  let unsafePatterns = 0;
  let missingInputValidation = 0;

  context.files.forEach((file) => {
    file.securityViolations.forEach((violation) => {
      violations.push({ ...violation, type: "security" });
      if (/secret|token|password|key/i.test(violation.message)) {
        hardcodedSecrets += 1;
      } else {
        unsafePatterns += 1;
      }
    });

    file.requestValidationViolations.forEach((violation) => {
      missingInputValidation += 1;
      violations.push({ ...violation, type: "security" });
    });
  });

  const score = clamp_to_score(
    100 - hardcodedSecrets * 10 - unsafePatterns * 5 - missingInputValidation * 6
  );

  return {
    score,
    issueCount: violations.length,
    hardcodedSecrets,
    unsafePatterns,
    missingInputValidation,
    vulnerableDependenciesStatus: "not-scanned-offline",
    violations: sort_violations(violations),
  };
}

function parse_import_record(
  node: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
  relativePath: string,
  fileMap: Map<string, QualitySourceFile>
): ImportRecord {
  const moduleName = String(node.moduleSpecifier.getText(sourceFile)).slice(1, -1);
  const isExternal = !moduleName.startsWith(".") && !moduleName.startsWith("/");
  const bindings: ImportBinding[] = [];
  const importClause = node.importClause;

  if (importClause?.name) {
    bindings.push({
      localName: importClause.name.text,
      importedName: "default",
      isTypeOnly: importClause.isTypeOnly,
      line: get_line_number(sourceFile, importClause.name),
    });
  }

  if (importClause?.namedBindings) {
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      bindings.push({
        localName: importClause.namedBindings.name.text,
        importedName: "*",
        isTypeOnly: importClause.isTypeOnly,
        line: get_line_number(sourceFile, importClause.namedBindings.name),
      });
    } else {
      importClause.namedBindings.elements.forEach((element) => {
        bindings.push({
          localName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          isTypeOnly: importClause.isTypeOnly || element.isTypeOnly,
          line: get_line_number(sourceFile, element.name),
        });
      });
    }
  }

  return {
    moduleName,
    line: get_line_number(sourceFile, node),
    isExternal,
    isDeepImport: isExternal ? moduleName.split("/").length > (moduleName.startsWith("@") ? 2 : 1) : count_relative_segments(moduleName) >= 2,
    bindings,
    resolvedInternalPath: isExternal ? null : resolve_internal_module(moduleName, relativePath, fileMap),
  };
}

function parse_export_declaration(
  node: ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
  relativePath: string,
  fileMap: Map<string, QualitySourceFile>
): ExportRecord[] {
  const source = node.moduleSpecifier
    ? String(node.moduleSpecifier.getText(sourceFile)).slice(1, -1)
    : undefined;
  const resolvedSourcePath = source && !source.startsWith(".") && !source.startsWith("/")
    ? null
    : source
      ? resolve_internal_module(source, relativePath, fileMap)
      : null;

  if (!node.exportClause) {
    return [
      {
        name: "*",
        kind: "named",
        line: get_line_number(sourceFile, node),
        source,
        resolvedSourcePath,
      },
    ];
  }

  if (ts.isNamespaceExport(node.exportClause)) {
    return [
      {
        name: node.exportClause.name.text,
        kind: "named",
        line: get_line_number(sourceFile, node.exportClause.name),
        source,
        resolvedSourcePath,
      },
    ];
  }

  return node.exportClause.elements.map((element) => ({
    name: element.name.text,
    kind: element.name.text === "default" ? "default" : "named",
    line: get_line_number(sourceFile, element.name),
    source,
    resolvedSourcePath,
  }));
}

function build_function_metric(
  node: ts.FunctionLikeDeclarationBase,
  sourceFile: ts.SourceFile
): FunctionMetric {
  const name = get_function_name(node) ?? "<anonymous>";
  const line = get_line_number(sourceFile, node);
  const length = get_function_length(sourceFile, node);
  const complexity = calculate_cyclomatic_complexity(node);
  const maxNestingDepth = calculate_max_nesting_depth(node);
  const hasValidation = function_uses_validation(node);
  const requestAccesses = count_request_accesses(node);

  return {
    name,
    line,
    length,
    complexity,
    maxNestingDepth,
    hasValidation,
    requestAccesses,
  };
}

function collect_naming_violations(
  sourceFile: ts.SourceFile,
  relativePath: string,
  fileConvention: NamingConventionKey,
  functionPatterns: NamingConventionKey[],
  variablePatterns: NamingConventionKey[],
  classPatterns: NamingConventionKey[],
  constantPatterns: NamingConventionKey[],
  config: Required<QualityPanelConfig>
): QualityViolation[] {
  const violations: QualityViolation[] = [];
  if (fileConvention !== "unknown" && fileConvention !== config.fileNamingConvention) {
    violations.push({
      type: "naming",
      severity: "low",
      file: relativePath,
      line: 1,
      message: `File name does not follow the expected ${config.fileNamingConvention} convention.`,
    });
  }

  if (functionPatterns.some((pattern) => pattern !== "unknown" && pattern !== config.functionNamingConvention)) {
    violations.push({
      type: "naming",
      severity: "low",
      file: relativePath,
      line: 1,
      message: `Function naming is inconsistent with the expected ${config.functionNamingConvention} convention.`,
    });
  }

  if (variablePatterns.some((pattern) => pattern !== "unknown" && pattern !== config.variableNamingConvention)) {
    violations.push({
      type: "naming",
      severity: "low",
      file: relativePath,
      line: 1,
      message: `Variable naming is inconsistent with the expected ${config.variableNamingConvention} convention.`,
    });
  }

  if (classPatterns.some((pattern) => pattern !== "unknown" && pattern !== config.classNamingConvention)) {
    violations.push({
      type: "naming",
      severity: "low",
      file: relativePath,
      line: get_line_number(sourceFile, sourceFile),
      message: `Class naming is inconsistent with the expected ${config.classNamingConvention} convention.`,
    });
  }

  if (constantPatterns.some((pattern) => pattern !== "unknown" && pattern !== config.constantNamingConvention)) {
    violations.push({
      type: "naming",
      severity: "low",
      file: relativePath,
      line: 1,
      message: `Constant naming is inconsistent with the expected ${config.constantNamingConvention} convention.`,
    });
  }

  return violations;
}

function inspect_request_validation(
  node: ts.FunctionLikeDeclarationBase,
  sourceFile: ts.SourceFile,
  relativePath: string
): QualityViolation | null {
  const requestAccesses = count_request_accesses(node);
  if (requestAccesses === 0) return null;
  if (function_uses_validation(node)) return null;

  return {
    type: "security",
    severity: "medium",
    file: relativePath,
    line: get_line_number(sourceFile, node),
    message: "Request input is consumed without an obvious validation or schema check.",
  };
}

function inspect_security_violation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  relativePath: string
): QualityViolation | null {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "eval" || node.expression.text === "Function")
  ) {
    return {
      type: "security",
      severity: "high",
      file: relativePath,
      line: get_line_number(sourceFile, node.expression),
      message: `Unsafe dynamic execution via ${node.expression.text}().`,
    };
  }

  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Function"
  ) {
    return {
      type: "security",
      severity: "high",
      file: relativePath,
      line: get_line_number(sourceFile, node.expression),
      message: "Unsafe dynamic execution via new Function().",
    };
  }

  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "setTimeout" || node.expression.text === "setInterval") &&
    node.arguments.length > 0 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return {
      type: "security",
      severity: "medium",
      file: relativePath,
      line: get_line_number(sourceFile, node.expression),
      message: `${node.expression.text}() is using a string argument for execution.`,
    };
  }

  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(node.left) &&
    node.left.name.text === "innerHTML"
  ) {
    return {
      type: "security",
      severity: "medium",
      file: relativePath,
      line: get_line_number(sourceFile, node.left.name),
      message: "Direct innerHTML assignment can introduce XSS risks.",
    };
  }

  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "dangerouslySetInnerHTML"
  ) {
    return {
      type: "security",
      severity: "medium",
      file: relativePath,
      line: get_line_number(sourceFile, node.name),
      message: "dangerouslySetInnerHTML should be gated by explicit sanitization.",
    };
  }

  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    /(api[_-]?key|secret|token|password)/i.test(node.name.text) &&
    node.initializer &&
    is_hardcoded_secret(node.initializer)
  ) {
    return {
      type: "security",
      severity: "high",
      file: relativePath,
      line: get_line_number(sourceFile, node.name),
      message: `Possible hardcoded secret stored in "${node.name.text}".`,
    };
  }

  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    /(api[_-]?key|secret|token|password)/i.test(node.name.text) &&
    is_hardcoded_secret(node.initializer)
  ) {
    return {
      type: "security",
      severity: "high",
      file: relativePath,
      line: get_line_number(sourceFile, node.name),
      message: `Possible hardcoded secret in object property "${node.name.text}".`,
    };
  }

  return null;
}

function build_dependency_graph(files: ParsedFileData[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  files.forEach((file) => {
    const imports = new Set<string>();
    file.imports.forEach((record) => {
      if (record.resolvedInternalPath) imports.add(record.resolvedInternalPath);
    });
    file.exports.forEach((record) => {
      if (record.resolvedSourcePath) imports.add(record.resolvedSourcePath);
    });
    graph.set(file.relativePath, imports);
  });
  return graph;
}

function build_fan_in_map(graph: Map<string, Set<string>>): Map<string, number> {
  const fanInMap = new Map<string, number>();
  graph.forEach((targets) => {
    targets.forEach((target) => {
      fanInMap.set(target, (fanInMap.get(target) ?? 0) + 1);
    });
  });
  return fanInMap;
}

function build_export_usage_map(
  files: ParsedFileData[],
  fileMap: Map<string, QualitySourceFile>
): Map<string, number> {
  const usage = new Map<string, number>();

  files.forEach((file) => {
    file.imports.forEach((record) => {
      if (!record.resolvedInternalPath) return;
      record.bindings.forEach((binding) => {
        const exportKey = `${record.resolvedInternalPath}:${binding.importedName}`;
        usage.set(exportKey, (usage.get(exportKey) ?? 0) + 1);
        if (binding.importedName === "default") {
          const fallbackKey = `${record.resolvedInternalPath}:default`;
          usage.set(fallbackKey, (usage.get(fallbackKey) ?? 0) + 1);
        }
      });
    });

    file.exports.forEach((record) => {
      if (!record.resolvedSourcePath) return;
      if (!fileMap.has(record.resolvedSourcePath)) return;
      const exportKey = `${record.resolvedSourcePath}:${record.name}`;
      usage.set(exportKey, (usage.get(exportKey) ?? 0) + 1);
    });
  });

  return usage;
}

function collect_imported_packages(files: ParsedFileData[]): Set<string> {
  const packages = new Set<string>();
  files.forEach((file) => {
    file.imports.forEach((record) => {
      if (!record.isExternal) return;
      packages.add(get_package_name(record.moduleName));
    });
  });
  return packages;
}

function count_unused_imports(file: ParsedFileData): number {
  return list_unused_import_bindings(file).length;
}

function list_unused_import_bindings(file: ParsedFileData): ImportBinding[] {
  return file.imports.flatMap((record) =>
    record.bindings.filter((binding) => !binding.isTypeOnly && !file.usedIdentifiers.has(binding.localName))
  );
}

function count_duplicate_exports(exports: ExportRecord[]): number {
  return find_duplicate_export_names(exports).length;
}

function find_duplicate_export_names(exports: ExportRecord[]): Array<{ name: string; line: number }> {
  const counts = new Map<string, number>();
  const duplicates: Array<{ name: string; line: number }> = [];
  exports.forEach((item) => {
    const next = (counts.get(item.name) ?? 0) + 1;
    counts.set(item.name, next);
    if (next === 2) duplicates.push({ name: item.name, line: item.line });
  });
  return duplicates;
}

function count_unused_exports(context: AnalysisContext): number {
  return build_unused_export_violations(context).length;
}

function build_unused_export_violations(context: AnalysisContext): QualityViolation[] {
  const violations: QualityViolation[] = [];

  context.files.forEach((file) => {
    const isEntrypoint = /(?:^|\/)(?:index|main|app)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(file.relativePath);
    file.exports.forEach((record) => {
      if (record.name === "*") return;
      if (isEntrypoint) return;
      const key = `${file.relativePath}:${record.kind === "default" ? "default" : record.name}`;
      if ((context.exportUsage.get(key) ?? 0) > 0) return;
      violations.push({
        type: "imports",
        severity: "low",
        file: file.relativePath,
        line: record.line,
        message: `Export "${record.name}" is not referenced by other internal modules.`,
      });
    });
  });

  return violations;
}

function detect_cycles(graph: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];
  const cycles = new Set<string>();
  const results: string[][] = [];

  const visit = (node: string) => {
    if (stack.has(node)) {
      const start = path.indexOf(node);
      if (start >= 0) {
        const cycle = [...path.slice(start), node];
        const key = cycle.slice().sort().join("|");
        if (!cycles.has(key)) {
          cycles.add(key);
          results.push(cycle);
        }
      }
      return;
    }
    if (seen.has(node)) return;

    seen.add(node);
    stack.add(node);
    path.push(node);

    (graph.get(node) ?? new Set<string>()).forEach((next) => visit(next));

    path.pop();
    stack.delete(node);
  };

  [...graph.keys()].forEach((node) => visit(node));
  return results;
}

function calculate_deep_import_chains(graph: Map<string, Set<string>>): number {
  const memo = new Map<string, number>();

  const depth_from = (node: string, active: Set<string>): number => {
    if (memo.has(node)) return memo.get(node)!;
    if (active.has(node)) return 0;
    active.add(node);
    let best = 1;
    (graph.get(node) ?? new Set<string>()).forEach((next) => {
      best = Math.max(best, 1 + depth_from(next, active));
    });
    active.delete(node);
    memo.set(node, best);
    return best;
  };

  return [...graph.keys()].reduce((best, node) => Math.max(best, depth_from(node, new Set<string>())), 0);
}

function detect_duplicate_blocks(files: ParsedFileData[]): Array<{
  signature: string;
  files: Array<{ file: string; line: number }>;
}> {
  const blockMap = new Map<string, Array<{ file: string; line: number }>>();

  files.forEach((file) => {
    const normalizedLines = file.content
      .split(/\r?\n/)
      .map((line) => normalize_code_line(line))
      .filter((line) => line.length > 0);

    for (let index = 0; index <= normalizedLines.length - DUPLICATE_WINDOW_SIZE; index += 1) {
      const window = normalizedLines.slice(index, index + DUPLICATE_WINDOW_SIZE);
      if (window.some((line) => line.length < 6)) continue;
      const signature = window.join("\n");
      const list = blockMap.get(signature) ?? [];
      list.push({ file: file.relativePath, line: index + 1 });
      blockMap.set(signature, list);
    }
  });

  return [...blockMap.entries()]
    .filter(([, uses]) => unique_strings(uses.map((use) => `${use.file}:${use.line}`)).length > 1)
    .map(([signature, uses]) => ({ signature, files: uses }))
    .sort((left, right) => right.files.length - left.files.length)
    .slice(0, 10);
}

function parse_package_manifest(manifest: QualityPackageManifest): PackageManifestData {
  try {
    const raw = JSON.parse(manifest.content) as PackageJsonLike;
    return {
      path: manifest.path,
      relativePath: manifest.relativePath,
      raw,
      scripts: Object.values(raw.scripts ?? {}),
    };
  } catch {
    return {
      path: manifest.path,
      relativePath: manifest.relativePath,
      raw: null,
      scripts: [],
    };
  }
}

function calculate_overall_score(sections: QualitySections): number {
  let score = 0;
  (Object.entries(SECTION_WEIGHTS) as Array<[Exclude<keyof QualitySections, "dependencies">, number]>).forEach(
    ([key, weight]) => {
      score += (sections[key].score * weight) / 100;
    }
  );
  return clamp_to_score(score);
}

function determine_risk_level(score: number, violations: QualityViolation[]): QualityRiskLevel {
  const highCount = violations.filter((violation) => violation.severity === "high").length;
  if (score < 60 || highCount >= 3) return "high";
  if (score < 80 || highCount > 0 || violations.length > 20) return "medium";
  return "low";
}

function build_insights(sections: QualitySections, violations: QualityViolation[]): string[] {
  const insights: string[] = [];
  const namingIssues = sections.naming.violations.length;
  const unusedExports = sections.imports.unusedExports;
  const highComplexityFunctions = sections.complexity.highComplexityFunctions;
  const cycles = sections.imports.circularDependencies.length;
  const anyUsage = sections.types.anyUsageCount;
  const secrets = sections.security.hardcodedSecrets;

  if (namingIssues > 0) {
    insights.push(`Standardize naming to ${sections.naming.dominantConvention || "camelCase"} (${namingIssues} inconsistencies detected).`);
  }
  if (unusedExports > 0) {
    insights.push(`Remove or collapse ${unusedExports} unused exports to reduce dead code paths.`);
  }
  if (highComplexityFunctions > 0) {
    insights.push(`Refactor ${highComplexityFunctions} high-complexity functions that exceed the configured threshold.`);
  }
  if (cycles > 0) {
    insights.push(`Break ${cycles} circular dependency chains to simplify module initialization and testing.`);
  }
  if (anyUsage > 0) {
    insights.push(`Reduce ${anyUsage} explicit any usages to improve type safety and editor guarantees.`);
  }
  if (secrets > 0) {
    insights.push(`Move ${secrets} possible hardcoded secrets into environment or secret-management boundaries.`);
  }

  if (insights.length === 0 && violations.length === 0) {
    insights.push("Static analysis did not surface significant risks in the scanned files.");
  }

  return insights.slice(0, 8);
}

function detect_script_kind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function get_function_name(node: ts.FunctionLikeDeclarationBase): string | null {
  if ("name" in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  return null;
}

function get_function_length(sourceFile: ts.SourceFile, node: ts.Node): number {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line;
  return end - start + 1;
}

function calculate_cyclomatic_complexity(node: ts.Node): number {
  let complexity = 1;
  const visit = (child: ts.Node) => {
    if (
      ts.isIfStatement(child) ||
      ts.isForStatement(child) ||
      ts.isForInStatement(child) ||
      ts.isForOfStatement(child) ||
      ts.isWhileStatement(child) ||
      ts.isDoStatement(child) ||
      ts.isCaseClause(child) ||
      ts.isConditionalExpression(child) ||
      ts.isCatchClause(child)
    ) {
      complexity += 1;
    }
    if (
      ts.isBinaryExpression(child) &&
      (child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        child.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      complexity += 1;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return complexity;
}

function calculate_max_nesting_depth(node: ts.Node): number {
  let maxDepth = 0;
  const visit = (child: ts.Node, depth: number) => {
    const nextDepth = is_control_structure(child) ? depth + 1 : depth;
    maxDepth = Math.max(maxDepth, nextDepth);
    ts.forEachChild(child, (grandChild) => visit(grandChild, nextDepth));
  };
  ts.forEachChild(node, (child) => visit(child, 0));
  return maxDepth;
}

function is_control_structure(node: ts.Node): boolean {
  return (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node) ||
    ts.isTryStatement(node) ||
    ts.isConditionalExpression(node)
  );
}

function is_unhandled_promise_expression(node: ts.Expression): boolean {
  if (ts.isAwaitExpression(node)) return false;
  if (ts.isCallExpression(node)) {
    const expressionText = node.expression.getText();
    if (/\.catch$/.test(expressionText)) return false;
    if (/\.then$/.test(expressionText)) return true;
    if (ts.isIdentifier(node.expression) && /(?:fetch|request|load|save|create|update|delete|async)$/i.test(node.expression.text)) {
      return true;
    }
    if (ts.isPropertyAccessExpression(node.expression) && /(?:fetch|request|load|save|create|update|delete|async)$/i.test(node.expression.name.text)) {
      return true;
    }
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") {
    return true;
  }
  return false;
}

function inspect_unsafe_cast(node: ts.AsExpression | ts.TypeAssertion): number {
  if (node.type.kind === ts.SyntaxKind.AnyKeyword) return 1;
  if (ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) return 1;
  return 0;
}

function function_uses_validation(node: ts.FunctionLikeDeclarationBase): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    const text = child.getText();
    if (VALIDATION_TOKENS.some((token) => text.includes(token))) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function count_request_accesses(node: ts.FunctionLikeDeclarationBase): number {
  let count = 0;
  const visit = (child: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(child) &&
      ts.isIdentifier(child.expression) &&
      REQUEST_TOKENS.includes(child.expression.text)
    ) {
      if (["body", "query", "params", "headers"].includes(child.name.text)) {
        count += 1;
      }
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return count;
}

function should_require_type(initializer: ts.Expression | undefined): boolean {
  if (!initializer) return true;
  if (initializer.kind === ts.SyntaxKind.NullKeyword) return true;
  if (initializer.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return false;
}

function is_hardcoded_secret(node: ts.Expression): boolean {
  if (ts.isStringLiteralLike(node)) {
    const text = node.text.trim();
    if (text.length < 8) return false;
    if (/^(?:todo|changeme|replace-me|example|sample|test)$/i.test(text)) return false;
    if (/^[A-Za-z0-9/_+=-]{8,}$/.test(text)) return true;
  }
  if (ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.trim().length >= 8;
  }
  return false;
}

function resolve_internal_module(
  moduleName: string,
  relativePath: string,
  fileMap: Map<string, QualitySourceFile>
): string | null {
  const containingDir = dirname(relativePath);
  const resolvedBase = moduleName.startsWith("/")
    ? normalize_path(moduleName).replace(/^\/+/, "")
    : resolve_relative_path(containingDir, moduleName);
  const candidates = [
    resolvedBase,
    ...MODULE_SUFFIXES.map((suffix) => `${resolvedBase}${suffix}`),
    ...MODULE_SUFFIXES.map((suffix) => `${resolvedBase}/index${suffix}`),
  ];

  for (const candidate of candidates) {
    if (fileMap.has(candidate)) return candidate;
  }
  return null;
}

function infer_layer(filePath: string): "ui" | "service" | "domain" | "data" | "utility" | "unknown" {
  const normalized = normalize_path(filePath).toLowerCase();
  if (/(^|\/)(ui|components|pages|views|screens|routes|widgets|presenters)(\/|$)/.test(normalized)) return "ui";
  if (/(^|\/)(services|service|api|controllers|use-cases|usecases|store|stores)(\/|$)/.test(normalized)) return "service";
  if (/(^|\/)(domain|core|entities|models)(\/|$)/.test(normalized)) return "domain";
  if (/(^|\/)(data|db|database|repositories|repository|prisma|infra|infrastructure)(\/|$)/.test(normalized)) return "data";
  if (/(^|\/)(utils|util|helpers|shared|common|lib)(\/|$)/.test(normalized)) return "utility";
  return "unknown";
}

function is_layer_violation(source: string, target: string): boolean {
  if (source === "ui" && target === "data") return true;
  if (source === "domain" && (target === "ui" || target === "service" || target === "data")) return true;
  if (source === "data" && (target === "ui" || target === "service")) return true;
  if (source === "service" && target === "ui") return true;
  return false;
}

function get_top_level_feature(filePath: string): string | null {
  const parts = normalize_path(filePath).split("/").filter(Boolean);
  const srcIndex = parts.indexOf("src");
  const baseIndex = srcIndex >= 0 ? srcIndex + 1 : 0;
  return parts[baseIndex] ?? null;
}

function count_relative_segments(moduleName: string): number {
  return moduleName.split("/").filter((part) => part === "..").length;
}

function detect_naming_convention(name: string): NamingConventionKey {
  if (!name) return "unknown";
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(name)) return "UPPER_CASE";
  if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) return "camelCase";
  if (/^[a-z][a-z0-9]*$/.test(name)) return "camelCase";
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return "snake_case";
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) return "PascalCase";
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(name)) return "kebab-case";
  return "unknown";
}

function calculate_convention_score(
  patterns: NamingConventionKey[],
  expectedConvention: Exclude<NamingConventionKey, "unknown">
): number {
  const knownPatterns = patterns.filter((pattern) => pattern !== "unknown");
  if (knownPatterns.length === 0) return 100;
  const matchingCount = knownPatterns.filter((pattern) => pattern === expectedConvention).length;
  return round_number((matchingCount / knownPatterns.length) * 100);
}

function calculate_threshold_pressure(values: number[], threshold: number, maxPenalty: number): number {
  if (values.length === 0 || threshold <= 0) return 0;
  const normalizedPressure = average(
    values.map((value) => {
      const ratio = value / threshold;
      return Math.max(0, ratio - 0.55);
    })
  );
  return Math.min(maxPenalty, normalizedPressure * maxPenalty);
}

function count_conventions(patterns: NamingConventionKey[]): Record<string, number> {
  const counts = Object.fromEntries(CONVENTION_ORDER.map((name) => [name, 0]));
  patterns.forEach((pattern) => {
    counts[pattern] = (counts[pattern] ?? 0) + 1;
  });
  return counts;
}

function get_dominant_convention(patterns: Record<string, number>): string {
  return Object.entries(patterns)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
}

function normalize_code_line(line: string): string {
  return line
    .replace(/\/\/.*$/g, "")
    .replace(/\/\*.*?\*\//g, "")
    .replace(/["'`][^"'`]*["'`]/g, "\"str\"")
    .replace(/\b\d+\b/g, "0")
    .replace(/\s+/g, " ")
    .trim();
}

function sort_violations(violations: QualityViolation[]): QualityViolation[] {
  const severityOrder: Record<QualitySeverity, number> = { high: 0, medium: 1, low: 2 };
  return violations
    .slice()
    .sort((left, right) => {
      const severityDelta = severityOrder[left.severity] - severityOrder[right.severity];
      if (severityDelta !== 0) return severityDelta;
      const fileDelta = left.file.localeCompare(right.file);
      if (fileDelta !== 0) return fileDelta;
      return (left.line ?? 0) - (right.line ?? 0);
    });
}

function count_comment_lines(content: string): number {
  const ranges: Array<[number, number]> = [];
  const commentRegex = /\/\/.*$|\/\*[\s\S]*?\*\//gm;
  let match: RegExpExecArray | null;
  while ((match = commentRegex.exec(content)) !== null) {
    const start = count_newlines(content.slice(0, match.index)) + 1;
    const end = start + count_newlines(match[0]);
    ranges.push([start, end]);
  }
  const lines = new Set<number>();
  ranges.forEach(([start, end]) => {
    for (let line = start; line <= end; line += 1) lines.add(line);
  });
  return lines.size;
}

function count_pattern_matches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

function count_newlines(content: string): number {
  return (content.match(/\n/g) ?? []).length;
}

function get_line_count(content: string): number {
  if (!content) return 1;
  return content.split(/\r?\n/).length;
}

function has_export_modifier(node: ts.Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);
}

function get_line_number(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function get_package_name(moduleName: string): string {
  if (!moduleName.startsWith("@")) return moduleName.split("/")[0] ?? moduleName;
  const parts = moduleName.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : moduleName;
}

function dirname(filePath: string): string {
  const normalized = normalize_path(filePath);
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/");
}

function resolve_relative_path(baseDir: string, request: string): string {
  const tokens = [...baseDir.split("/").filter(Boolean), ...request.split("/").filter(Boolean)];
  const resolved: string[] = [];
  tokens.forEach((token) => {
    if (token === ".") return;
    if (token === "..") {
      resolved.pop();
      return;
    }
    resolved.push(token);
  });
  return resolved.join("/");
}

function normalize_path(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function get_basename(filePath: string): string {
  return normalize_path(filePath).split("/").pop() ?? filePath;
}

function strip_extension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function unique_strings(values: string[]): string[] {
  return [...new Set(values)];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function max_number(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.max(...values);
}

function round_number(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentage(value: number, total: number): number {
  if (total <= 0) return 0;
  return (value / total) * 100;
}

function clamp_to_score(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function calculate_density_penalty(count: number, total: number, multiplier: number): number {
  if (total <= 0) return count;
  return (count / total) * multiplier;
}
