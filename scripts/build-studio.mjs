import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const studioDir = path.join(distDir, "studio");
const nextBin = path.join(rootDir, "node_modules", "next", "dist", "bin", "next");
const standaloneDir = path.join(rootDir, ".next", "standalone");
const staticDir = path.join(rootDir, ".next", "static");
const publicDir = path.join(rootDir, "public");

function findStandaloneServerPath(searchDir) {
  const entries = readdirSync(searchDir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(searchDir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        continue;
      }

      const nestedServerPath = findStandaloneServerPath(entryPath);

      if (nestedServerPath) {
        return nestedServerPath;
      }

      continue;
    }

    if (entry.isFile() && entry.name === "server.js") {
      return entryPath;
    }
  }

  return null;
}

const buildResult = spawnSync(process.execPath, [nextBin, "build"], {
  cwd: rootDir,
  env: {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});

if (buildResult.status !== 0) {
  process.exit(buildResult.status ?? 1);
}

if (!existsSync(standaloneDir)) {
  throw new Error("Next.js standalone output was not generated.");
}

const standaloneServerPath = findStandaloneServerPath(standaloneDir);

if (!standaloneServerPath) {
  throw new Error("Unable to locate the standalone studio server.");
}

const standaloneAppDir = path.dirname(standaloneServerPath);
const standaloneAppRelativePath = path.relative(standaloneDir, standaloneAppDir);

rmSync(studioDir, { recursive: true, force: true });
mkdirSync(studioDir, { recursive: true });

for (const entry of readdirSync(standaloneDir)) {
  cpSync(path.join(standaloneDir, entry), path.join(studioDir, entry), {
    recursive: true,
  });
}

const studioAppDir = path.join(studioDir, standaloneAppRelativePath);

if (existsSync(publicDir)) {
  cpSync(publicDir, path.join(studioAppDir, "public"), { recursive: true });
}

if (existsSync(staticDir)) {
  mkdirSync(path.join(studioAppDir, ".next"), { recursive: true });
  cpSync(staticDir, path.join(studioAppDir, ".next", "static"), {
    recursive: true,
  });
}

writeFileSync(
  path.join(studioDir, "mixaudio-studio.json"),
  JSON.stringify(
    {
      serverPath: path.relative(studioDir, path.join(studioAppDir, "server.js")),
    },
    null,
    2,
  ),
);
