// Publishes the npm packages from release binaries:
//   node npm/publish.mjs <version> <dir with bin-<rust target>/x-mcp[.exe]> [--dry-run]
// One package per platform (@el4cteo/x-mcp-<os>-<cpu>) plus the @el4cteo/x-mcp launcher.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [version, dist, ...flags] = process.argv.slice(2);
if (!version || !dist) throw new Error("usage: node npm/publish.mjs <version> <dist> [--dry-run]");
const dry = flags.includes("--dry-run");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "target", "npm");
rmSync(out, { recursive: true, force: true });

const TARGETS = {
  "x86_64-pc-windows-msvc": ["win32", "x64"],
  "aarch64-pc-windows-msvc": ["win32", "arm64"],
  "x86_64-unknown-linux-musl": ["linux", "x64"],
  "aarch64-unknown-linux-musl": ["linux", "arm64"],
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-apple-darwin": ["darwin", "x64"],
};
const main = JSON.parse(readFileSync(path.join(here, "x-mcp", "package.json"), "utf8"));
const publish = (dir) => {
  const provenance = process.env.GITHUB_ACTIONS ? ["--provenance"] : [];
  const args = ["publish", "--access", "public", ...(dry ? ["--dry-run"] : provenance)];
  execFileSync("npm", args, { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
};

for (const [target, [os, cpu]] of Object.entries(TARGETS)) {
  const exe = os === "win32" ? "x-mcp.exe" : "x-mcp";
  const src = path.join(dist, `bin-${target}`, exe);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  const dir = path.join(out, `x-mcp-${os}-${cpu}`);
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  copyFileSync(src, path.join(dir, "bin", exe));
  chmodSync(path.join(dir, "bin", exe), 0o755);
  const pkg = {
    name: `@el4cteo/x-mcp-${os}-${cpu}`,
    version,
    description: `The ${os}-${cpu} binary for @el4cteo/x-mcp.`,
    repository: main.repository,
    license: "MIT",
    os: [os],
    cpu: [cpu],
    files: ["bin"],
  };
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  publish(dir);
}

const dir = path.join(out, "x-mcp");
mkdirSync(path.join(dir, "bin"), { recursive: true });
copyFileSync(path.join(here, "x-mcp", "bin", "x-mcp.js"), path.join(dir, "bin", "x-mcp.js"));
for (const file of ["README.md", "LICENSE", ".env.example"]) copyFileSync(path.join(root, file), path.join(dir, file));
main.version = version;
for (const dep of Object.keys(main.optionalDependencies)) main.optionalDependencies[dep] = version;
writeFileSync(path.join(dir, "package.json"), JSON.stringify(main, null, 2) + "\n");
publish(dir);
