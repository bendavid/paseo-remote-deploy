import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How `ssh` asks for input when it has no terminal. OpenSSH sets SSH_ASKPASS_PROMPT to `confirm`
 * for yes/no questions answered by exit status, and to `none` for notices such as "touch your
 * security key"; every other request expects a typed answer on stdout.
 */
export interface AskpassRequest {
  prompt: string;
  kind: "secret" | "text" | "confirm" | "notice";
}

/** The typed answer, `""` to accept a confirmation or notice, or null to decline. */
export type AskpassHandler = (request: AskpassRequest) => Promise<string | null>;

// The helper runs under this daemon's own Node.js (or Electron as Node). It forwards one prompt
// to the plugin over a socket in a private directory and prints the answer for ssh.
const HELPER_SOURCE = `"use strict";
const net = require("node:net");
const socket = net.connect(process.env.PASEO_REMOTE_DEPLOY_ASKPASS_SOCKET);
let buffer = "";
let answered = false;
socket.setEncoding("utf8");
socket.on("connect", () => {
  socket.write(JSON.stringify({
    token: process.env.PASEO_REMOTE_DEPLOY_ASKPASS_TOKEN,
    prompt: process.argv.slice(2).join(" "),
    kind: process.env.SSH_ASKPASS_PROMPT || null,
  }) + "\\n");
});
socket.on("data", (chunk) => {
  buffer += chunk;
  const end = buffer.indexOf("\\n");
  if (end < 0) return;
  let reply = null;
  try { reply = JSON.parse(buffer.slice(0, end)); } catch {}
  answered = true;
  socket.destroy();
  if (reply && typeof reply.answer === "string") {
    process.stdout.write(reply.answer + "\\n", () => process.exit(0));
  } else {
    process.exit(1);
  }
});
socket.on("error", () => process.exit(1));
// A closed socket without a reply is a refusal, never an empty answer.
socket.on("close", () => { if (!answered) process.exit(1); });
`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** Host key questions arrive as ordinary text prompts that end in "(yes/no/[fingerprint])?". */
export function classifyPrompt(prompt: string, sshKind: string | null): AskpassRequest["kind"] {
  if (sshKind === "confirm") return "confirm";
  if (sshKind === "none") return "notice";
  if (/\(yes\/no(\/\[fingerprint\])?\)\?\s*$/u.test(prompt)) return "text";
  return "secret";
}

export class AskpassBroker {
  private constructor(
    private readonly directory: string,
    private readonly server: Server,
    private readonly socketPath: string,
    private readonly token: string,
    private readonly helperPath: string,
  ) {}

  static async create(handler: AskpassHandler): Promise<AskpassBroker> {
    if (process.platform === "win32") {
      throw new Error("Remote Deploy needs a Linux or macOS daemon to run ssh with prompts.");
    }
    // mkdtemp creates the directory with mode 0700, so only this user reaches the socket.
    const directory = await mkdtemp(join(tmpdir(), "paseo-rd-"));
    const token = randomBytes(24).toString("hex");
    const socketPath = join(directory, "askpass.sock");
    const scriptPath = join(directory, "askpass.cjs");
    const helperPath = join(directory, "askpass");
    await writeFile(scriptPath, HELPER_SOURCE, { mode: 0o600 });
    await writeFile(
      helperPath,
      `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath)} ${shellQuote(scriptPath)} "$@"\n`,
      { mode: 0o700 },
    );
    await chmod(helperPath, 0o700);
    const server = createServer((socket) => serve(socket, token, handler));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return new AskpassBroker(directory, server, socketPath, token, helperPath);
  }

  /** Environment for an ssh process whose prompts should reach the handler. */
  env(): Record<string, string> {
    return {
      SSH_ASKPASS: this.helperPath,
      // OpenSSH 8.4 and later use the helper even with a display or terminal available.
      SSH_ASKPASS_REQUIRE: "force",
      // Older OpenSSH only uses SSH_ASKPASS when DISPLAY is set and there is no terminal.
      DISPLAY: process.env.DISPLAY || ":0",
      PASEO_REMOTE_DEPLOY_ASKPASS_SOCKET: this.socketPath,
      PASEO_REMOTE_DEPLOY_ASKPASS_TOKEN: this.token,
    };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await rm(this.directory, { recursive: true, force: true });
  }
}

function serve(socket: Socket, token: string, handler: AskpassHandler): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const end = buffer.indexOf("\n");
    if (end < 0) {
      if (buffer.length > 64 * 1024) socket.destroy();
      return;
    }
    const line = buffer.slice(0, end);
    buffer = "";
    let message: { token?: unknown; prompt?: unknown; kind?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      socket.destroy();
      return;
    }
    if (message.token !== token || typeof message.prompt !== "string") {
      socket.destroy();
      return;
    }
    const kind = classifyPrompt(
      message.prompt,
      typeof message.kind === "string" ? message.kind : null,
    );
    handler({ prompt: message.prompt, kind }).then(
      (answer) => socket.end(`${JSON.stringify(answer === null ? {} : { answer })}\n`),
      () => socket.end("{}\n"),
    );
  });
}
