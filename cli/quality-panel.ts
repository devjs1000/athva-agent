import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  analyze_quality_project,
  merge_quality_config,
  should_include_quality_file,
  type QualityPackageManifest,
  type QualityPanelConfig,
  type QualitySourceFile,
} from "../src/modules/quality-core.js";

interface ParsedArgs {
  rootPath: string;
  configPath?: string;
  outputPath?: string;
}

async function main() {
  const args = parse_args(process.argv.slice(2));
  const rootPath = resolve(args.rootPath);
  const config = await load_config(args.configPath);
  const resolvedConfig = merge_quality_config(config);
  const files: QualitySourceFile[] = [];
  const packageManifests: QualityPackageManifest[] = [];

  await scan_directory(rootPath, rootPath, resolvedConfig.ignorePaths, files, packageManifests);

  const report = analyze_quality_project({
    rootPath,
    config: resolvedConfig,
    files,
    packageManifests,
  });

  const json = JSON.stringify(report, null, 2);
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath);
    await writeFile(outputPath, json, "utf8");
    process.stdout.write(`${outputPath}\n`);
    return;
  }

  process.stdout.write(`${json}\n`);
}

function parse_args(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    rootPath: ".",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      parsed.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--output") {
      parsed.outputPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) {
      parsed.rootPath = arg;
    }
  }

  return parsed;
}

async function load_config(configPath: string | undefined): Promise<QualityPanelConfig | undefined> {
  if (!configPath) return undefined;
  const raw = await readFile(resolve(configPath), "utf8");
  return JSON.parse(raw) as QualityPanelConfig;
}

async function scan_directory(
  rootPath: string,
  directoryPath: string,
  ignorePaths: string[],
  files: QualitySourceFile[],
  packageManifests: QualityPackageManifest[]
) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const directoryReads: Promise<void>[] = [];
  const fileReads: Promise<void>[] = [];

  entries.forEach((entry) => {
    const absolutePath = join(directoryPath, entry.name);
    const relativePath = normalize_path(relative(rootPath, absolutePath));

    if (entry.isDirectory()) {
      if (should_skip_directory(entry.name, relativePath, ignorePaths)) return;
      directoryReads.push(
        scan_directory(rootPath, absolutePath, ignorePaths, files, packageManifests)
      );
      return;
    }

    if (!entry.isFile()) return;

    if (entry.name === "package.json") {
      fileReads.push(
        readFile(absolutePath, "utf8").then((content) => {
          packageManifests.push({
            path: normalize_path(absolutePath),
            relativePath: relativePath || "package.json",
            content,
          });
        })
      );
      return;
    }

    if (!should_include_quality_file(relativePath, ignorePaths)) return;
    fileReads.push(
      readFile(absolutePath, "utf8").then((content) => {
        files.push({
          path: normalize_path(absolutePath),
          relativePath,
          content,
        });
      })
    );
  });

  await Promise.all(fileReads);
  await Promise.all(directoryReads);
}

function should_skip_directory(name: string, relativePath: string, ignorePaths: string[]): boolean {
  if (name.startsWith(".")) return true;
  if (["node_modules", "dist", "dist-cli", "build", "coverage", "target", "__pycache__"].includes(name)) {
    return true;
  }
  return ignorePaths.some((value) => {
    const normalized = normalize_path(value).replace(/^\/+/, "");
    return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
  });
}

function normalize_path(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown CLI error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
