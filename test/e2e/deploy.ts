import type { HostAdd, HostDirectory, HostSummary, HostUpdate } from "@getpaseo/client";
import { parseHostTarget } from "@getpaseo/protocol/host-target";
import { DeployJob, DOWNLOAD_TITLE, type HostsApi } from "../../server/deploy";
import { resolveNodeRelease } from "../../server/node-release";
import type { DeployRequest, Job, Pairing } from "../../shared/rpc";

/**
 * Records what the deploy saves, and reports every saved host online. `seed` adds a registration
 * as another source would have made it; `hosts` is the registry's current content.
 */
export function fakeHosts() {
  const hosts: HostSummary[] = [];
  const calls: { kind: "add" | "update" | "remove"; connection: string; registrationId: string }[] =
    [];
  let next = 1;
  const create = (input: HostAdd & { serverId?: string | null; sourceId?: string }) => {
    const host: HostSummary = {
      registrationId: `reg_${next++}`,
      serverId: input.serverId ?? null,
      label: input.label ?? null,
      source: { id: input.sourceId ?? "plugin:remote-deploy", key: input.sourceKey ?? "" },
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
  };
  const api: HostsApi = {
    async list(): Promise<HostDirectory> {
      return { self: { serverId: "srv_origin", label: "origin" }, hosts: [...hosts] };
    },
    async add(input: HostAdd): Promise<HostSummary> {
      const host = create(input);
      calls.push({
        kind: "add",
        connection: input.connection,
        registrationId: host.registrationId,
      });
      return host;
    },
    async update(registrationId: string, patch: HostUpdate): Promise<HostSummary> {
      calls.push({ kind: "update", connection: patch.connection ?? "", registrationId });
      const host = hosts.find((candidate) => candidate.registrationId === registrationId)!;
      Object.assign(host, {
        label: patch.label ?? host.label,
        metadata: patch.metadata ?? host.metadata,
      });
      return host;
    },
    async remove(registrationId: string): Promise<void> {
      calls.push({ kind: "remove", connection: "", registrationId });
      hosts.splice(
        hosts.findIndex((candidate) => candidate.registrationId === registrationId),
        1,
      );
    },
  };
  return { api, calls, hosts, seed: create };
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
): Promise<{
  job: Job;
  asked: string[];
  messages: Record<string, string>;
  pairing: Pairing | null;
}> {
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
  // What the deploy.pairing RPC would send when someone asks to see the link.
  return { job: job.snapshot(), asked, messages, pairing: job.pairing() };
}
