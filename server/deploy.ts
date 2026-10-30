import { randomUUID } from "node:crypto";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { defaultLabel } from "../shared/form";
import type {
  ConnectVia,
  DeployRequest,
  Job,
  JobResult,
  Pairing,
  JobStatus,
  JobSummary,
  Prompt,
  PromptChoice,
  RelayRequest,
  Step,
  StepId,
} from "../shared/rpc";
import { AskpassBroker, type AskpassRequest } from "./askpass";
import { deploymentSourceKey, pairingLink, relayConnection, sshConnection } from "./connection";
import { encodeQr } from "./qr";
import { type NodeRelease, type RemotePlatform } from "./node-release";
import { renderLauncher, renderUnit, unitName, type DeploymentRecord } from "./remote-files";
import {
  AWAIT_DAEMON,
  CHECK_RELAY,
  CONFIGURE,
  INSPECT,
  INSTALL_NODE,
  INSTALL_PASEO,
  PROBE,
  PRUNE_NODE,
  RESOLVE_PASEO,
  PREPARE_SYSTEMD,
  SET_CRONTAB,
  START_DETACHED,
  START_SYSTEMD,
  STOP_DAEMON,
} from "./remote-scripts";
import {
  describeInstall,
  describeNodeChange,
  describeNodeInstall,
  describeVersionChange,
  planNodeVersion,
  planPaseoVersion,
  type NodeVersionPlan,
  type PaseoVersionPlan,
  type VersionRelation,
} from "./version-plan";
import {
  cronTag,
  describePlan,
  planService,
  readServiceFacts,
  renderCronLines,
  type ServiceFacts,
  type ServicePlan,
} from "./service-plan";
import {
  confirmsWorktreesRoot,
  describeWorktreesChange,
  planWorktreesRoot,
  type WorktreesRootPlan,
} from "./worktrees-root";
import {
  probeKeyLogin,
  RemoteSession,
  SshError,
  StepFailedError,
  type SshOptions,
  type SshTarget,
} from "./ssh";

// Host types come through the plugin SDK: @getpaseo/client is not a module plugins can import.
export type HostsApi = Pick<PluginHandlerContext["paseo"]["hosts"], "list" | "add" | "update">;
type HostSummary = Awaited<ReturnType<HostsApi["list"]>>["hosts"][number];

export interface DeployDependencies {
  hosts: HostsApi;
  resolveNode(platform: RemotePlatform): Promise<NodeRelease>;
  /** Extra ssh `-o` options; tests use them for a private known_hosts. */
  sshOptions?: SshOptions;
  /** Checks this daemon reaches a relay: null when it does, else why not. */
  checkEndpoint?: (endpoint: string, useTls: boolean) => Promise<string | null>;
  /** How long to wait for the saved host to come online before reporting its status. */
  hostOnlineTimeoutMs?: number;
}

const STEP_TITLES: Record<StepId, string> = {
  connect: "Connect over SSH",
  keyLogin: "Check SSH key login",
  inspect: "Inspect the machine",
  node: "Install Node.js",
  paseo: "Install Paseo",
  configure: "Configure the daemon",
  service: "Start the daemon",
  host: "Add the host",
};

const LOG_LIMIT = 400;
const MINUTE = 60_000;

class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

class DeployFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployFailedError";
  }
}

interface Inspection {
  platform: RemotePlatform;
  user: string;
  hostname: string;
  homeDirectory: string;
  installDir: string;
  paseoHome: string;
  systemd: boolean;
  facts: ServiceFacts;
  currentNode: string | null;
  currentNodeVersion: string | null;
  currentPaseoVersion: string | null;
  managedInstall: boolean;
  managedHome: boolean;
  homeConfigured: boolean;
  /** The home's config.json; null when there is none or it could not be parsed. */
  homeConfig: HomeConfig | null;
  homeAgents: number;
  /** The home's paseo.pid, left by the last daemon that ran there. */
  lock: DaemonLock | null;
  previous: Partial<DeploymentRecord> | null;
  /** Whether the lock's process is alive, which PROBE reports once the lock is parsed. */
  daemonRunning: boolean;
}

interface HomeConfig {
  listen: string | null;
  password: boolean;
  /** worktrees.root as written; "" when unset. */
  worktreesRoot: string;
}

interface DaemonLock {
  pid: number | null;
  hostname: string | null;
  startedAt: string | null;
  desktopManaged: boolean;
}

// Only the fields the plugin reads, each optional: any other content in these files is ignored.
const homeConfigSchema = z.object({
  daemon: z
    .object({
      listen: z.string().optional(),
      auth: z.object({ password: z.string().optional() }).optional(),
    })
    .optional(),
  worktrees: z.object({ root: z.string().optional() }).optional(),
});

const lockSchema = z.object({
  pid: z.number().int().positive().optional(),
  hostname: z.string().optional(),
  startedAt: z.string().optional(),
  desktopManaged: z.boolean().optional(),
});

function parseJson<T>(raw: string | undefined, schema: z.ZodType<T>): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

export function readInspection(values: Map<string, string>): Inspection {
  const os = values.get("os");
  const arch = values.get("arch");
  if ((os !== "linux" && os !== "darwin") || (arch !== "x64" && arch !== "arm64")) {
    throw new DeployFailedError("The remote machine reported an unexpected platform.");
  }
  const libc = values.get("libc");
  const installDir = nonEmpty(values.get("installDir"));
  const paseoHome = nonEmpty(values.get("paseoHome"));
  if (!installDir || !paseoHome) throw new DeployFailedError("Could not resolve the remote paths.");
  let previous: Partial<DeploymentRecord> | null = null;
  try {
    const raw = nonEmpty(values.get("deployment"));
    previous = raw ? (JSON.parse(raw) as Partial<DeploymentRecord>) : null;
  } catch {
    previous = null;
  }
  const config = parseJson(values.get("config"), homeConfigSchema);
  const lock = parseJson(values.get("lock"), lockSchema);
  return {
    platform: {
      os,
      arch,
      libc: libc === "glibc" || libc === "musl" ? libc : null,
      glibcVersion: nonEmpty(values.get("glibc")),
      macosVersion: nonEmpty(values.get("macosVersion")),
    },
    user: values.get("user") ?? "",
    hostname: values.get("hostname") ?? "",
    homeDirectory: values.get("home") ?? paseoHome.replace(/\/\.paseo$/u, ""),
    installDir,
    paseoHome,
    systemd: values.get("systemd") === "yes",
    facts: readServiceFacts(values),
    currentNode: nonEmpty(values.get("currentNode")),
    currentNodeVersion: nonEmpty(values.get("currentNodeVersion")),
    currentPaseoVersion: nonEmpty(values.get("currentPaseoVersion")),
    managedInstall: values.get("managedInstall") === "yes",
    managedHome: values.get("managedHome") === "yes",
    homeConfigured: values.get("homeConfigured") === "yes",
    homeConfig: config && {
      listen: nonEmpty(config.daemon?.listen),
      password: !!config.daemon?.auth?.password,
      worktreesRoot: config.worktrees?.root?.trim() ?? "",
    },
    homeAgents: Number(values.get("homeAgents") ?? 0) || 0,
    lock: lock && {
      pid: lock.pid ?? null,
      hostname: nonEmpty(lock.hostname),
      startedAt: nonEmpty(lock.startedAt),
      desktopManaged: lock.desktopManaged === true,
    },
    previous,
    daemonRunning: false,
  };
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/** The HTTP(S) URL a relay `host:port` answers on; WebSockets start as a request to it. */
export function relayUrl(endpoint: string, useTls: boolean): string {
  return `${useTls ? "https" : "http"}://${endpoint}/`;
}

/**
 * Opens a TCP connection to a relay `host:port`, with a TLS handshake when it uses TLS: what the
 * daemon's WebSocket needs before anything else. Not fetch(), which refuses some ports outright.
 * Null when it connects, else the error code or message.
 */
export function checkEndpoint(endpoint: string, useTls: boolean): Promise<string | null> {
  const separator = endpoint.lastIndexOf(":");
  const host = endpoint.slice(0, separator).replace(/^\[(.*)\]$/u, "$1");
  const port = Number(endpoint.slice(separator + 1));
  return new Promise((resolve) => {
    const socket = useTls
      ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host })
      : netConnect({ host, port });
    const finish = (result: string | null) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(10_000, () => finish("timed out"));
    socket.once(useTls ? "secureConnect" : "connect", () => finish(null));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One deployment: an SSH session, the remote steps, and the host registration on this daemon. */
export class DeployJob {
  readonly id = randomUUID();
  private readonly abort = new AbortController();
  private readonly startedAt = new Date().toISOString();
  private finishedAt: string | null = null;
  private status: JobStatus = "running";
  private readonly steps: Step[];
  private prompt: Prompt | null = null;
  private promptAnswer: ((value: string | null) => void) | null = null;
  private readonly warnings: string[] = [];
  private error: string | null = null;
  private result: JobResult | null = null;
  /**
   * The relay connection with the daemon password, as a pairing link. Kept only in memory, for as
   * long as the job is, and left out of snapshots: it is sent only when someone asks for it.
   */
  private pairingLink: string | null = null;
  private readonly log: string[] = [];
  private connectVia: ConnectVia;

  /** A relay deploy, or an SSH deploy that also turns the relay on for directly paired devices. */
  private get relayEnabled(): boolean {
    return this.connectVia === "relay" || this.request.enableRelay === true;
  }

  constructor(
    private readonly request: DeployRequest,
    private readonly deps: DeployDependencies,
  ) {
    this.connectVia = request.connectVia;
    this.steps = (Object.keys(STEP_TITLES) as StepId[]).map((id) => ({
      id,
      title: STEP_TITLES[id],
      status: "pending",
      detail: null,
    }));
  }

  get finished(): boolean {
    return this.finishedAt !== null;
  }

  summary(): JobSummary {
    return {
      id: this.id,
      destination: this.request.destination,
      connectVia: this.connectVia,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
    };
  }

  pairing(): Pairing | null {
    if (!this.pairingLink) return null;
    const qr = encodeQr(this.pairingLink).map((row) =>
      row.map((dark) => (dark ? "1" : "0")).join(""),
    );
    return { link: this.pairingLink, qr };
  }

  snapshot(): Job {
    return {
      ...this.summary(),
      steps: this.steps.map((step) => ({ ...step })),
      prompt: this.prompt,
      warnings: [...this.warnings],
      error: this.error,
      result: this.result,
      log: [...this.log],
    };
  }

  answer(promptId: string, value: string | null): boolean {
    if (!this.prompt || this.prompt.id !== promptId || !this.promptAnswer) return false;
    const resolve = this.promptAnswer;
    this.prompt = null;
    this.promptAnswer = null;
    if (this.status === "waiting") this.status = "running";
    resolve(value);
    return true;
  }

  cancel(): boolean {
    if (this.finished) return false;
    this.abort.abort();
    this.promptAnswer?.(null);
    return true;
  }

  async run(): Promise<void> {
    let broker: AskpassBroker | null = null;
    let session: RemoteSession | null = null;
    let current: StepId = "connect";
    const begin = (id: StepId) => {
      this.throwIfCancelled();
      current = id;
      this.setStep(id, "running", null);
    };
    try {
      const target: SshTarget = {
        destination: this.request.destination,
        port: this.request.sshPort,
      };
      const options = this.deps.sshOptions ?? [];

      begin("connect");
      broker = await AskpassBroker.create((request) => this.askSsh(request));
      session = await RemoteSession.open({
        target,
        options,
        env: broker.env(),
        onOutput: (line) => this.appendLog(line),
        signal: this.abort.signal,
      });
      this.setStep("connect", "done", `Connected to ${this.request.destination}.`);

      begin("keyLogin");
      await this.checkKeyLogin(target, options);

      begin("inspect");
      const inspected = readInspection(
        (
          await session.run(
            INSPECT,
            {
              REQ_INSTALL_DIR: this.request.installDir ?? "",
              REQ_PASEO_HOME: this.request.paseoHome ?? "",
            },
            MINUTE,
          )
        ).values,
      );
      const worktrees = planWorktreesRoot({
        requested: this.request.worktreesRoot ?? null,
        // A config.json that could not be parsed leaves the earlier setting unknown.
        previous: inspected.homeConfig
          ? inspected.homeConfig.worktreesRoot
          : inspected.homeConfigured
            ? null
            : "",
        homeDirectory: inspected.homeDirectory,
        paseoHome: inspected.paseoHome,
      });
      const probe = await session.run(
        PROBE,
        {
          PID: inspected.lock?.pid ? String(inspected.lock.pid) : "",
          WORKTREES_ROOT: worktrees.moves && worktrees.from ? worktrees.from : "",
        },
        MINUTE,
      );
      const inspection: Inspection = {
        ...inspected,
        daemonRunning: probe.values.get("daemonRunning") === "yes",
      };
      const stranded = probe.values.has("worktreesInRoot")
        ? Number(probe.values.get("worktreesInRoot")) || 0
        : null;
      // Both versions are settled before anything is asked or installed.
      const nodeRelease = await this.deps.resolveNode(inspection.platform);
      const nodePlan = planNodeVersion({
        installed:
          inspection.managedInstall && inspection.currentNode
            ? inspection.currentNodeVersion
            : null,
        target: nodeRelease.version,
      });
      const versionPlan = await this.planVersion(session, inspection);
      await this.checkExistingDaemon(
        inspection,
        versionPlan,
        nodePlan,
        worktrees,
        stranded,
        describeDownloads(inspection, nodeRelease, nodePlan, versionPlan),
      );
      if (this.request.service === "systemd" && !inspection.systemd) {
        throw new DeployFailedError(
          "This machine does not run systemd. Choose Automatic or Background process.",
        );
      }
      let plan = planService(inspection.facts, this.request.service);
      const unit = unitName(inspection.paseoHome, inspection.homeDirectory);
      this.setStep(
        "inspect",
        "done",
        `${describeInspection(inspection)} The daemon will run as: ${describePlan(plan, unit)}.`,
      );
      if (plan.caveats.length > 0) await this.confirmPlan(plan, "Install anyway");
      const relay = this.relayEnabled ? (this.request.relay ?? null) : null;
      if (relay) await this.checkRelay(session, relay);

      begin("node");
      const { nodeDir, nodeVersion } = await this.installNode(
        session,
        inspection,
        nodeRelease,
        nodePlan,
      );

      begin("paseo");
      const paseo = await session.run(
        INSTALL_PASEO,
        {
          INSTALL_DIR: inspection.installDir,
          NODE_DIR: nodeDir,
          TARGET: versionPlan.target,
          LAUNCHER: renderLauncher(inspection.installDir),
        },
        15 * MINUTE,
      );
      const paseoVersion = paseo.values.get("paseoVersion") ?? null;
      const reinstalled =
        !paseo.values.get("reused") &&
        (versionPlan.change === "same" || versionPlan.change === "keep-newer");
      this.setStep(
        "paseo",
        "done",
        reinstalled
          ? `Reinstalled Paseo ${paseoVersion} for Node.js ${nodeVersion}.`
          : describeInstall(versionPlan, paseoVersion),
      );

      begin("configure");
      if (inspection.daemonRunning || inspection.managedHome) {
        await session.run(
          STOP_DAEMON,
          {
            INSTALL_DIR: inspection.installDir,
            PASEO_HOME: inspection.paseoHome,
            UNIT: unit,
            CRON_TAG: cronTag(unit),
          },
          2 * MINUTE,
        );
      }
      const deployment: DeploymentRecord = {
        installDir: inspection.installDir,
        unit,
        connectVia: this.connectVia,
        deployedAt: new Date().toISOString(),
      };
      const configured = await session.run(
        CONFIGURE,
        {
          INSTALL_DIR: inspection.installDir,
          PASEO_HOME: inspection.paseoHome,
          RELAY_ENABLED: this.relayEnabled ? "true" : "false",
          RELAY_ENDPOINT: relay?.endpoint ?? "",
          RELAY_USE_TLS: relay?.useTls ? "true" : "false",
          RELAY_PUBLIC_ENDPOINT: relay?.publicEndpoint ?? "",
          RELAY_PUBLIC_USE_TLS: relay?.publicUseTls ? "true" : "false",
          REQ_PORT: this.request.daemonPort ? String(this.request.daemonPort) : "",
          WORKTREES_ROOT_ACTION: worktrees.action ?? "",
          WORKTREES_ROOT: worktrees.setting,
          DEPLOYMENT: JSON.stringify(deployment),
        },
        2 * MINUTE,
      );
      // Generated and hashed on the remote; it reaches this process only as a step result,
      // which never enters the job log or snapshot.
      const password = configured.values.get("password") ?? "";
      if (!/^[A-Za-z0-9_-]{32}$/u.test(password)) {
        throw new DeployFailedError("The remote machine did not report a daemon password.");
      }
      const daemonPort = Number(configured.values.get("port"));
      if (!Number.isInteger(daemonPort) || daemonPort < 1) {
        throw new DeployFailedError("The remote machine did not report a daemon port.");
      }
      this.setStep(
        "configure",
        "done",
        `Listens on 127.0.0.1:${daemonPort} with a new random password${
          !this.relayEnabled
            ? ""
            : relay
              ? `, relay ${relay.endpoint}${relay.publicEndpoint ? ` (clients use ${relay.publicEndpoint})` : ""}`
              : ", Paseo's relay"
        }. Worktrees go in ${worktrees.root}.`,
      );

      begin("service");
      const started = await this.startDaemon(session, inspection, plan, unit);
      plan = started.plan;
      if (plan.runAs === "cron") {
        this.setStep("service", "running", "Waiting for cron to start the daemon, up to a minute.");
      }
      const ready = await session.run(
        AWAIT_DAEMON,
        {
          INSTALL_DIR: inspection.installDir,
          PASEO_HOME: inspection.paseoHome,
          RELAY: this.relayEnabled ? "true" : "false",
        },
        5 * MINUTE,
      );
      const serverId = nonEmpty(ready.values.get("serverId"));
      // The daemon runs from the new Node.js folder now, so earlier ones can go.
      await session.run(PRUNE_NODE, { INSTALL_DIR: inspection.installDir, KEEP: nodeDir }, MINUTE);
      const sessionBound = this.checkSessionBound(plan, inspection, ready.values.get("cgroup"));
      this.setStep(
        "service",
        plan.caveats.length > 0 || started.linger === "failed" || sessionBound ? "warning" : "done",
        `${describePlan(plan, unit)}. Paseo ${ready.values.get("daemonVersion") ?? paseoVersion} running${serverId ? ` as ${serverId}` : ""}.`,
      );
      session.close();
      session = null;

      begin("host");
      const label = this.request.label ?? defaultLabel(this.request.destination);
      // With the relay on, its connection is also what a paired device uses.
      const relayTarget = this.relayEnabled
        ? relayConnection(requireValue(ready.values, "connectionUri"), password)
        : null;
      const connection =
        this.connectVia === "ssh"
          ? sshConnection({
              destination: this.request.destination,
              sshPort: this.request.sshPort,
              daemonPort,
              password,
            })
          : relayTarget!;
      const saved = await this.saveHost({ connection, label, inspection, serverId, plan, unit });
      if (relayTarget) {
        this.pairingLink = pairingLink(relayTarget, nonEmpty(ready.values.get("pairingUrl")));
      }
      const status = await this.waitForHost(saved.registrationId);
      this.result = {
        connectVia: this.connectVia,
        label,
        serverId,
        paseoHome: inspection.paseoHome,
        installDir: inspection.installDir,
        worktreesRoot: worktrees.root,
        paseoVersion: ready.values.get("daemonVersion") ?? paseoVersion,
        nodeVersion,
        service: plan.runAs,
        unit: plan.runAs === "systemd" ? unit : null,
        cron: plan.cron,
        linger: started.linger,
        survivesLogout: plan.survivesLogout,
        startsAtBoot: plan.startsAtBoot,
        hostStatus: status.status,
        pairing: this.pairingLink !== null,
      };
      this.finish("succeeded");
    } catch (error) {
      if (error instanceof CancelledError || this.abort.signal.aborted) {
        this.setStep(current, "skipped", "Cancelled.");
        this.finish("cancelled");
      } else {
        const message = messageOf(error);
        this.setStep(current, "failed", message);
        this.error = message;
        if (error instanceof SshError && error.detail) this.appendLog(error.detail);
        this.finish("failed");
      }
    } finally {
      session?.close();
      await broker?.close();
      this.prompt = null;
      this.promptAnswer = null;
    }
  }

  private async checkKeyLogin(target: SshTarget, options: SshOptions): Promise<void> {
    if (this.connectVia === "relay") {
      this.setStep("keyLogin", "skipped", "Not needed: the host is added through the relay.");
      return;
    }
    const probe = await probeKeyLogin(target, options);
    if (probe.ok) {
      this.setStep("keyLogin", "done", "Key login works, so Paseo can keep its SSH link open.");
      return;
    }
    if (probe.detail) this.appendLog(`ssh (BatchMode): ${probe.detail}`);
    this.setStep("keyLogin", "warning", "Key login failed.");
    const choice = await this.ask({
      kind: "choice",
      title: "SSH key login is not set up",
      message:
        `Paseo keeps its link to a saved SSH host with \`ssh -o BatchMode=yes\`, which cannot ask ` +
        `for a password. Logging in to ${this.request.destination} without one failed, so an SSH ` +
        `host would stay offline.\n\nInstall the daemon and add the host through the relay ` +
        `instead, or cancel and set up an SSH key first.`,
      choices: [
        { value: "relay", label: "Use relay", tone: "primary" },
        { value: "cancel", label: "Cancel deploy", tone: "default" },
      ],
    });
    if (choice !== "relay") throw new CancelledError();
    this.connectVia = "relay";
    this.warnings.push(
      `Key login to ${this.request.destination} failed, so the host is added through the relay.`,
    );
    this.setStep(
      "keyLogin",
      "warning",
      "Key login failed; the host will be added through the relay.",
    );
  }

  /**
   * On a redeploy, resolves the requested version (or latest) against what this plugin installed
   * earlier, using the installed npm. A fresh install needs no comparison.
   */
  private async planVersion(
    session: RemoteSession,
    inspection: Inspection,
  ): Promise<PaseoVersionPlan> {
    const installed = inspection.managedInstall ? inspection.currentPaseoVersion : null;
    if (!installed || !inspection.currentNode) {
      return planPaseoVersion({
        installed: null,
        requested: this.request.paseoVersion,
        resolved: null,
        relation: null,
      });
    }
    const resolved = await session.run(
      RESOLVE_PASEO,
      {
        INSTALL_DIR: inspection.installDir,
        SPEC: this.request.paseoVersion ?? "latest",
        CURRENT: installed,
      },
      2 * MINUTE,
    );
    const relation = resolved.values.get("relation");
    const plan = planPaseoVersion({
      installed,
      requested: this.request.paseoVersion,
      resolved: nonEmpty(resolved.values.get("resolvedVersion")),
      relation:
        relation === "newer" ||
        relation === "older" ||
        relation === "same" ||
        relation === "unknown"
          ? (relation satisfies VersionRelation)
          : null,
    });
    this.appendLog(
      `Paseo ${installed} is installed; ${this.request.paseoVersion ?? "latest"} resolves to ${plan.to ?? "?"}.`,
    );
    return plan;
  }

  private async checkExistingDaemon(
    inspection: Inspection,
    versionPlan: PaseoVersionPlan,
    nodePlan: NodeVersionPlan,
    worktrees: WorktreesRootPlan,
    stranded: number | null,
    downloads: string | null,
  ): Promise<void> {
    const changes = [
      describeVersionChange(versionPlan),
      describeNodeChange(nodePlan),
      describeWorktreesChange(worktrees, stranded),
    ].filter((part): part is string => part !== null);
    // Every path below includes the worktree change in what it asks, so this is recorded once.
    const leftBehind =
      worktrees.moves && (stranded ?? 0) > 0
        ? `Worktrees in ${worktrees.from} were left there; Paseo no longer deletes them when their workspaces are archived.`
        : null;
    const downgrades = [
      versionPlan.change === "downgrade" ? "Paseo" : null,
      nodePlan.change === "downgrade" ? "Node.js" : null,
    ].filter((part): part is string => part !== null);
    const lockHostname = inspection.lock?.hostname;
    if (lockHostname && inspection.hostname && lockHostname !== inspection.hostname) {
      throw new DeployFailedError(
        `${inspection.paseoHome} belongs to a daemon on ${lockHostname}; the home ` +
          `directory is probably shared between machines. Choose a Paseo home on this machine's ` +
          `own disk, or one per machine.`,
      );
    }
    if (!inspection.daemonRunning) {
      if (inspection.homeConfigured && !inspection.managedHome) {
        await this.confirmTakeover(inspection);
      }
      if (downgrades.length > 0) {
        const choice = await this.ask({
          kind: "choice",
          title: `Downgrade ${downgrades.join(" and ")}?`,
          message: [...changes, downloads]
            .filter((part): part is string => part !== null)
            .join("\n\n"),
          choices: [
            { value: "downgrade", label: "Downgrade", tone: "danger" },
            { value: "cancel", label: "Cancel", tone: "default" },
          ],
        });
        if (choice !== "downgrade") throw new CancelledError();
      } else if (downloads) {
        // Nothing is downloaded or installed without this answer.
        const choice = await this.ask({
          kind: "choice",
          title: DOWNLOAD_TITLE,
          message: [...changes, downloads].join("\n\n"),
          choices: [
            { value: "install", label: "Download and install", tone: "primary" },
            { value: "cancel", label: "Cancel", tone: "default" },
          ],
        });
        if (choice !== "install") throw new CancelledError();
      } else if (confirmsWorktreesRoot(worktrees, stranded)) {
        const choice = await this.ask({
          kind: "choice",
          title: WORKTREES_TITLE,
          message: changes.join("\n\n"),
          choices: [
            { value: "change", label: "Change it", tone: "danger" },
            { value: "cancel", label: "Cancel", tone: "default" },
          ],
        });
        if (choice !== "change") throw new CancelledError();
      }
      if (leftBehind) this.warnings.push(leftBehind);
      return;
    }
    if (!inspection.managedHome) {
      throw new DeployFailedError(
        `A Paseo daemon that this plugin did not install is running in ${inspection.paseoHome}. ` +
          `Choose a different Paseo home, or stop that daemon first.`,
      );
    }
    const downgrade = downgrades.length > 0;
    const choice = await this.ask({
      kind: "choice",
      title: downgrade
        ? "Downgrade and restart the running daemon?"
        : "Restart the running daemon?",
      message: [
        `A daemon deployed by this plugin is already running in ${inspection.paseoHome}. ` +
          `Redeploying gives it a new password and restarts it, which stops its running agents.`,
        ...changes,
        ...(downloads ? [downloads] : []),
      ].join("\n\n"),
      choices: [
        {
          value: "restart",
          label: downgrade ? "Downgrade and restart" : "Redeploy and restart",
          tone: "danger",
        },
        { value: "cancel", label: "Cancel", tone: "default" },
      ],
    });
    if (choice !== "restart") throw new CancelledError();
    if (leftBehind) this.warnings.push(leftBehind);
  }

  /**
   * The remote daemon connects to `endpoint`; this daemon, and apps connecting directly, use the
   * public address. Asks before installing when either cannot reach it.
   */
  private async checkRelay(session: RemoteSession, relay: RelayRequest): Promise<void> {
    const remoteUrl = relayUrl(relay.endpoint, relay.useTls);
    const publicUrl = relay.publicEndpoint
      ? relayUrl(relay.publicEndpoint, relay.publicUseTls)
      : remoteUrl;
    const problems: string[] = [];
    const remote = await session.run(CHECK_RELAY, { RELAY_URL: remoteUrl }, MINUTE);
    if (remote.values.get("relayCheck") === "failed") {
      problems.push(
        `The remote machine could not reach ${remoteUrl}: ${remote.values.get("relayError") || "no answer"}.`,
      );
    }
    const origin = await (this.deps.checkEndpoint ?? checkEndpoint)(
      relay.publicEndpoint ?? relay.endpoint,
      relay.publicEndpoint ? relay.publicUseTls : relay.useTls,
    );
    if (origin) problems.push(`This daemon could not reach ${publicUrl}: ${origin}.`);
    if (problems.length === 0) {
      this.appendLog(
        `The relay answers from both machines (${remoteUrl}${publicUrl === remoteUrl ? "" : `, ${publicUrl}`}).`,
      );
      return;
    }
    const choice = await this.ask({
      kind: "choice",
      title: "The relay is not reachable",
      message: [
        ...problems,
        this.connectVia === "relay"
          ? "The host stays offline until both machines can reach the relay. Check the address, the port and the TLS setting."
          : "The host is added over SSH, but devices paired through the relay cannot connect until both machines can reach it. Check the address, the port and the TLS setting.",
      ].join("\n\n"),
      choices: [
        { value: "continue", label: "Install anyway", tone: "default" },
        { value: "cancel", label: "Cancel deploy", tone: "primary" },
      ],
    });
    if (choice !== "continue") throw new CancelledError();
    this.warnings.push(...problems);
  }

  /**
   * A home some other setup uses: its own launcher (a desktop app, a unit, a script) would start a
   * daemon there with settings this deploy replaces, and clients using its old password stop working.
   */
  private async confirmTakeover(inspection: Inspection): Promise<void> {
    const config = inspection.homeConfig;
    const found = [
      !config ? "has a config.json that could not be read" : null,
      config?.listen ? `listens on ${config.listen}` : null,
      config ? (config.password ? "has a daemon password" : "has no daemon password") : null,
      inspection.homeAgents > 0
        ? `holds ${inspection.homeAgents} agent record${inspection.homeAgents === 1 ? "" : "s"}`
        : null,
      inspection.lock?.startedAt ? `last started ${inspection.lock.startedAt}` : null,
    ].filter((part): part is string => part !== null);
    const message = [
      `${inspection.paseoHome} already belongs to a Paseo setup this plugin did not create. It ${found.join(", ")}.`,
      inspection.lock?.desktopManaged
        ? "Its last daemon was started by the Paseo desktop app, which starts it again when the app opens."
        : null,
      "Continuing keeps its agents, projects and saved hosts, but replaces its listen address, " +
        "password and relay setting, and runs its daemon from this plugin's installation. Anything " +
        "else that starts a daemon in this home, or connects to it with its old password, stops working.",
      "To leave that setup alone, cancel and choose a different Paseo home.",
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    const choice = await this.ask({
      kind: "choice",
      title: "Take over an existing Paseo home?",
      message,
      choices: [
        { value: "continue", label: "Take it over", tone: "danger" },
        { value: "cancel", label: "Cancel deploy", tone: "default" },
      ],
    });
    if (choice !== "continue") throw new CancelledError();
    this.warnings.push(
      `${inspection.paseoHome} was set up outside this plugin; its listen address, password and relay setting were replaced.`,
    );
  }

  /**
   * Unpacks the planned Node.js next to any earlier one; INSTALL_PASEO then reinstalls Paseo into
   * it and switches `current`. Earlier folders stay until the daemon runs (PRUNE_NODE).
   */
  private async installNode(
    session: RemoteSession,
    inspection: Inspection,
    release: NodeRelease,
    plan: NodeVersionPlan,
  ): Promise<{ nodeDir: string; nodeVersion: string | null }> {
    if (plan.change === "same" && inspection.currentNode) {
      this.setStep("node", "done", describeNodeInstall(plan, inspection.currentNode));
      return { nodeDir: inspection.currentNode, nodeVersion: inspection.currentNodeVersion };
    }
    this.throwIfCancelled();
    const installed = await session.run(
      INSTALL_NODE,
      {
        INSTALL_DIR: inspection.installDir,
        NODE_URL: release.url,
        NODE_SHA256: release.sha256,
        NODE_DIR: release.directory,
      },
      15 * MINUTE,
    );
    const nodeVersion = installed.values.get("nodeVersion") ?? release.version;
    this.setStep("node", "done", describeNodeInstall(plan, release.directory));
    return { nodeDir: release.directory, nodeVersion };
  }

  /**
   * Starts the daemon as planned. A systemd plan whose linger attempt fails, or whose user manager
   * is unreachable, is planned again from what the machine just showed, and asks again when the
   * new plan has consequences.
   */
  private async startDaemon(
    session: RemoteSession,
    inspection: Inspection,
    initial: ServicePlan,
    unit: string,
  ): Promise<{ plan: ServicePlan; linger: string | null }> {
    let plan = initial;
    let linger: string | null = null;
    if (plan.runAs === "systemd") {
      const prepared = await session.run(
        PREPARE_SYSTEMD,
        { ENABLE_LINGER: plan.enableLinger ? "yes" : "no" },
        MINUTE,
      );
      linger = prepared.values.get("linger") ?? null;
      const userManager = prepared.values.get("userManager") === "yes";
      const lingerError = nonEmpty(prepared.values.get("lingerError"));
      const systemdError = nonEmpty(prepared.values.get("systemdError"));
      if (linger === "failed") this.appendLog(`loginctl enable-linger: ${lingerError ?? "failed"}`);
      if (!userManager) this.appendLog(`systemctl --user: ${systemdError ?? "not reachable"}`);
      if (!userManager && this.request.service === "systemd") {
        throw new DeployFailedError(
          `The systemd user manager is not reachable${systemdError ? `: ${systemdError}` : "."}`,
        );
      }
      if (this.request.service === "systemd" && linger === "failed") {
        plan = {
          ...plan,
          survivesLogout: false,
          startsAtBoot: false,
          caveats: [
            `Linger could not be enabled${lingerError ? ` (${lingerError})` : ""}, so ${unit} stops when your last session on ${inspection.hostname} ends and starts again at your next login. Ask an administrator to run \`loginctl enable-linger ${inspection.user}\`.`,
          ],
        };
      } else if (!userManager || linger === "failed") {
        plan = planService(
          {
            ...inspection.facts,
            systemd: inspection.facts.systemd && userManager,
            linger: "no",
            lingerAllowed: "no",
          },
          this.request.service,
        );
        this.appendLog(`Planned again: ${describePlan(plan, unit)}.`);
        if (plan.caveats.length > 0) await this.confirmPlan(plan, "Continue");
      }
    }
    // The crontab goes first: with a keep-alive line, cron is what starts the daemon.
    await session.run(
      SET_CRONTAB,
      {
        CRON_TAG: cronTag(unit),
        CRON_LINES: renderCronLines({
          schedule: plan.cron,
          installDir: inspection.installDir,
          paseoHome: inspection.paseoHome,
          tag: cronTag(unit),
        }),
      },
      MINUTE,
    );
    if (plan.runAs === "systemd") {
      await session.run(
        START_SYSTEMD,
        {
          UNIT: unit,
          UNIT_CONTENT: renderUnit({
            installDir: inspection.installDir,
            paseoHome: inspection.paseoHome,
          }),
        },
        3 * MINUTE,
      );
    } else {
      await session.run(
        START_DETACHED,
        {
          INSTALL_DIR: inspection.installDir,
          PASEO_HOME: inspection.paseoHome,
          UNIT: unit,
          START_NOW: plan.runAs === "background" ? "yes" : "no",
        },
        3 * MINUTE,
      );
    }
    this.warnings.push(...plan.caveats);
    return { plan, linger };
  }

  /** Asks before installing (or continuing) when the daemon would not stay up on its own. */
  private async confirmPlan(plan: ServicePlan, proceed: string): Promise<void> {
    const choice = await this.ask({
      kind: "choice",
      title: plan.survivesLogout
        ? "The daemon will not start after a reboot"
        : "The daemon will stop when you log out",
      message: plan.caveats.join("\n\n"),
      choices: [
        { value: "continue", label: proceed, tone: "primary" },
        { value: "cancel", label: "Cancel deploy", tone: "default" },
      ],
    });
    if (choice !== "continue") throw new CancelledError();
  }

  /**
   * Some machines run cron jobs inside a login session. When logind kills sessions' processes at
   * logout, a daemon started there dies with the job's session.
   */
  private checkSessionBound(
    plan: ServicePlan,
    inspection: Inspection,
    cgroup: string | undefined,
  ): boolean {
    if (plan.runAs !== "cron" || inspection.facts.killOnLogout !== "yes") return false;
    if (!cgroup || !/\/session-[^/]+\.scope/u.test(cgroup)) return false;
    this.warnings.push(
      "Cron runs jobs inside a login session on this machine, so logind stops the daemon when each job ends and cron starts it again a minute later. Ask an administrator to run `loginctl enable-linger " +
        `${inspection.user}\` to keep it running.`,
    );
    return true;
  }

  private async saveHost(input: {
    connection: string;
    label: string;
    inspection: Inspection;
    serverId: string | null;
    plan: ServicePlan;
    unit: string;
  }): Promise<HostSummary> {
    const sourceKey = deploymentSourceKey({
      destination: this.request.destination,
      sshPort: this.request.sshPort,
      paseoHome: input.inspection.paseoHome,
    });
    const metadata = {
      "remote-deploy.destination": this.request.destination,
      "remote-deploy.paseoHome": input.inspection.paseoHome,
      "remote-deploy.installDir": input.inspection.installDir,
      "remote-deploy.service": input.plan.runAs === "systemd" ? input.unit : input.plan.runAs,
      ...(this.relayEnabled && this.request.relay
        ? {
            "remote-deploy.relay": this.request.relay.publicEndpoint ?? this.request.relay.endpoint,
          }
        : {}),
    };
    const directory = await this.deps.hosts.list();
    const existing = directory.hosts.find((host) => host.source.key === sourceKey);
    try {
      if (existing) {
        const saved = await this.deps.hosts.update(existing.registrationId, {
          connection: input.connection,
          label: input.label,
          metadata,
          enabled: true,
          // This deploy just created the daemon, so a new identity in a recreated home is expected.
          replaceIdentity:
            existing.serverId !== null &&
            input.serverId !== null &&
            existing.serverId !== input.serverId,
        });
        this.appendLog(`Updated the saved host ${saved.label ?? input.label}.`);
        return saved;
      }
      const saved = await this.deps.hosts.add({
        connection: input.connection,
        label: input.label,
        metadata,
        sourceKey,
      });
      this.appendLog(`Saved the host ${saved.label ?? input.label}.`);
      return saved;
    } catch (error) {
      if (errorCode(error) === "duplicate_host") {
        const other = directory.hosts.find((host) => host.serverId === input.serverId);
        throw new DeployFailedError(
          `This daemon is already saved${other ? ` as "${other.label ?? other.targetDescription}"` : ""}. ` +
            `Remove that host, then deploy again.`,
        );
      }
      if (errorCode(error) === "self_host") {
        throw new DeployFailedError("That machine is this daemon's own host.");
      }
      throw error;
    }
  }

  private async waitForHost(registrationId: string): Promise<HostSummary> {
    const deadline = Date.now() + (this.deps.hostOnlineTimeoutMs ?? 60_000);
    let latest: HostSummary | null = null;
    while (Date.now() < deadline) {
      this.throwIfCancelled();
      latest =
        (await this.deps.hosts.list()).hosts.find(
          (host) => host.registrationId === registrationId,
        ) ?? null;
      if (!latest) throw new DeployFailedError("The saved host disappeared.");
      if (latest.status === "online") {
        this.setStep(
          "host",
          "done",
          `"${latest.label}" is online through ${describeTarget(latest)}.`,
        );
        return latest;
      }
      if (latest.status === "error" && latest.error && latest.error.code !== "host_offline") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!latest) throw new DeployFailedError("The saved host disappeared.");
    const reason = latest.error ? `${latest.error.message} (${latest.error.code})` : latest.status;
    this.warnings.push(`The host was saved but is not online yet: ${reason}.`);
    this.setStep("host", "warning", `Saved "${latest.label}", but it is ${latest.status}.`);
    return latest;
  }

  private askSsh(request: AskpassRequest): Promise<string | null> {
    const prompt = request.prompt.trim();
    switch (request.kind) {
      case "secret":
        return this.ask({ kind: "secret", title: "SSH", message: prompt, choices: [] });
      case "text":
        return this.ask({
          kind: "choice",
          title: "Unknown host key",
          message: prompt.replace(/\s*Are you sure you want to continue connecting.*$/su, ""),
          choices: [
            { value: "yes", label: "Trust and connect", tone: "primary" },
            { value: "no", label: "Reject", tone: "default" },
          ],
        });
      case "confirm":
        return this.ask({
          kind: "choice",
          title: "SSH",
          message: prompt,
          choices: [
            { value: "", label: "Yes", tone: "primary" },
            { value: "__no__", label: "No", tone: "default" },
          ],
        }).then((value) => (value === "__no__" ? null : value));
      case "notice":
        return this.ask({
          kind: "choice",
          title: "SSH",
          message: prompt,
          choices: [{ value: "", label: "OK", tone: "primary" }],
        });
    }
  }

  private ask(prompt: Omit<Prompt, "id"> & { choices: PromptChoice[] }): Promise<string | null> {
    if (this.abort.signal.aborted) return Promise.resolve(null);
    // Only one question at a time: answer an earlier one as declined.
    this.promptAnswer?.(null);
    return new Promise((resolve) => {
      this.prompt = { ...prompt, id: randomUUID() };
      this.status = "waiting";
      this.promptAnswer = resolve;
    });
  }

  private setStep(id: StepId, status: Step["status"], detail: string | null): void {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (!step) return;
    step.status = status;
    if (detail !== null || status === "running") step.detail = detail;
  }

  private appendLog(line: string): void {
    // Strip terminal escapes so the log renders as plain text.
    const clean = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
    this.log.push(clean);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  private throwIfCancelled(): void {
    if (this.abort.signal.aborted) throw new CancelledError();
  }

  private finish(status: JobStatus): void {
    this.status = status;
    this.finishedAt = new Date().toISOString();
  }
}

export const DOWNLOAD_TITLE = "Download and install?";

/** Asked when the worktree root changes and no other question already says so. */
export const WORKTREES_TITLE = "Change the worktree root?";

/**
 * What this deploy fetches and from where, shown before anything is downloaded; null when it
 * reuses what is installed. Paseo is fetched again whenever Node.js changes.
 */
export function describeDownloads(
  inspection: Pick<Inspection, "installDir" | "hostname">,
  release: NodeRelease,
  nodePlan: NodeVersionPlan,
  versionPlan: PaseoVersionPlan,
): string | null {
  const items: string[] = [];
  if (nodePlan.change !== "same") {
    items.push(
      `• Node.js ${release.version} from ${new URL(release.url).host}, checked against its published SHA-256`,
    );
  }
  const paseoChanges =
    versionPlan.change === "fresh" ||
    versionPlan.change === "upgrade" ||
    versionPlan.change === "downgrade";
  if (paseoChanges || nodePlan.change !== "same") {
    items.push(
      `• @getpaseo/cli@${versionPlan.target} and its dependencies from the npm registry configured for your account there`,
    );
  }
  if (items.length === 0) return null;
  return [
    `This deploy downloads and installs into ${inspection.installDir} on ${inspection.hostname || "the remote machine"}:`,
    ...items,
    "Cancelling leaves that machine as it is.",
  ].join("\n");
}

function requireValue(values: Map<string, string>, key: string): string {
  const value = nonEmpty(values.get(key));
  if (!value) throw new DeployFailedError(`The remote machine did not report ${key}.`);
  return value;
}

function describeTarget(host: HostSummary): string {
  return host.targetDescription.replace(/\?.*$/u, "");
}

function describeInspection(inspection: Inspection): string {
  const { platform } = inspection;
  const libc =
    platform.os === "linux" && platform.glibcVersion ? `, glibc ${platform.glibcVersion}` : "";
  return (
    `${platform.os}-${platform.arch}${libc}${inspection.systemd ? ", systemd" : ""}. ` +
    `Paseo home ${inspection.paseoHome}, install directory ${inspection.installDir}.`
  );
}
