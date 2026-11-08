import * as Haptics from "expo-haptics";

/**
 * Haptics for the moments that matter: a tab change, opening quick actions, and the outcome of a
 * commit or sync. Fired in the same handler as the visual change so touch and sight land on the same
 * frame. Never awaited, and a device with no haptic engine just does nothing.
 */
const fire = (run: () => Promise<void>) => {
  run().catch(() => {});
};

export const haptic = {
  select: () => fire(() => Haptics.selectionAsync()),
  tap: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};

export type HapticCue = keyof typeof haptic;
