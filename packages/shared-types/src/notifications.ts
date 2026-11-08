/**
 * Notification channels (K-07). In-app is the kernel's own inbox; the others are
 * delivered by the Communications module (templates, provider, per-organization wallet).
 */
export const NOTIFICATION_CHANNELS = ["in_app", "sms", "email", "push", "whatsapp"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
