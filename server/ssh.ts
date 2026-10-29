import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface SshTarget {
  destination: string;
  port: number | null;
}

/** Extra `-o` options, for tests that point ssh at a private known_hosts or identity. */
export type SshOptions = readonly string[];

export function sshBaseArgs(target: SshTarget, options: SshOptions): string[] {
  return [
    ...options.flatMap((option) => ["-o", option]),
    ...(target.port ? ["-p", String(target.port)] : []),
  ];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "SshError";
  }
}

export class StepFailedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = "StepFailedError";
  }
}

/** Turns ssh's last stderr lines into a sentence; the raw lines stay in the job log. */
export function describeSshFailure(stderr: string): string {
  if (/Permission denied/iu.test(stderr)) return "SSH authentication failed.";
  if (/Host key verification failed/iu.test(stderr)) return "The host key was not accepted.";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderr)) {
    return "The host key changed since the last connection. Check known_hosts on this daemon's machine.";
  }
  if (/Could not resolve hostname/iu.test(stderr)) return "The host name could not be resolved.";
  if (/Connection refused/iu.test(stderr)) return "The connection was refused.";
  if (/timed out/iu.test(stderr)) return "The connection timed out.";
  const last = stderr.trim().split("\n").at(-1)?.trim();
  return last ? `ssh failed: ${last}` : "ssh exited before the session started.";
}

/**
 * Checks the login Paseo's own SSH link will use: `ssh -o BatchMode=yes`, which never prompts.
 * ControlPath=none keeps a multiplexed master (possibly ours) from making this look better than it is.
 */
export async function probeKeyLogin(
  target: SshTarget,
  options: SshOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlPath=none",
    "-o",
    "ConnectTimeout=15",
    ...sshBaseArgs(target, options),
    "--",
    target.destination,
    "true",
  ];
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ ok: false, detail: error.message }));
    child.on("close", (code) => {
      resolve(code === 0 ? { ok: true } : { ok: false, detail: stderr.trim() });
    });
  });
}

export interface StepResult {
  values: Map<string, string>;
  output: string[];
}

interface PendingStep {
  marker: string;
  values: Map<string, string>;
  output: string[];
  resolve(result: StepResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * One authenticated ssh connection running `sh` on the remote machine. Each step runs in its own
 * `sh -c` with stdin from /dev/null, so a step can `exit` and never reads the commands that follow.
 * A step reports values as `@@key=value` lines; every other line is progress output.
 */
export class RemoteSession {
  private stdoutBuffer = "";
  private stderrTail: string[] = [];
  private pending: PendingStep | null = null;
  private exited = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onOutput: (line: string) => void,
    private readonly nonce: string,
  ) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        this.stderrTail = [...this.stderrTail.slice(-19), line];
        this.onOutput(`ssh: ${line}`);
      }
    });
  }

  static async open(input: {
    target: SshTarget;
    options: SshOptions;
    env: Record<string, string>;
    onOutput(line: string): void;
    signal: AbortSignal;
    timeoutMs?: number;
  }): Promise<RemoteSession> {
    const args = [
      "-T",
      "-o",
      "ForwardX11=no",
      "-o",
      "ConnectTimeout=20",
      "-o",
      "ServerAliveInterval=15",
      ...sshBaseArgs(input.target, input.options),
      "--",
      input.target.destination,
      "sh",
    ];
    // A new session has no controlling terminal, so ssh sends every prompt to SSH_ASKPASS.
    const child = spawn("ssh", args, {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...input.env },
    });
    const session = new RemoteSession(child, input.onOutput, randomBytes(12).toString("hex"));
    const abort = () => session.close();
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", (error) =>
          reject(new SshError(`Could not run ssh: ${error.message}`, "")),
        );
        child.once("close", () => {
          const detail = session.stderrTail.join("\n");
          reject(new SshError(describeSshFailure(detail), detail));
        });
        session
          .run("printf '@@ready=1\\n'", {}, input.timeoutMs ?? 10 * 60_000)
          .then(() => resolve(), reject);
      });
    } catch (error) {
      session.close();
      throw error;
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
    child.on("close", () => {
      session.exited = true;
      const detail = session.stderrTail.join("\n");
      session.pending?.reject(new SshError(describeSshFailure(detail), detail));
    });
    input.signal.addEventListener("abort", abort, { once: true });
    return session;
  }

  /** Runs one step script with the given environment; rejects when it exits non-zero. */
  run(script: string, env: Record<string, string>, timeoutMs: number): Promise<StepResult> {
    const next = this.queue.then(() => this.runNow(script, env, timeoutMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private runNow(
    script: string,
    env: Record<string, string>,
    timeoutMs: number,
  ): Promise<StepResult> {
    if (this.exited) return Promise.reject(new SshError("The SSH session has ended.", ""));
    const marker = `__paseo_rd_${this.nonce}_${randomBytes(4).toString("hex")}__`;
    const assignments = Object.entries(env)
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(" ");
    const command =
      `${assignments} /bin/sh -c ${shellQuote(script)} paseo-remote-deploy </dev/null 2>&1; ` +
      `printf '\\n${marker}%s\\n' "$?"\n`;
    return new Promise<StepResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new SshError("A remote step took too long.", ""));
        this.close();
      }, timeoutMs);
      this.pending = { marker, values: new Map(), output: [], resolve, reject, timer };
      this.child.stdin.write(command);
    });
  }

  private readStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.readLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private readLine(line: string): void {
    const pending = this.pending;
    if (!pending) {
      if (line.trim()) this.onOutput(line);
      return;
    }
    if (line.startsWith(pending.marker)) {
      clearTimeout(pending.timer);
      this.pending = null;
      const exitCode = Number(line.slice(pending.marker.length));
      if (exitCode === 0) {
        pending.resolve({ values: pending.values, output: pending.output });
      } else {
        const message =
          pending.values.get("error") ?? `A remote step exited with status ${exitCode}.`;
        pending.reject(new StepFailedError(message, exitCode));
      }
      return;
    }
    const value = /^@@([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(line);
    if (value) {
      pending.values.set(value[1]!, value[2]!);
      return;
    }
    if (!line.trim()) return;
    pending.output.push(line);
    this.onOutput(line);
  }

  close(): void {
    if (this.exited) return;
    this.exited = true;
    this.child.stdin.end();
    try {
      // The detached ssh leads its own process group; take its askpass helper down with it.
      if (this.child.pid) process.kill(-this.child.pid, "SIGTERM");
    } catch {
      this.child.kill("SIGTERM");
    }
  }
}
