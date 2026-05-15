import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const packageRoot = process.cwd();
const componentsRoot = path.join(packageRoot, "src/components");

const importRegex =
  /from\s+["'](src\/(?:components|lib|hooks)(?:\/[^"']*)?)["']/g;
const primitiveSelfImportRegex =
  /import\s+\{\s*([A-Za-z0-9_]+)\s+as\s+([A-Za-z0-9_]*Primitive)\s*\}\s+from\s+["']\.\/([a-z0-9-]+)["']/g;

async function collectTsxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const entryStat = await stat(fullPath);

    if (entryStat.isDirectory()) {
      files.push(...(await collectTsxFiles(fullPath)));
      continue;
    }

    if (entry.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeRelativeImport(
  fromFile: string,
  targetFromSrc: string,
): string {
  const absoluteTarget = path.join(packageRoot, targetFromSrc);
  const fromDir = path.dirname(fromFile);
  let relativeImport = path.relative(fromDir, absoluteTarget);

  if (!relativeImport.startsWith(".")) {
    relativeImport = `./${relativeImport}`;
  }

  return relativeImport.replaceAll(path.sep, "/");
}

async function fixFile(filePath: string): Promise<boolean> {
  const before = await readFile(filePath, "utf8");
  const baseName = path.basename(filePath, path.extname(filePath));
  const withPrimitiveFixed = before.replace(
    primitiveSelfImportRegex,
    (
      _full,
      primitiveName: string,
      primitiveAlias: string,
      sourceName: string,
    ) => {
      if (
        sourceName !== baseName &&
        sourceName !== primitiveName.toLowerCase()
      ) {
        return _full;
      }

      return `import { ${primitiveName} as ${primitiveAlias} } from "@base-ui/react/${sourceName}"`;
    },
  );

  const after = withPrimitiveFixed.replace(
    importRegex,
    (full, importPath: string) => {
      const relative = normalizeRelativeImport(filePath, importPath);
      return full.replace(importPath, relative);
    },
  );

  if (after === before) {
    return false;
  }

  await writeFile(filePath, after);
  return true;
}

async function main() {
  const files = await collectTsxFiles(componentsRoot);
  let changed = 0;

  for (const filePath of files) {
    if (await fixFile(filePath)) {
      changed += 1;
    }
  }

  console.log(`fix-shadcn-imports: updated ${changed} file(s)`);
}

void main();
