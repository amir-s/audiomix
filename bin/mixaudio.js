#!/usr/bin/env node

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function printUsage() {
  console.error("Usage: mixaudio studio [--port <port>] [--host <host>] [--no-open]");
}

function parseArgs(argv) {
  const [, , command, ...rest] = argv;

  if (!command) {
    return { command: null, host: "127.0.0.1", noOpen: false, port: "3000" };
  }

  let port = "3000";
  let host = "127.0.0.1";
  let noOpen = false;

  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];

    if (value === "--no-open") {
      noOpen = true;
      continue;
    }

    if (value === "--port") {
      port = rest[index + 1] ?? "";
      index += 1;
      continue;
    }

    if (value === "--host") {
      host = rest[index + 1] ?? "";
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument '${value}'.`);
  }

  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid port '${port}'.`);
  }

  if (!host) {
    throw new Error("Host must not be empty.");
  }

  return { command, host, noOpen, port };
}

async function waitForUrl(url, child) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error("Studio exited before it became ready.");
    }

    try {
      const response = await fetch(url, { redirect: "manual" });

      if (response.ok || response.status === 307 || response.status === 308) {
        return;
      }
    } catch {}

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error("Studio did not become ready in time.");
}

function openUrl(url) {
  if (process.env.CI) {
    return;
  }

  const options = { detached: true, stdio: "ignore" };

  if (process.platform === "darwin") {
    spawn("open", [url], options).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], options).unref();
    return;
  }

  spawn("xdg-open", [url], options).unref();
}

async function main() {
  let parsed;

  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    printUsage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
    return;
  }

  if (parsed.command !== "studio") {
    printUsage();
    process.exit(parsed.command ? 1 : 0);
    return;
  }

  const studioDir = path.resolve(__dirname, "..", "dist", "studio");
  const manifestPath = path.join(studioDir, "mixaudio-studio.json");
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    : null;
  const studioServerPath = path.resolve(
    studioDir,
    manifest?.serverPath ?? "server.js",
  );

  if (!fs.existsSync(studioServerPath)) {
    console.error(`Studio build is missing at ${studioServerPath}`);
    process.exit(1);
    return;
  }

  const child = spawn(process.execPath, [studioServerPath], {
    env: {
      ...process.env,
      HOSTNAME: parsed.host,
      PORT: parsed.port,
    },
    stdio: "inherit",
  });

  const displayHost = parsed.host === "0.0.0.0" ? "127.0.0.1" : parsed.host;
  const url = `http://${displayHost}:${parsed.port}`;

  console.error(`Starting Mixaudio Studio at ${url}`);

  process.on("SIGINT", () => {
    child.kill("SIGINT");
  });

  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });

  try {
    await waitForUrl(url, child);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    child.kill("SIGTERM");
    process.exit(1);
    return;
  }

  console.error(`Mixaudio Studio ready at ${url}`);

  if (!parsed.noOpen) {
    openUrl(url);
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
      return;
    }

    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
