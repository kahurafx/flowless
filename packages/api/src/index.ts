export { appRouter, createCaller, type AppRouter } from "./root";
export { createTrpcHandler } from "./http";
export { clientErrorMessage, type AuditNote, type Context, type Session } from "./trpc";
export { setEntitlements } from "./kernel/entitlement-store";
export { consumers } from "./kernel/consumers";
export { dispatchOutbox, drainOutbox, replayEvents, type Consumer, type DispatchResult } from "./kernel/events";
