import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { answerPrompt, cancelDeploy, getJob, type Job, type JobResult } from "../shared/rpc";
import { Button, messageOf, STATUS_LABELS, statusColor, StepRow } from "./parts";
import { PromptModal } from "./prompt-modal";

function runningAs(result: JobResult): string {
  switch (result.service) {
    case "systemd":
      return ` as the systemd user service ${result.unit}${result.linger === "failed" ? ", without linger" : ""}.`;
    case "background":
      return result.cron === "reboot"
        ? " as a background process, with a @reboot crontab line to start it after a reboot."
        : " as a background process.";
    case "cron":
      return ", started from cron, which starts it again whenever it is not running.";
  }
}

/** The job polls this often while it runs; prompts appear within a second. */
const POLL_MS = 1000;

function useJob(jobId: string) {
  const fetchJob = useRpc(getJob);
  const [job, setJob] = useState<Job | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const { job: next } = await fetchJob({ jobId });
      if (!alive.current) return null;
      setError(null);
      if (next) setJob(next);
      else setMissing(true);
      return next;
    } catch (cause) {
      if (alive.current) setError(messageOf(cause));
      return null;
    }
  }, [fetchJob, jobId]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const next = await refresh();
      if (!alive.current) return;
      if (next && next.finishedAt) return;
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      alive.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  return { job, missing, error, refresh };
}

export function JobView({
  jobId,
  theme,
  onBack,
}: {
  jobId: string;
  theme: PluginTheme;
  onBack(): void;
}) {
  const { job, missing, error, refresh } = useJob(jobId);
  const answer = useRpc(answerPrompt);
  const cancel = useRpc(cancelDeploy);
  const [showLog, setShowLog] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const style = useMemo(
    () => ({
      root: { gap: 16 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        flexWrap: "wrap" as const,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: 18,
        fontWeight: "600" as const,
        flexShrink: 1,
      },
      badge: { fontSize: 13, fontWeight: "500" as const },
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
      },
      text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      warning: { color: theme.colors.statusWarning, fontSize: 14, lineHeight: 20 },
      danger: { color: theme.colors.statusDanger, fontSize: 14, lineHeight: 20 },
      log: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
      },
      logBox: { maxHeight: 320 },
      actions: { flexDirection: "row" as const, gap: 8, flexWrap: "wrap" as const },
      link: { color: theme.colors.accent, fontSize: 14 },
    }),
    [theme],
  );

  if (missing) {
    return (
      <View style={style.root}>
        <Text style={style.text}>
          This deploy is no longer available. The plugin keeps recent deploys until it reloads.
        </Text>
        <View style={style.actions}>
          <Button label="Back" tone="default" theme={theme} onPress={onBack} />
        </View>
      </View>
    );
  }
  if (!job) {
    return <Text style={error ? style.danger : style.muted}>{error ?? "Loading…"}</Text>;
  }

  const running = job.status === "running" || job.status === "waiting";
  const respond = async (value: string | null) => {
    if (!job.prompt) return;
    try {
      setActionError(null);
      await answer({ jobId, promptId: job.prompt.id, value });
    } catch (cause) {
      setActionError(messageOf(cause));
    }
    await refresh();
  };

  return (
    <View style={style.root}>
      <View style={style.header}>
        <Text style={style.title}>{job.destination}</Text>
        <Text style={[style.badge, { color: statusColor(job.status, theme) }]}>
          {STATUS_LABELS[job.status]}
          {job.connectVia === "relay" ? " · relay" : " · SSH"}
        </Text>
      </View>

      <View style={style.card}>
        {job.steps.map((step) => (
          <StepRow key={step.id} step={step} theme={theme} />
        ))}
      </View>

      {job.error ? <Text style={style.danger}>{job.error}</Text> : null}
      {job.warnings.map((warning) => (
        <Text key={warning} style={style.warning}>
          {warning}
        </Text>
      ))}
      {job.result ? (
        <View style={style.card}>
          <Text style={style.text}>
            {job.result.label} runs Paseo {job.result.paseoVersion ?? ""} on Node.js{" "}
            {job.result.nodeVersion ?? ""}
            {runningAs(job.result)}
          </Text>
          <Text style={style.muted}>
            {job.result.survivesLogout
              ? "It keeps running after you log out"
              : "It stops when your last session on the machine ends"}
            {job.result.startsAtBoot
              ? " and starts again after a reboot."
              : ", and nothing starts it again after a reboot."}
          </Text>
          <Text style={style.muted} selectable>
            Paseo home {job.result.paseoHome}, installed in {job.result.installDir}. The daemon
            updates itself; run {job.result.installDir}/bin/paseo on the machine for the CLI.
          </Text>
        </View>
      ) : null}
      {actionError ? <Text style={style.danger}>{actionError}</Text> : null}

      <View style={style.actions}>
        {running ? (
          <Button
            label="Cancel deploy"
            tone="danger"
            theme={theme}
            onPress={() => {
              void cancel({ jobId }).then(refresh, (cause: unknown) =>
                setActionError(messageOf(cause)),
              );
            }}
          />
        ) : null}
        <Button label="Back" tone="default" theme={theme} onPress={onBack} />
      </View>

      <Pressable accessibilityRole="button" onPress={() => setShowLog((value) => !value)}>
        <Text style={style.link}>
          {showLog ? "Hide log" : `Show log (${job.log.length} lines)`}
        </Text>
      </Pressable>
      {showLog ? (
        <View style={style.card}>
          <ScrollView style={style.logBox}>
            <Text style={style.log} selectable>
              {job.log.join("\n") || "No output yet."}
            </Text>
          </ScrollView>
        </View>
      ) : null}

      {job.prompt ? (
        <PromptModal
          key={job.prompt.id}
          prompt={job.prompt}
          theme={theme}
          onAnswer={(value) => void respond(value)}
        />
      ) : null}
    </View>
  );
}
