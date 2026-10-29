import type { HostAdd, HostDirectory, HostSummary, HostUpdate } from "@getpaseo/client";
import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { DeployJob, DOWNLOAD_TITLE, type HostsApi } from "../../server/deploy";
import { resolveNodeRelease } from "../../server/node-release";
import type { DeployRequest, Job } from "../../shared/rpc";

/** Records what the deploy saves, and reports every saved host online. */
export function fakeHosts() {
  const hosts: HostSummary[] = [];
  const calls: { kind: "add" | "update"; connection: string }[] = [];
  const api: HostsApi = {
    async list(): Promise<HostDirectory> {
      return { self: { serverId: "srv_origin", label: "origin" }, hosts: [...hosts] };
    },
    async add(input: HostAdd): Promise<HostSummary> {
      calls.push({ kind: "add", connection: input.connection });
      const host: HostSummary = {
        registrationId: `reg_${hosts.length + 1}`,
        serverId: null,
        label: input.label ?? null,
        source: { id: "plugin:remote-deploy", key: input.sourceKey ?? "" },
        metadata: input.metadata ?? {},
        enabled: true,
        status: "online",
        targetDescription: parseHostTarget(input.connection).description,
        lastOnlineAt: null,
        nextRetryAt: null,
        error: null,
      };
      hosts.push(host);
      return host;
    },
    async update(registrationId: string, patch: HostUpdate): Promise<HostSummary> {
      calls.push({ kind: "update", connection: patch.connection ?? "" });
      const host = hosts.find((candidate) => candidate.registrationId === registrationId)!;
      Object.assign(host, { label: patch.label ?? host.label });
      return host;
    },
  };
  return { api, calls };
}

/** Runs a deploy, answering its questions the way a person in the app would. */
export async function deploy(
  request: Partial<DeployRequest>,
  options: {
    sshOptions: string[];
    hosts: HostsApi;
    answers: Record<string, string>;
    /** Deploy another Node.js major than the plugin pins, to exercise upgrades and downgrades. */
    nodeMajor?: number;
  },
): Promise<{ job: Job; asked: string[]; messages: Record<string, string> }> {
  const job = new DeployJob(
    {
      destination: "dev@127.0.0.1",
      sshPort: null,
      connectVia: "ssh",
      label: null,
      paseoHome: null,
      installDir: null,
      daemonPort: null,
      paseoVersion: null,
      service: "auto",
      ...request,
    },
    {
      hosts: options.hosts,
      resolveNode: (platform) => resolveNodeRelease(platform, undefined, options.nodeMajor),
      sshOptions: options.sshOptions,
      hostOnlineTimeoutMs: 5_000,
    },
  );
  const asked: string[] = [];
  const messages: Record<string, string> = {};
  const running = job.run();
  let done = false;
  void running.finally(() => (done = true));
  while (!done) {
    const prompt = job.snapshot().prompt;
    if (prompt) {
      asked.push(prompt.title);
      messages[prompt.title] = prompt.message;
      // Downloads are confirmed unless a test answers the question itself.
      const answer = { [DOWNLOAD_TITLE]: "install", ...options.answers }[prompt.title];
      if (answer === undefined)
        throw new Error(`Unexpected prompt: ${prompt.title}: ${prompt.message}`);
      job.answer(prompt.id, answer);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await running;
  if (process.env.RD_E2E_VERBOSE) {
    const { steps, warnings, result, log } = job.snapshot();
    console.log(JSON.stringify({ steps, warnings, result }, null, 2), "\n", log.join("\n"));
  }
  return { job: job.snapshot(), asked, messages };
}
