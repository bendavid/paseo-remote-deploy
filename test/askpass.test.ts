import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { AskpassBroker, classifyPrompt, type AskpassRequest } from "../server/askpass";

const run = promisify(execFile);

test("classifyPrompt separates passwords, host keys, confirmations and notices", () => {
  expect(classifyPrompt("dev@box's password: ", null)).toBe("secret");
  expect(classifyPrompt("Enter passphrase for key '/home/me/.ssh/id_ed25519': ", null)).toBe(
    "secret",
  );
  expect(
    classifyPrompt("Are you sure you want to continue connecting (yes/no/[fingerprint])? ", null),
  ).toBe("text");
  expect(classifyPrompt("Allow use of key?", "confirm")).toBe("confirm");
  expect(classifyPrompt("Confirm user presence for key", "none")).toBe("notice");
});

test("the helper prints the answer, and exits non-zero when declined", async () => {
  const seen: AskpassRequest[] = [];
  const broker = await AskpassBroker.create(async (request) => {
    seen.push(request);
    return request.prompt.includes("decline") ? null : "s3cret 'quoted'";
  });
  try {
    const helper = broker.env().SSH_ASKPASS!;
    const env: NodeJS.ProcessEnv = { ...process.env, ...broker.env(), SSH_ASKPASS_PROMPT: "" };
    const answered = await run(helper, ["dev@box's", "password:"], { env });
    expect(answered.stdout).toBe("s3cret 'quoted'\n");
    await expect(run(helper, ["please decline"], { env })).rejects.toMatchObject({ code: 1 });
    expect(seen).toEqual([
      { prompt: "dev@box's password:", kind: "secret" },
      { prompt: "please decline", kind: "secret" },
    ]);
  } finally {
    await broker.close();
  }
});

test("the socket rejects a caller without the token", async () => {
  const broker = await AskpassBroker.create(async () => "never");
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...broker.env(),
      PASEO_REMOTE_DEPLOY_ASKPASS_TOKEN: "wrong",
    };
    await expect(run(broker.env().SSH_ASKPASS!, ["password:"], { env })).rejects.toMatchObject({
      code: 1,
    });
  } finally {
    await broker.close();
  }
});
