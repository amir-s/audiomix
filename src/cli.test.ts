import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "..");

function getNpmExecPath() {
  const execPath = process.env.npm_execpath;

  assert.ok(execPath, "Expected npm_execpath to be available during npm tests.");

  return execPath;
}

async function getAvailablePort() {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();

  assert.ok(address && typeof address !== "string");

  const port = address.port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return port;
}

async function waitForUrl(url: string) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return response;
      }
    } catch {}

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });
}

test("mixaudio studio boots the packaged standalone app", { timeout: 180000 }, async () => {
  await new Promise<void>((resolve, reject) => {
    const build = spawn(process.execPath, [getNpmExecPath(), "run", "build"], {
      cwd: rootDir,
      stdio: "inherit",
    });

    build.once("error", reject);
    build.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Build exited with code ${code ?? -1}`));
    });
  });

  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  const studio = spawn(
    process.execPath,
    [path.join(rootDir, "bin", "mixaudio.js"), "studio", "--no-open", "--port", String(port)],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";

  studio.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  studio.stderr.on("data", (chunk) => {
    output += String(chunk);
  });

  try {
    const response = await waitForUrl(url);
    const html = await response.text();

    assert.match(output, /Starting Mixaudio Studio/);
    assert.match(html, /Drop audio anywhere/);
  } finally {
    studio.kill("SIGTERM");
    await waitForChildExit(studio);
  }
});
