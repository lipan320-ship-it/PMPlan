import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
]);

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return ignoredDirectories.has(entry.name)
          ? []
          : collectMarkdownFiles(path);
      }

      return extname(entry.name).toLowerCase() === ".md" ? [path] : [];
    }),
  );

  return nested.flat();
}

function validateFormatting(path, content) {
  const errors = [];
  const lines = content.split(/\r?\n/);
  let consecutiveBlankLines = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;

    if (/\s+$/.test(line)) {
      errors.push(`${path}:${lineNumber} 包含行尾空格`);
    }

    if (line.length === 0) {
      consecutiveBlankLines += 1;
      if (consecutiveBlankLines > 1 && index < lines.length - 1) {
        errors.push(`${path}:${lineNumber} 包含连续空行`);
      }
    } else {
      consecutiveBlankLines = 0;
    }
  });

  if (!content.endsWith("\n")) {
    errors.push(`${path} 文件末尾缺少换行`);
  }

  return errors;
}

function validateRelativeLinks(path, content) {
  const errors = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

  for (const match of content.matchAll(linkPattern)) {
    const target = match[1];
    if (/^(https?:\/\/|mailto:|#)/.test(target)) {
      continue;
    }

    const fileTarget = target.split("#")[0];
    if (!fileTarget || fileTarget.startsWith("<")) {
      continue;
    }

    const absoluteTarget = resolve(dirname(path), decodeURI(fileTarget));
    errors.push({ target, absoluteTarget });
  }

  return errors;
}

async function main() {
  const files = await collectMarkdownFiles(root);
  const errors = [];

  for (const absolutePath of files) {
    const displayPath = relative(root, absolutePath).replaceAll("\\", "/");
    const content = await readFile(absolutePath, "utf8");
    errors.push(...validateFormatting(displayPath, content));

    for (const link of validateRelativeLinks(absolutePath, content)) {
      try {
        await readFile(link.absoluteTarget);
      } catch {
        errors.push(`${displayPath} 包含无效本地链接：${link.target}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
    return;
  }

  console.log(`Markdown validation passed (${files.length} files).`);
}

await main();
