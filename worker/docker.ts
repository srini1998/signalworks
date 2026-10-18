// The only Docker operations the worker may perform, all against the local Colima socket and
// only on containers named "sw-fp-*". The model has no access to this module.
import { execFile } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetError } from "./targets.ts";

const DOCKER_HOST = process.env.SW_DOCKER_HOST ?? `unix://${process.env.HOME}/.colima/breakroom/docker.sock`;
export const ALLOY_IMAGE = "grafana/alloy:v1.20.1@sha256:2aa2099af76c0098d4af7a4d6e48f86cb66dc1a000222ad927a1c67c6542d13f";
const NAME = /^sw-fp-[a-z0-9-]{4,60}$/;

function docker(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", ["--host", DOCKER_HOST, ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", HOME: process.env.HOME ?? "" } },
      (err, stdout, stderr) => (err ? reject(new TargetError(`docker ${args[0]}: ${(stderr || err.message).slice(0, 400)}`)) : resolve(stdout + stderr)));
  });
}

export async function runAlloy(name: string, files: Record<string, string>, ports: { push: number; http: number }): Promise<void> {
  if (!NAME.test(name)) throw new TargetError(`refusing container name ${name}`, "validation");
  await removeContainer(name);
  await docker(["create", "--name", name, "--label", "signalworks=filterproof", "--network", "signalworks-net",
    "--cpus", "0.5", "--memory", "256m", "--pids-limit", "256",
    "-p", `127.0.0.1:${ports.push}:3500`, "-p", `127.0.0.1:${ports.http}:12345`,
    ALLOY_IMAGE, "run", "--server.http.listen-addr=0.0.0.0:12345", "--storage.path=/tmp/alloy", "/etc/alloy/config.alloy"]);
  const dir = mkdtempSync(join(tmpdir(), "sw-fp-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      if (!/^[a-z.]+$/.test(file)) throw new TargetError(`bad config file name ${file}`, "validation");
      writeFileSync(join(dir, file), content);
      await docker(["cp", join(dir, file), `${name}:/etc/alloy/${file}`]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await docker(["start", name]);
}

export async function restartContainer(name: string): Promise<void> {
  if (!NAME.test(name)) throw new TargetError(`refusing container name ${name}`, "validation");
  await docker(["restart", "--time", "5", name]);
}

export async function containerLogs(name: string, maxBytes = 30_000_000): Promise<string> {
  if (!NAME.test(name)) throw new TargetError(`refusing container name ${name}`, "validation");
  const out = await docker(["logs", name], 60_000);
  return out.length > maxBytes ? out.slice(-maxBytes) : out;
}

export async function containerState(name: string): Promise<{ running: boolean; exitCode: number | null }> {
  try {
    const out = await docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", name]);
    const [running, code] = out.trim().split(" ");
    return { running: running === "true", exitCode: Number(code) };
  } catch {
    return { running: false, exitCode: null };
  }
}

export async function removeContainer(name: string): Promise<void> {
  if (!NAME.test(name)) throw new TargetError(`refusing container name ${name}`, "validation");
  await docker(["rm", "-f", name]).catch(() => {});
}

export async function removeRunContainers(shortId: string): Promise<void> {
  const out = await docker(["ps", "-a", "--filter", "label=signalworks=filterproof", "--format", "{{.Names}}"]).catch(() => "");
  for (const n of out.split("\n").map((s) => s.trim()).filter((s) => s.startsWith(`sw-fp-${shortId}`))) await removeContainer(n);
}
