import { RefreshControl } from "react-native";
import { useSync } from "../state/app";
import { useTheme } from "./theme";

/**
 * Pull down to refresh, for a scroll view's `refreshControl`. It runs a full sync rather than a plain
 * read: reading while there's unsent work would overwrite it on screen.
 */
export function usePullToRefresh() {
  const { syncing, syncNow } = useSync();
  const { c } = useTheme();
  return <RefreshControl refreshing={syncing} onRefresh={syncNow} tintColor={c.primary} colors={[c.primary]} progressBackgroundColor={c.card} />;
}
