import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { getPairing, type Pairing } from "../shared/rpc";
import { Button, messageOf } from "./parts";

/** Scanners need light space around the symbol: four modules, per the QR specification. */
const QUIET_ZONE = 4;
const QR_WIDTH = 280;

/**
 * Fetches the pairing link only once opened, and drops it when closed: it holds the daemon
 * password, so it is never part of the job the screen polls.
 */
export function PairingModal({
  jobId,
  label,
  theme,
  onClose,
}: {
  jobId: string;
  label: string;
  theme: PluginTheme;
  onClose(): void;
}) {
  const fetchPairing = useRpc(getPairing);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchPairing({ jobId }).then(
      ({ pairing: next }) => {
        if (!alive) return;
        if (next) setPairing(next);
        else setError("The pairing link is no longer available. Redeploy to get a new one.");
      },
      (cause: unknown) => alive && setError(messageOf(cause)),
    );
    return () => {
      alive = false;
    };
  }, [fetchPairing, jobId]);
  const style = useMemo(
    () => ({
      body: { gap: 12 },
      text: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      warning: { color: theme.colors.statusWarning, fontSize: 13, lineHeight: 18 },
      danger: { color: theme.colors.statusDanger, fontSize: 14, lineHeight: 20 },
      link: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
      },
      actions: {
        flexDirection: "row" as const,
        flexWrap: "wrap" as const,
        gap: 8,
        justifyContent: "flex-end" as const,
      },
    }),
    [theme],
  );
  return (
    <Modal
      title="Pair a device"
      icon={<Icon name="QrCode" size={18} color={theme.colors.foreground} />}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Content>
        <View style={style.body}>
          <Text style={style.text}>
            Scan this code with the Paseo app, or open the link on the device, to add {label} with
            its password.
          </Text>
          <Text style={style.warning}>
            Anyone with this code or link can control {label} as its owner. It stops working when a
            redeploy gives the daemon a new password.
          </Text>
          {error ? <Text style={style.danger}>{error}</Text> : null}
          {pairing ? (
            <QrCode rows={pairing.qr} />
          ) : error ? null : (
            <Text style={style.text}>Loading…</Text>
          )}
          {pairing ? (
            <Text style={style.link} selectable>
              {pairing.link}
            </Text>
          ) : null}
          <View style={style.actions}>
            {pairing ? (
              <Button
                label={copied ? "Copied" : "Copy link"}
                tone="default"
                theme={theme}
                onPress={() => {
                  copyText(pairing.link).then(
                    () => setCopied(true),
                    (cause: unknown) => setError(messageOf(cause)),
                  );
                }}
              />
            ) : null}
            <Button label="Done" tone="primary" theme={theme} onPress={onClose} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/**
 * Black on white whatever the theme, since many scanners do not read inverted codes. Each row is
 * drawn as runs of equal modules, which keeps the view count to a few per row.
 */
function QrCode({ rows }: { rows: string[] }) {
  const module = Math.max(2, Math.floor(QR_WIDTH / (rows.length + QUIET_ZONE * 2)));
  const runs = useMemo(
    () =>
      rows.map((row) => {
        const result: { dark: boolean; length: number }[] = [];
        for (const cell of row) {
          const dark = cell === "1";
          const last = result.at(-1);
          if (last && last.dark === dark) last.length++;
          else result.push({ dark, length: 1 });
        }
        return result;
      }),
    [rows],
  );
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel="Pairing QR code"
      style={{ alignSelf: "center", backgroundColor: "#ffffff", padding: module * QUIET_ZONE }}
    >
      {runs.map((row, y) => (
        <View key={y} style={{ flexDirection: "row", height: module }}>
          {row.map((run, x) => (
            <View
              key={x}
              style={{
                width: run.length * module,
                height: module,
                backgroundColor: run.dark ? "#000000" : "#ffffff",
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
