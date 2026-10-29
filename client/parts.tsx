import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { JobStatus, PromptChoice, Step } from "../shared/rpc";

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function Button({
  label,
  tone,
  onPress,
  disabled,
  theme,
}: {
  label: string;
  tone: PromptChoice["tone"];
  onPress(): void;
  disabled?: boolean;
  theme: PluginTheme;
}) {
  const colors = theme.colors;
  const style = useMemo(() => {
    const background =
      tone === "primary"
        ? colors.accent
        : tone === "danger"
          ? colors.statusDanger
          : colors.surface2;
    return {
      button: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: background,
        borderWidth: tone === "default" ? 1 : 0,
        borderColor: colors.border,
        opacity: disabled ? 0.5 : 1,
      },
      label: {
        color: tone === "default" ? colors.foreground : colors.accentForeground,
        fontSize: 14,
        fontWeight: "500" as const,
      },
    };
  }, [colors, tone, disabled]);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={style.button}
    >
      <Text style={style.label}>{label}</Text>
    </Pressable>
  );
}

const STEP_ICONS: Record<Step["status"], string> = {
  pending: "Circle",
  running: "LoaderCircle",
  done: "CircleCheck",
  warning: "TriangleAlert",
  failed: "CircleX",
  skipped: "CircleMinus",
};

export function stepColor(status: Step["status"], theme: PluginTheme): string {
  switch (status) {
    case "done":
      return theme.colors.statusSuccess;
    case "warning":
      return theme.colors.statusWarning;
    case "failed":
      return theme.colors.statusDanger;
    case "running":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function StepRow({ step, theme }: { step: Step; theme: PluginTheme }) {
  const style = useMemo(
    () => ({
      row: { flexDirection: "row" as const, gap: 10, paddingVertical: 6 },
      body: { flex: 1, gap: 2 },
      title: {
        color: step.status === "pending" ? theme.colors.foregroundMuted : theme.colors.foreground,
        fontSize: 14,
      },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
    }),
    [step.status, theme],
  );
  return (
    <View style={style.row}>
      <Icon name={STEP_ICONS[step.status]} size={18} color={stepColor(step.status, theme)} />
      <View style={style.body}>
        <Text style={style.title}>{step.title}</Text>
        {step.detail ? <Text style={style.detail}>{step.detail}</Text> : null}
      </View>
    </View>
  );
}

export const STATUS_LABELS: Record<JobStatus, string> = {
  running: "Running",
  waiting: "Waiting for you",
  succeeded: "Deployed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusColor(status: JobStatus, theme: PluginTheme): string {
  switch (status) {
    case "succeeded":
      return theme.colors.statusSuccess;
    case "failed":
      return theme.colors.statusDanger;
    case "waiting":
      return theme.colors.statusWarning;
    case "running":
      return theme.colors.accent;
    case "cancelled":
      return theme.colors.foregroundMuted;
  }
}
