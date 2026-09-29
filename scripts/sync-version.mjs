import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const packagePath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");
const tauriPath = resolve(root, "src-tauri/tauri.conf.json");
const cargoPath = resolve(root, "src-tauri/Cargo.toml");
const cargoLockPath = resolve(root, "src-tauri/Cargo.lock");

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const currentVersion = packageJson.version;
const requested = process.argv[2];

function isVersion(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

async function readText(path) {
  return readFile(path, "utf8");
}

const tauriText = await readText(tauriPath);
const cargoText = await readText(cargoPath);
const cargoLockText = await readText(cargoLockPath);
const lockJson = JSON.parse(await readFile(packageLockPath, "utf8"));

const found = {
  package: packageJson.version,
  packageLock: lockJson.version,
  packageLockRoot: lockJson.packages?.[""]?.version,
  tauri: JSON.parse(tauriText).version,
  cargo: cargoText.match(/^version = "([^"]+)"/m)?.[1],
  cargoLock: cargoLockText.match(/name = "pmplan"\r?\nversion = "([^"]+)"/)?.[1],
};

if (requested === "--check") {
  const unique = new Set(Object.values(found));
  if (unique.size !== 1 || [...unique][0] === undefined) {
    console.error("Version mismatch:", found);
    process.exit(1);
  }
  console.log(`Version ${currentVersion} is synchronized.`);
  process.exit(0);
}

let nextVersion = requested;
if (requested === "patch") {
  const [major, minor, patch] = currentVersion.split(".").map(Number);
  nextVersion = `${major}.${minor}.${patch + 1}`;
}
if (!nextVersion || !isVersion(nextVersion)) {
  console.error("Usage: node scripts/sync-version.mjs <major.minor.patch|patch|--check>");
  process.exit(1);
}

packageJson.version = nextVersion;
lockJson.version = nextVersion;
if (lockJson.packages?.[""]) {
  lockJson.packages[""].version = nextVersion;
}

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
await writeFile(packageLockPath, `${JSON.stringify(lockJson, null, 2)}\n`);
await writeFile(
  tauriPath,
  tauriText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${nextVersion}$2`),
);
await writeFile(
  cargoPath,
  cargoText.replace(/^(version = ")[^"]+(")/m, `$1${nextVersion}$2`),
);
await writeFile(
  cargoLockPath,
  cargoLockText.replace(
    /(name = "pmplan"\r?\nversion = ")[^"]+(")/,
    `$1${nextVersion}$2`,
  ),
);

console.log(`Version synchronized to ${nextVersion}.`);
