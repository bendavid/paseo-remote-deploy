import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { DeployScreen } from "./client/deploy-screen";

const SCREEN_ID = "deploy";

function DeployItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="ServerCog"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: SCREEN_ID, title: "Remote Deploy", Component: DeployScreen }),
    client.addSidebarFooterItem({ id: SCREEN_ID, title: "Remote Deploy", Component: DeployItem }),
    client.addCommandCenterItem({
      id: SCREEN_ID,
      title: "Deploy Paseo to a machine over SSH",
      icon: "ServerCog",
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
  ];
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
