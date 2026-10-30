import { posix } from "node:path";

/**
 * Where a `worktrees.root` value puts worktrees, resolved the way Paseo does: `~` is the home
 * directory and a relative path is inside the Paseo home. Empty is Paseo's default.
 */
export function resolveWorktreesRoot(
  value: string,
  homeDirectory: string,
  paseoHome: string,
): string {
  if (!value) return posix.join(paseoHome, "worktrees");
  const expanded =
    value === "~" ? homeDirectory : value.startsWith("~/") ? homeDirectory + value.slice(1) : value;
  return posix.resolve(paseoHome, expanded);
}

export interface WorktreesRootPlan {
  /** The form's value, written as entered; "" removes the setting, so Paseo's default applies. */
  setting: string;
  /** The setting before, as written: "" when unset, null when config.json could not be read. */
  previous: string | null;
  /** What CONFIGURE does with worktrees.root. */
  action: "set" | "unset" | null;
  /** Where new worktrees go. */
  root: string;
  /** Where they went before; null when unknown. */
  from: string | null;
  /** The root changes directory, which leaves the worktrees already in `from` behind. */
  moves: boolean;
}

export function planWorktreesRoot(input: {
  requested: string | null;
  previous: string | null;
  homeDirectory: string;
  paseoHome: string;
}): WorktreesRootPlan {
  const setting = input.requested ?? "";
  const { previous } = input;
  const resolve = (value: string) =>
    resolveWorktreesRoot(value, input.homeDirectory, input.paseoHome);
  const root = resolve(setting);
  const from = previous === null ? null : resolve(previous);
  return {
    setting,
    previous,
    action: setting === previous ? null : setting ? "set" : "unset",
    root,
    from,
    moves: from !== null && from !== root,
  };
}

/**
 * Paseo only deletes worktrees under its current root when their workspaces are archived, so a
 * move strands the ones already on disk. Changing or removing an existing setting is asked about
 * even when it moves nothing, as with another spelling of the same directory: an empty field is
 * easy to leave by accident, and the field shows no earlier value.
 */
export function confirmsWorktreesRoot(plan: WorktreesRootPlan, stranded: number | null): boolean {
  return (plan.moves && (stranded ?? 0) > 0) || (plan.action !== null && !!plan.previous);
}

/** The sentences for the deploy questions; null when the setting stays as it is. */
export function describeWorktreesChange(
  plan: WorktreesRootPlan,
  stranded: number | null,
): string | null {
  if (plan.action === null) return null;
  const change =
    plan.action === "unset"
      ? plan.previous
        ? `The worktree root setting (${plan.previous}) is removed, so new worktrees go in Paseo's default, ${plan.root}.`
        : `New worktrees go in Paseo's default, ${plan.root}.`
      : plan.previous
        ? `The worktree root changes from ${plan.previous} to ${plan.setting}, ${plan.moves ? "so new worktrees go in" : "which is the same directory,"} ${plan.root}.`
        : `The worktree root is set to ${plan.setting}, so new worktrees go in ${plan.root}.`;
  const count = plan.moves ? (stranded ?? 0) : 0;
  if (count === 0) return change;
  const left =
    count === 1
      ? `The 1 worktree already in ${plan.from} stays there, and Paseo no longer deletes it when its workspace is archived.`
      : `The ${count} worktrees already in ${plan.from} stay there, and Paseo no longer deletes them when their workspaces are archived.`;
  return `${change} ${left}`;
}
