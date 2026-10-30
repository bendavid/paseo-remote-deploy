import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  ScrollView,
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  defaultLabel,
  emptyDeployForm,
  parseDeployForm,
  type DeployForm,
  type DeployFormField,
} from "../shared/form";
import {
  listJobs,
  startDeploy,
  type ConnectVia,
  type JobSummary,
  type ServiceMode,
} from "../shared/rpc";
import { JobView } from "./job-view";
import { messageOf, STATUS_LABELS, statusColor } from "./parts";

const CONNECT_OPTIONS: readonly { label: string; value: ConnectVia }[] = [
  { label: "SSH", value: "ssh" },
  { label: "Relay", value: "relay" },
];

const SERVICE_OPTIONS: readonly { label: string; value: ServiceMode }[] = [
  { label: "Automatic", value: "auto" },
  { label: "systemd user service", value: "systemd" },
  { label: "Background process", value: "background" },
];

const JOBS_POLL_MS = 3000;

function useJobs() {
  const fetchJobs = useRpc(listJobs);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const { jobs: next } = await fetchJobs({});
      if (alive.current) setJobs(next);
    } catch {
      // The form still works; the list catches up on the next poll.
    }
  }, [fetchJobs]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), JOBS_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { jobs, refresh };
}

export function DeployScreen({ theme, layout, host }: PluginScreenProps) {
  const [form, setForm] = useState<DeployForm>(emptyDeployForm);
  const [errors, setErrors] = useState<Partial<Record<DeployFormField, string>>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useRpc(startDeploy);
  const { jobs, refresh } = useJobs();
  const style = useMemo(
    () => ({
      scroll: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: layout.compact ? 16 : 24,
        gap: 8,
        maxWidth: 720,
        width: "100%" as const,
        alignSelf: "center" as const,
      },
      intro: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20, marginBottom: 8 },
      error: { color: theme.colors.statusDanger, fontSize: 14 },
      jobRow: {
        flexDirection: "row" as const,
        justifyContent: "space-between" as const,
        alignItems: "center" as const,
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 12,
      },
      jobTitle: { color: theme.colors.foreground, fontSize: 14, flexShrink: 1 },
      jobStatus: { fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  const set = <Field extends DeployFormField>(field: Field, value: DeployForm[Field]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  };

  const submit = async () => {
    const parsed = parseDeployForm(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { jobId: next } = await start(parsed.request);
      setJobId(next);
      void refresh();
    } catch (cause) {
      setSubmitError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScrollView
      style={style.scroll}
      contentContainerStyle={style.content}
      keyboardShouldPersistTaps="handled"
    >
      {jobId ? (
        <JobView
          jobId={jobId}
          theme={theme}
          onBack={() => {
            setJobId(null);
            void refresh();
          }}
        />
      ) : (
        <>
          <Text style={style.intro}>
            Installs Node.js and Paseo in your account on another machine, without root, starts the
            daemon with a random password, and saves the machine as a host of {host.label}. SSH runs
            from {host.label}, with its ~/.ssh/config and keys.
          </Text>
          <SettingsSection title="Machine">
            <SettingsCard>
              <SettingsInput
                label="SSH destination"
                hint="user@host, or a Host alias from ~/.ssh/config."
                placeholder="dev@build-box"
                initialValue={form.destination}
                onChangeText={(text) => set("destination", text)}
                error={errors.destination}
              />
              <SettingsInput
                label="SSH port"
                placeholder="22"
                initialValue={form.sshPort}
                onChangeText={(text) => set("sshPort", text)}
                error={errors.sshPort}
              />
              <SettingsInput
                label="Label"
                placeholder={form.destination.trim() ? defaultLabel(form.destination) : "Host name"}
                initialValue={form.label}
                onChangeText={(text) => set("label", text)}
                error={errors.label}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Connection">
            <SettingsCard>
              <SettingsSelect
                label="Add the host through"
                hint={
                  form.connectVia === "ssh"
                    ? "Paseo keeps an SSH tunnel open. It needs SSH key login; you are warned before anything is installed if that fails."
                    : "The daemon connects out to an end-to-end encrypted relay: Paseo's, unless you enter your own below. No inbound SSH after setup."
                }
                value={form.connectVia}
                options={CONNECT_OPTIONS}
                onValueChange={(value) => set("connectVia", value)}
              />
              {form.connectVia === "relay" ? (
                <SettingsInput
                  label="Relay address"
                  hint="host:port of a relay you run, such as getpaseo/paseo-relay. Empty uses Paseo's relay. Traffic stays end-to-end encrypted either way."
                  placeholder="relay.paseo.sh:443"
                  initialValue={form.relayEndpoint}
                  onChangeText={(text) => set("relayEndpoint", text)}
                  error={errors.relayEndpoint}
                />
              ) : null}
              {form.connectVia === "relay" && form.relayEndpoint.trim() ? (
                <SettingsSwitch
                  label="Relay uses TLS"
                  hint="Off only for a relay without TLS in front of it, such as one on a private network."
                  value={form.relayTls}
                  onValueChange={(value) => set("relayTls", value)}
                />
              ) : null}
              {form.connectVia === "relay" && form.relayEndpoint.trim() ? (
                <SettingsInput
                  label="Public relay address"
                  hint="Optional. The address clients use, when it differs from the one the remote machine uses."
                  placeholder="Same as the relay address"
                  initialValue={form.relayPublicEndpoint}
                  onChangeText={(text) => set("relayPublicEndpoint", text)}
                  error={errors.relayPublicEndpoint}
                />
              ) : null}
              {form.connectVia === "relay" &&
              form.relayEndpoint.trim() &&
              form.relayPublicEndpoint.trim() ? (
                <SettingsSwitch
                  label="Public address uses TLS"
                  value={form.relayPublicTls}
                  onValueChange={(value) => set("relayPublicTls", value)}
                />
              ) : null}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Installation">
            <SettingsCard>
              <SettingsInput
                label="Paseo home"
                hint="Daemon state, config and logs. ~ is the remote home directory."
                placeholder="~/.paseo"
                initialValue={form.paseoHome}
                onChangeText={(text) => set("paseoHome", text)}
                error={errors.paseoHome}
              />
              <SettingsInput
                label="Install directory"
                hint="Node.js and Paseo, kept separate from the Paseo home."
                placeholder="~/.local/share/paseo"
                initialValue={form.installDir}
                onChangeText={(text) => set("installDir", text)}
                error={errors.installDir}
              />
              <SettingsInput
                label="Worktree root"
                hint="Where agents' git worktrees go, saved to Paseo's worktrees.root as entered: ~ is the remote home and a relative path is inside the Paseo home. Empty uses Paseo's default, worktrees in the Paseo home. A redeploy that changes or removes an earlier setting asks first; existing worktrees stay where they are."
                placeholder="Paseo's default"
                initialValue={form.worktreesRoot}
                onChangeText={(text) => set("worktreesRoot", text)}
                error={errors.worktreesRoot}
              />
              <SettingsSelect
                label="Run the daemon as"
                hint="Automatic checks the machine first and picks what keeps the daemon running after you log out and after a reboot: a systemd user service with linger, else a background process that cron starts again. You are asked before installing if neither works."
                value={form.service}
                options={SERVICE_OPTIONS}
                onValueChange={(value) => set("service", value)}
              />
              <SettingsInput
                label="Daemon port"
                hint="Loopback port on the remote machine. Empty keeps an earlier deploy's port, else uses 6767 when free."
                placeholder="Automatic"
                initialValue={form.daemonPort}
                onChangeText={(text) => set("daemonPort", text)}
                error={errors.daemonPort}
              />
              <SettingsInput
                label="Paseo version"
                hint="Empty installs the latest release, and a redeploy upgrades to it. A version lower than the installed one downgrades, after a warning."
                placeholder="latest"
                initialValue={form.paseoVersion}
                onChangeText={(text) => set("paseoVersion", text)}
                error={errors.paseoVersion}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Deploy">
            <SettingsCard>
              <SettingsAction
                label="Install Paseo and add the host"
                hint="You are asked here for SSH passwords and before anything running is restarted."
                error={submitError}
                actionLabel={submitting ? "Starting…" : "Deploy"}
                disabled={submitting}
                onPress={() => void submit()}
              />
            </SettingsCard>
          </SettingsSection>

          {jobs.length > 0 ? (
            <SettingsSection title="Recent deploys">
              <SettingsCard>
                {jobs.map((job) => (
                  <Pressable
                    key={job.id}
                    accessibilityRole="button"
                    onPress={() => setJobId(job.id)}
                  >
                    <View style={style.jobRow}>
                      <Text style={style.jobTitle} numberOfLines={1}>
                        {job.destination}
                      </Text>
                      <Text style={[style.jobStatus, { color: statusColor(job.status, theme) }]}>
                        {STATUS_LABELS[job.status]}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </SettingsCard>
            </SettingsSection>
          ) : (
            <SettingsSection title="Recent deploys">
              <SettingsCard>
                <SettingsRow
                  label="No deploys yet"
                  hint="Deploys you start here appear in this list until the plugin reloads."
                />
              </SettingsCard>
            </SettingsSection>
          )}
        </>
      )}
    </ScrollView>
  );
}
