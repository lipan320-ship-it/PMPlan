import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = process.cwd();
const packageLock = JSON.parse(
  await readFile(join(repositoryRoot, "package-lock.json"), "utf8"),
);
const npmPackages = Object.entries(packageLock.packages)
  .filter(([path]) => path.startsWith("node_modules/"))
  .map(([path, metadata]) => ({
    ecosystem: "npm",
    name: path.replace(/^node_modules\//, ""),
    version: metadata.version ?? "unknown",
    license: metadata.license ?? "UNKNOWN",
  }));

const cargoPath = join(
  process.env.USERPROFILE ?? "",
  ".cargo",
  "bin",
  "cargo.exe",
);
const cargoMetadata = JSON.parse(
  execFileSync(
    cargoPath,
    [
      "metadata",
      "--locked",
      "--offline",
      "--format-version",
      "1",
      "--filter-platform",
      "x86_64-pc-windows-msvc",
      "--manifest-path",
      join(repositoryRoot, "src-tauri", "Cargo.toml"),
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  ),
);
const cargoPackages = cargoMetadata.packages
  .filter((metadata) => metadata.name !== "pmplan")
  .map((metadata) => ({
    ecosystem: "Cargo",
    name: metadata.name,
    version: metadata.version,
    license: metadata.license ?? "UNKNOWN",
  }));

const packages = [...npmPackages, ...cargoPackages].sort((left, right) =>
  `${left.ecosystem}:${left.name}:${left.version}`.localeCompare(
    `${right.ecosystem}:${right.name}:${right.version}`,
  ),
);
const unknown = packages.filter((entry) => entry.license === "UNKNOWN");
const lines = [
  "# 第三方依赖许可清单",
  "",
  "> 本文件由 `npm run licenses:generate` 根据锁文件生成。发布前应重新生成并审查 `UNKNOWN` 条目。",
  "",
  `- 生成日期：${new Date().toISOString().slice(0, 10)}`,
  `- npm/Cargo 依赖条目：${packages.length}`,
  `- 未声明许可条目：${unknown.length}`,
  "",
  "该清单记录依赖包声明的 SPDX 或许可文本标识，不改变各依赖自己的许可条款。完整条款以对应依赖包随附的 LICENSE 文件和上游发布内容为准。",
  "",
  "| 生态 | 包 | 版本 | 声明许可 |",
  "| --- | --- | --- | --- |",
  ...packages.map(
    (entry) =>
      `| ${entry.ecosystem} | ${entry.name.replaceAll("|", "\\|")} | ${entry.version} | ${entry.license.replaceAll("|", "\\|")} |`,
  ),
  "",
];

await writeFile(
  join(repositoryRoot, "docs", "third-party-licenses.md"),
  lines.join("\n"),
  "utf8",
);

if (unknown.length > 0) {
  console.error(
    `License inventory contains ${unknown.length} UNKNOWN entries: ${unknown.map((entry) => `${entry.ecosystem}:${entry.name}`).join(", ")}`,
  );
  process.exitCode = 1;
} else {
  console.log(`License inventory generated (${packages.length} entries).`);
}
