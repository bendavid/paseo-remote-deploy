/** How the requested Paseo version compares with the installed one, per npm's semver. */
export type VersionRelation = "newer" | "older" | "same" | "unknown";

export type VersionChange =
  /** No earlier install from this plugin: install what was asked for. */
  | "fresh"
  | "upgrade"
  | "same"
  /** Only when a version was asked for explicitly. */
  | "downgrade"
  /** The install is newer than latest (a prerelease, say), and nobody asked for another. */
  | "keep-newer";

export interface PaseoVersionPlan {
  change: VersionChange;
  /** What INSTALL_PASEO installs: an exact version, or a spec for a fresh install. */
  target: string;
  from: string | null;
  to: string | null;
}

/**
 * A redeploy moves to the newest release unless a version is set. Going down only happens when
 * a lower version is set explicitly, and the deploy warns first: Paseo's data has no migrations.
 */
export function planPaseoVersion(input: {
  installed: string | null;
  requested: string | null;
  resolved: string | null;
  relation: VersionRelation | null;
}): PaseoVersionPlan {
  const { installed, requested, resolved, relation } = input;
  if (!installed || !resolved || !relation) {
    return { change: "fresh", target: requested ?? "latest", from: installed, to: null };
  }
  switch (relation) {
    case "same":
      return { change: "same", target: installed, from: installed, to: installed };
    case "newer":
    case "unknown":
      return { change: "upgrade", target: resolved, from: installed, to: resolved };
    case "older":
      return requested
        ? { change: "downgrade", target: resolved, from: installed, to: resolved }
        : { change: "keep-newer", target: installed, from: installed, to: resolved };
  }
}

export const DOWNGRADE_WARNING =
  "Paseo's data files have no migrations, so an older daemon may not read state a newer one " +
  "wrote: agents, settings or saved hosts in this Paseo home could be lost or fail to load.";

/** One sentence for the redeploy question; null when the version stays as it is. */
export function describeVersionChange(plan: PaseoVersionPlan): string | null {
  switch (plan.change) {
    case "upgrade":
      return `Paseo is upgraded from ${plan.from} to ${plan.to}.`;
    case "downgrade":
      return `This downgrades Paseo from ${plan.from} to ${plan.to}. ${DOWNGRADE_WARNING}`;
    case "keep-newer":
      return `Paseo ${plan.from} stays installed: it is newer than the latest release, ${plan.to}.`;
    default:
      return null;
  }
}

/** The install step's detail once the plan has run. */
export function describeInstall(plan: PaseoVersionPlan, installed: string | null): string {
  switch (plan.change) {
    case "fresh":
      return `Installed Paseo ${installed}.`;
    case "upgrade":
      return `Upgraded Paseo from ${plan.from} to ${installed}.`;
    case "downgrade":
      return `Downgraded Paseo from ${plan.from} to ${installed}.`;
    case "same":
      return `Paseo ${installed} is already the requested version; the daemon updates itself from here.`;
    case "keep-newer":
      return `Kept Paseo ${installed}, which is newer than the latest release (${plan.to}).`;
  }
}

/** What happens to Node.js on this deploy; Paseo is reinstalled whenever its folder changes. */
export interface NodeVersionPlan {
  change: "fresh" | "same" | "upgrade" | "downgrade";
  from: string | null;
  to: string;
}

function nodeParts(version: string): number[] {
  return version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareNode(a: string, b: string): number {
  const [left, right] = [nodeParts(a), nodeParts(b)];
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Moves the install to the newest release of the pinned major, which is the plugin's explicit
 * choice: anything newer than it, another major or a later patch, is downgraded after a warning.
 */
export function planNodeVersion(input: {
  installed: string | null;
  target: string;
}): NodeVersionPlan {
  const { installed, target } = input;
  if (!installed) return { change: "fresh", from: null, to: target };
  const order = compareNode(target, installed);
  if (order === 0) return { change: "same", from: installed, to: target };
  return { change: order > 0 ? "upgrade" : "downgrade", from: installed, to: target };
}

export const NODE_DOWNGRADE_NOTE =
  "Paseo is reinstalled for it, so its native modules match; Paseo's data does not depend on the " +
  "Node.js version.";

/** One sentence for the redeploy question; null when Node.js stays as it is. */
export function describeNodeChange(plan: NodeVersionPlan): string | null {
  switch (plan.change) {
    case "upgrade":
      return `Node.js is upgraded from ${plan.from} to ${plan.to}, and Paseo reinstalled for it.`;
    case "downgrade":
      return `This downgrades Node.js from ${plan.from} to ${plan.to}. ${NODE_DOWNGRADE_NOTE}`;
    default:
      return null;
  }
}

/** The Node.js step's detail once the plan has run. */
export function describeNodeInstall(plan: NodeVersionPlan, directory: string): string {
  switch (plan.change) {
    case "fresh":
      return `Installed Node.js ${plan.to} (${directory}).`;
    case "upgrade":
      return `Upgraded Node.js from ${plan.from} to ${plan.to} (${directory}).`;
    case "downgrade":
      return `Downgraded Node.js from ${plan.from} to ${plan.to} (${directory}).`;
    case "same":
      return `Node.js ${plan.to} is already installed.`;
  }
}
