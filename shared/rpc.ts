import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const connectViaSchema = z.enum(["ssh", "relay"]);
export type ConnectVia = z.infer<typeof connectViaSchema>;

/** `auto` uses a systemd user service when the machine runs systemd, else backgrounds the daemon. */
export const serviceModeSchema = z.enum(["auto", "systemd", "background"]);
export type ServiceMode = z.infer<typeof serviceModeSchema>;

export const deployRequestSchema = z.object({
  /** `[user@]host`, or an alias from ~/.ssh/config on this daemon's machine. */
  destination: z.string().min(1).max(512),
  sshPort: z.number().int().min(1).max(65535).nullable(),
  connectVia: connectViaSchema,
  label: z.string().max(256).nullable(),
  /** Remote paths; `~` is the remote home. Null uses the defaults. */
  paseoHome: z.string().max(1024).nullable(),
  installDir: z.string().max(1024).nullable(),
  /**
   * Paseo's `worktrees.root` on the remote, written as entered: Paseo reads `~` as the remote home
   * and a relative path as inside the Paseo home. Null removes it, so Paseo's default applies.
   */
  worktreesRoot: z.string().max(1024).nullable().optional(),
  /** Remote loopback port for the daemon. Null keeps an earlier deploy's port, else picks one. */
  daemonPort: z.number().int().min(1).max(65535).nullable(),
  /** An npm version or tag of @getpaseo/cli. Null installs latest. */
  paseoVersion: z.string().max(64).nullable(),
  service: serviceModeSchema,
  /**
   * SSH deploys only: also turn on the remote daemon's relay, so devices can pair with it directly.
   * A relay deploy always does.
   */
  enableRelay: z.boolean().optional(),
  /**
   * A relay other than Paseo's, used only when the relay is on. `endpoint` is
   * what the remote daemon connects to; `publicEndpoint`, when set, is what clients are told to use.
   */
  relay: z
    .object({
      endpoint: z.string().min(1).max(512),
      useTls: z.boolean(),
      publicEndpoint: z.string().min(1).max(512).nullable(),
      publicUseTls: z.boolean(),
    })
    .nullable()
    .optional(),
});
export type DeployRequest = z.infer<typeof deployRequestSchema>;
export type RelayRequest = NonNullable<DeployRequest["relay"]>;

export const stepIdSchema = z.enum([
  "connect",
  "keyLogin",
  "inspect",
  "node",
  "paseo",
  "configure",
  "service",
  "host",
]);
export type StepId = z.infer<typeof stepIdSchema>;

export const stepSchema = z.object({
  id: stepIdSchema,
  title: z.string(),
  status: z.enum(["pending", "running", "done", "warning", "failed", "skipped"]),
  detail: z.string().nullable(),
});
export type Step = z.infer<typeof stepSchema>;

export const promptChoiceSchema = z.object({
  value: z.string(),
  label: z.string(),
  tone: z.enum(["primary", "default", "danger"]),
});
export type PromptChoice = z.infer<typeof promptChoiceSchema>;

/** A question the deploy is waiting on: an SSH password or passphrase, or a decision. */
export const promptSchema = z.object({
  id: z.string(),
  kind: z.enum(["secret", "choice"]),
  title: z.string(),
  message: z.string(),
  choices: z.array(promptChoiceSchema),
});
export type Prompt = z.infer<typeof promptSchema>;

export const jobStatusSchema = z.enum(["running", "waiting", "succeeded", "failed", "cancelled"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobResultSchema = z.object({
  connectVia: connectViaSchema,
  label: z.string(),
  serverId: z.string().nullable(),
  paseoHome: z.string(),
  installDir: z.string(),
  /** Where the daemon creates worktrees, resolved. */
  worktreesRoot: z.string(),
  paseoVersion: z.string().nullable(),
  nodeVersion: z.string().nullable(),
  /** systemd: user service; background: detached; cron: started by a keep-alive crontab line. */
  service: z.enum(["systemd", "background", "cron"]),
  unit: z.string().nullable(),
  cron: z.enum(["none", "reboot", "keepalive"]),
  linger: z.string().nullable(),
  survivesLogout: z.boolean(),
  startsAtBoot: z.boolean(),
  hostStatus: z.string().nullable(),
  /** A pairing link with the password can be shown; relay deploys only, while the job is kept. */
  pairing: z.boolean(),
});
export type JobResult = z.infer<typeof jobResultSchema>;

export const jobSummarySchema = z.object({
  id: z.string(),
  destination: z.string(),
  connectVia: connectViaSchema,
  status: jobStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobSchema = jobSummarySchema.extend({
  steps: z.array(stepSchema),
  prompt: promptSchema.nullable(),
  warnings: z.array(z.string()),
  error: z.string().nullable(),
  result: jobResultSchema.nullable(),
  log: z.array(z.string()),
});
export type Job = z.infer<typeof jobSchema>;

export const startDeploy = defineRpc({
  name: "deploy.start",
  input: deployRequestSchema,
  output: z.object({ jobId: z.string() }),
});

export const listJobs = defineRpc({
  name: "deploy.jobs",
  input: z.object({}),
  output: z.object({ jobs: z.array(jobSummarySchema) }),
});

export const getJob = defineRpc({
  name: "deploy.job",
  input: z.object({ jobId: z.string() }),
  output: z.object({ job: jobSchema.nullable() }),
});

export const answerPrompt = defineRpc({
  name: "deploy.answer",
  input: z.object({ jobId: z.string(), promptId: z.string(), value: z.string().nullable() }),
  output: z.object({ accepted: z.boolean() }),
});

/** The link holds the daemon password, so it is only sent when someone asks to see it. */
export const pairingSchema = z.object({
  link: z.string(),
  /** QR code rows, "1" for a dark module, without the quiet zone. */
  qr: z.array(z.string()),
});
export type Pairing = z.infer<typeof pairingSchema>;

export const getPairing = defineRpc({
  name: "deploy.pairing",
  input: z.object({ jobId: z.string() }),
  output: z.object({ pairing: pairingSchema.nullable() }),
});

export const cancelDeploy = defineRpc({
  name: "deploy.cancel",
  input: z.object({ jobId: z.string() }),
  output: z.object({ cancelled: z.boolean() }),
});
