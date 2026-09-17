import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const patterns = [
  { label: "external HTML asset", expression: /(?:src|href)=["']https?:\/\//i },
  { label: "external CSS asset", expression: /(?:url\(|@import\s+)[^;\n]*https?:\/\//i },
  { label: "hard-coded network fetch", expression: /(?:fetch|WebSocket|EventSource)\(\s*["'`]https?:\/\//i },
];

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? collect(path) : [path];
    }),
  );
  return nested.flat();
}

const errors = [];
for (const path of await collect(dist)) {
  if (![".html", ".css", ".js"].includes(extname(path))) {
    continue;
  }
  const content = await readFile(path, "utf8");
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) {
      errors.push(`${relative(root, path)}: ${pattern.label}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Offline asset validation passed (no external runtime resources). ");
}
