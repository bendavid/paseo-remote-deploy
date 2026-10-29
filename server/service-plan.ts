import type { ServiceMode } from "../shared/rpc";
import { shellQuote } from "./ssh";

/**
 * What decides how the daemon can keep running on the remote machine, read before anything is
 * installed. Verified on Debian 12 (systemd 252) and Fedora 44 (systemd 259):
 * - Without linger, the systemd user manager stops when the user's last session ends, and its
 *   services with it. Only root can enable linger when polkit is missing.
 * - With KillUserProcesses off (the default on Debian, Ubuntu and RHEL), a detached process
 *   outlives the SSH session that started it. With it on, logind kills the session's processes.
 * - A `@reboot` crontab line starts the daemon after a reboot outside any login session.
 */
export interface ServiceFacts {
  systemd: boolean;
  linger: "yes" | "no" | "unknown";
  /** Whether polkit lets this user enable linger, asked without enabling it. */
  lingerAllowed: "yes" | "no" | "unknown";
  /** Whether logind kills this user's processes when their session ends. */
  killOnLogout: "yes" | "no" | "unknown";
  cron: "ok" | "denied" | "missing" | "stopped";
}

export type ServiceRunner = "systemd" | "background" | "cron";
export type CronSchedule = "none" | "reboot" | "keepalive";

export interface ServicePlan {
  runAs: ServiceRunner;
  /** Try `loginctl enable-linger` before using the user manager. */
  enableLinger: boolean;
  cron: CronSchedule;
  survivesLogout: boolean;
  startsAtBoot: boolean;
  /** Consequences worth a decision before installing; empty when the daemon stays up. */
  caveats: string[];
}

function words(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/u).filter(Boolean);
}

/** logind's manager_shall_kill(): who is killed at logout. */
export function killsOnLogout(input: {
  user: string;
  killUserProcesses: string | undefined;
  killOnlyUsers: string | undefined;
  killExcludeUsers: string | undefined;
}): ServiceFacts["killOnLogout"] {
  if (input.killUserProcesses === undefined) return "unknown";
  const exclude = words(input.killExcludeUsers);
  if (exclude.length === 0 && input.user === "root") return "no";
  if (exclude.includes(input.user)) return "no";
  const only = words(input.killOnlyUsers);
  if (only.length > 0) return only.includes(input.user) ? "yes" : "no";
  return input.killUserProcesses === "yes" ? "yes" : "no";
}

/** Reads INSPECT's `lingerCheck`: pkcheck's exit status, or why there was no pkcheck to run. */
export function lingerAllowed(check: string | undefined): ServiceFacts["lingerAllowed"] {
  if (check === "pkcheck 0") return "yes";
  // 1: not authorized; 2: would need an authentication agent; 3: dismissed.
  if (check === "pkcheck 1" || check === "pkcheck 2" || check === "pkcheck 3") return "no";
  if (check === "no polkit") return "no";
  return "unknown";
}

export function readServiceFacts(values: Map<string, string>): ServiceFacts {
  const systemd = values.get("systemd") === "yes";
  const linger = values.get("linger");
  const cron = values.get("cron");
  return {
    systemd,
    linger: linger === "yes" ? "yes" : linger === "no" ? "no" : "unknown",
    lingerAllowed: lingerAllowed(values.get("lingerCheck")),
    // Without logind nothing kills a user's processes at logout.
    killOnLogout: systemd
      ? killsOnLogout({
          user: values.get("user") ?? "",
          killUserProcesses: values.get("killUserProcesses"),
          killOnlyUsers: values.get("killOnlyUsers"),
          killExcludeUsers: values.get("killExcludeUsers"),
        })
      : "no",
    cron: cron === "ok" || cron === "denied" || cron === "stopped" ? cron : "missing",
  };
}

const CRON_UNAVAILABLE: Record<Exclude<ServiceFacts["cron"], "ok">, string> = {
  denied: "you are not allowed to use crontab",
  missing: "crontab is not installed",
  stopped: "no cron daemon is running",
};

/**
 * Picks how the daemon keeps running. `auto` prefers, in order: a systemd user service with linger;
 * a detached process with a `@reboot` crontab line; a keep-alive crontab line when logind kills
 * detached processes at logout; and a user service without linger, which at least runs while
 * someone is logged in. An explicit mode is honoured, with its consequences spelled out.
 */
export function planService(facts: ServiceFacts, mode: ServiceMode): ServicePlan {
  const lingerPossible = facts.linger === "yes" || facts.lingerAllowed !== "no";
  const cronOk = facts.cron === "ok";
  const noCron = cronOk
    ? ""
    : ` (${CRON_UNAVAILABLE[facts.cron as Exclude<ServiceFacts["cron"], "ok">]})`;

  const systemdPlan = (): ServicePlan => {
    const lingered = facts.linger === "yes" || facts.lingerAllowed === "yes";
    return {
      runAs: "systemd",
      enableLinger: facts.linger !== "yes",
      cron: "none",
      // Linger "unknown" is tried; PREPARE_SYSTEMD reports the outcome and the deploy replans.
      survivesLogout: lingerPossible,
      startsAtBoot: lingerPossible,
      caveats:
        lingered || facts.lingerAllowed === "unknown"
          ? []
          : [
              "Linger is not allowed for your account, so the systemd user service stops when your last session on the machine ends and starts again at your next login.",
            ],
    };
  };

  const detachedPlan = (): ServicePlan => {
    const caveats: string[] = [];
    if (facts.killOnLogout === "yes") {
      caveats.push(
        "logind kills your processes when you log out, so the background daemon stops when this deploy's SSH session ends.",
      );
    }
    if (!cronOk) caveats.push(`Nothing starts the daemon again after a reboot${noCron}.`);
    return {
      runAs: "background",
      enableLinger: false,
      cron: cronOk ? "reboot" : "none",
      survivesLogout: facts.killOnLogout !== "yes",
      startsAtBoot: cronOk,
      caveats,
    };
  };

  if (mode === "systemd") {
    if (!facts.systemd)
      return { ...systemdPlan(), caveats: ["This machine does not run systemd."] };
    return systemdPlan();
  }
  if (mode === "background") return detachedPlan();

  if (facts.systemd && lingerPossible) return systemdPlan();
  // Without a usable user manager there is no service to fall back on.
  if (facts.killOnLogout !== "yes" || !facts.systemd) return detachedPlan();
  // Processes started from an SSH session die with it: start the daemon from cron instead, and
  // have cron start it again whenever it is not running.
  if (cronOk) {
    return {
      runAs: "cron",
      enableLinger: false,
      cron: "keepalive",
      survivesLogout: true,
      startsAtBoot: true,
      caveats: [],
    };
  }
  return {
    runAs: "systemd",
    enableLinger: false,
    cron: "none",
    survivesLogout: false,
    startsAtBoot: false,
    caveats: [
      "logind kills your processes when you log out and linger is not allowed for your account, so the daemon only runs while you are logged in to the machine.",
      `It cannot be kept running from cron either${noCron}.`,
      "As a systemd user service it starts again at each login. Ask an administrator to run `loginctl enable-linger <user>` to keep it running.",
    ],
  };
}

/** What a plan means, in a sentence for the job view. */
export function describePlan(plan: ServicePlan, unit: string): string {
  switch (plan.runAs) {
    case "systemd":
      return `systemd user service ${unit}`;
    case "background":
      return plan.cron === "reboot"
        ? "Background process, started again after a reboot by a @reboot crontab line"
        : "Background process";
    case "cron":
      return "Started by a crontab line that restarts it whenever it is not running";
  }
}

/** One crontab entry for this deployment; cron turns an unescaped % into a newline. */
export function renderCronLines(input: {
  schedule: CronSchedule;
  installDir: string;
  paseoHome: string;
  tag: string;
}): string {
  if (input.schedule === "none") return "";
  const command = [`${input.installDir}/bin/paseo`, "daemon", "start", "--home", input.paseoHome]
    .map(shellQuote)
    .join(" ")
    .replace(/%/gu, "\\%");
  const when = input.schedule === "reboot" ? "@reboot" : "* * * * *";
  return [
    `# Paseo daemon for ${input.paseoHome.replace(/%/gu, "\\%")}, written by the Paseo remote-deploy plugin ${input.tag}`,
    `${when} ${command} >/dev/null 2>&1 ${input.tag}`,
  ].join("\n");
}

/** Marks this deployment's crontab lines; the entry line carries it as a shell comment. */
export function cronTag(unit: string): string {
  return `#[paseo-remote-deploy:${unit.replace(/\.service$/u, "")}]`;
}
