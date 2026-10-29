import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Prompt } from "../shared/rpc";
import { Button } from "./parts";

/**
 * Shows what the deploy is waiting on. A secret goes straight to the daemon's askpass helper
 * and is never stored in the job. Closing the modal declines.
 */
export function PromptModal({
  prompt,
  onAnswer,
  theme,
}: {
  prompt: Prompt;
  onAnswer(value: string | null): void;
  theme: PluginTheme;
}) {
  const [secret, setSecret] = useState("");
  const style = useMemo(
    () => ({
      message: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      input: {
        color: theme.colors.foreground,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
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
  const icon = (
    <Icon
      name={prompt.kind === "secret" ? "KeyRound" : "ShieldQuestion"}
      size={18}
      color={theme.colors.foreground}
    />
  );
  return (
    <Modal
      title={prompt.title}
      icon={icon}
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(null);
      }}
    >
      <Modal.Content>
        <Text style={style.message} selectable>
          {prompt.message}
        </Text>
        {prompt.kind === "secret" ? (
          <>
            <TextInput
              style={style.input}
              value={secret}
              onChangeText={setSecret}
              secureTextEntry
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Password"
              placeholderTextColor={theme.colors.foregroundMuted}
              onSubmitEditing={() => onAnswer(secret)}
              accessibilityLabel={prompt.message}
            />
            <View style={style.actions}>
              <Button label="Cancel" tone="default" theme={theme} onPress={() => onAnswer(null)} />
              <Button
                label="Continue"
                tone="primary"
                theme={theme}
                onPress={() => onAnswer(secret)}
              />
            </View>
          </>
        ) : (
          <View style={style.actions}>
            {prompt.choices.map((choice) => (
              <Button
                key={choice.value}
                label={choice.label}
                tone={choice.tone}
                theme={theme}
                onPress={() => onAnswer(choice.value)}
              />
            ))}
          </View>
        )}
      </Modal.Content>
    </Modal>
  );
}
