import { isEmailIdentifier, normalizeOrganizationCode, ORGANIZATION_CODE_HEADER, personalBranch, qualifiedUsername, workLevel } from "@flowless/shared-types";
import { TRPCClientError } from "@trpc/client";
import { useNetworkState as useDeviceNetwork } from "expo-network";
import type { SQLiteDatabase } from "expo-sqlite";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "../components/ui";
import { api, authClient } from "../lib/api";
import { haptic, type HapticCue } from "../lib/haptics";
import { abilitiesOf, type Abilities } from "../lib/permissions";
import { assembleTasks, inChunks, latestPerRoute, type PastReading, type Round, type RoundTask } from "../lib/readings";
import { fromPreview, type ReviewBranch } from "../lib/review";
import { loadMeta, loadRows, openUserDb, saveChanges, stringifyMeta, type CollectionChange } from "../lib/storage/db";
import { clearLastUser, readLastUser, writeLastUser, writeOrgCode } from "../lib/storage/last-user";
import type { SyncItem, Transport } from "../lib/sync/ops";
import { isUnsent, runQueue, syncMessage } from "../lib/sync/queue";
import { trpcTransport } from "../lib/sync/transport";
import { useTheme } from "../lib/theme";
import type { AppNode, Area, ConditionLog, Connection, Dma, Pipe, Structure, Subnetwork, ValveLog, WorkKind, WorkOrder } from "../lib/types";
import { FieldContext, useFieldValue } from "./field";
import { JobsContext, useJobsState } from "./jobs";
import { NetworkContext, useNetworkState } from "./network";
import { ReadingsContext, useReadingsState } from "./readings";
import { ReviewContext, useReviewState, type ReviewValue } from "./review";
import { SessionContext, SIGNED_OUT, useSessionState, type SessionMeta, type SessionValue, type SignInResult } from "./session";
import { SyncContext, useSyncState, type SyncValue } from "./sync";
import { ToastContext } from "./toast";
import { useActions } from "./use-actions";

/**
 * The app's state, split by area: `useSession()`, `useNetwork()`, `useJobs()`, `useField()`,
 * `useReview()`, `useSync()`. This file wires them together and owns what crosses areas: keeping
 * everything on disk, reading the server (`pull`), signing in and out, and the sync run.
 *
 * Field work is local-first: an action changes what this phone shows at once and queues the exact
 * API call(s) it stands for (`Op`, lib/sync/ops.ts). "Sync now" sends the queue in order through a
 * `Transport`, then reads everything again, which replaces the phone's guesses with the server's
 * answer. What the server says back to each op (applied, stale, rejected with a reason) lands on the
 * queue item, which is what the Sync screen shows. The lists are only re-read with nothing left to
 * send, so unsent work never disappears from the screen.
 *
 * All of it is also on disk (lib/storage/db.ts). React state stays what screens read; a layout
 * effect commits each state change to SQLite before it reaches the screen, so an action and its
 * queued op are saved together, and a restart with no connection opens where it left off.
 */

const BOOT_TIMEOUT_MS = 8000;
/** How long finished items stay on the Sync screen. Anything unsent stays until it's dealt with. */
const SENT_ITEMS_KEPT_MS = 14 * 86_400_000;
const MAX_OVERLAY_BRANCHES = 8;

/** The server said this session is over. Anything else (no signal, a timeout) isn't a reason to stop working. */
class SessionEnded extends Error {}
const isSessionEnded = (err: unknown) => err instanceof SessionEnded || (err instanceof TRPCClientError && (err.data as { code?: string } | undefined)?.code === "UNAUTHORIZED");

const byId = (row: { id: string }) => row.id;
const sortByDue = (orders: WorkOrder[]) => [...orders].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());

type Lists = {
  nodes: AppNode[];
  pipes: Pipe[];
  structures: Structure[];
  connections: Connection[];
  dmas: Dma[];
  subnetworks: Subnetwork[];
  conditionLogs: ConditionLog[];
  valveLogs: ValveLog[];
  areas: Area[];
  kinds: WorkKind[];
  workOrders: WorkOrder[];
  branches: ReviewBranch[];
  rounds: Round[];
  readingTasks: RoundTask[];
  queue: SyncItem[];
};

/** What's kept on disk besides the lists. */
type SavedMeta = { session: SessionMeta; savedOrgCode: string; lastSyncedAt: Date | null };

const keyOf: { [K in keyof Lists]: (row: Lists[K][number]) => string } = {
  nodes: byId,
  pipes: byId,
  structures: byId,
  connections: byId,
  dmas: byId,
  subnetworks: byId,
  conditionLogs: byId,
  valveLogs: byId,
  areas: byId,
  workOrders: byId,
  queue: byId,
  kinds: (k) => k.key,
  branches: (b) => b.branch,
  rounds: byId,
  readingTasks: byId,
};

/** A branch's own versions replace main's by id. */
function overlay<T extends { id: string }>(base: T[], onBranch: T[]): T[] {
  if (onBranch.length === 0) return base;
  const mine = new Map(onBranch.map((r) => [r.id, r]));
  const seen = new Set<string>();
  const merged = base.map((r) => {
    seen.add(r.id);
    return mine.get(r.id) ?? r;
  });
  return [...merged, ...onBranch.filter((r) => !seen.has(r.id))];
}

export function AppProvider({ children, transport = trpcTransport }: { children: ReactNode; transport?: Transport }) {
  const insets = useSafeAreaInsets();
  const { c } = useTheme();

  /* ---------- toast ---------- */

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string, cue?: HapticCue) => {
    if (cue) haptic[cue]();
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /* ---------- the areas ---------- */

  const session = useSessionState();
  const network = useNetworkState();
  const review = useReviewState();
  const sync = useSyncState(showToast);
  const userId = session.meta.user.id;

  const jobs = useJobsState({
    userId,
    abilities: session.abilities,
    nodes: network.value.nodes,
    enqueue: sync.enqueue,
    onReviewed: (code, approved) =>
      // Approving closes the job; the engineer posts the data separately.
      review.setBranches((bs) => bs.map((b) => (b.origin?.ref === code ? { ...b, origin: { ...b.origin, status: approved ? "completed" : "in_progress" } } : b))),
  });

  const readings = useReadingsState({ enqueue: sync.enqueue });

  const field = useFieldValue({
    userId,
    abilities: session.abilities,
    kinds: jobs.kinds,
    network: network.value,
    setNodes: network.setNodes,
    setPipes: network.setPipes,
    setStructures: network.setStructures,
    setConnections: network.setConnections,
    setConditionLogs: network.setConditionLogs,
    setValveLogs: network.setValveLogs,
    jobs: jobs.links,
    enqueue: sync.enqueue,
  });

  /* ---------- on disk ---------- */

  const dbRef = useRef<SQLiteDatabase | null>(null);
  const savedLists = useRef<Lists | null>(null);
  const savedMeta = useRef<string | null>(null);
  const current: Lists = {
    nodes: network.value.nodes,
    pipes: network.value.pipes,
    structures: network.value.structures,
    connections: network.value.connections,
    dmas: network.value.dmas,
    subnetworks: network.value.subnetworks,
    conditionLogs: network.value.conditionLogs,
    valveLogs: network.value.valveLogs,
    areas: network.value.areas,
    kinds: jobs.kinds,
    workOrders: jobs.workOrders,
    branches: review.branches,
    rounds: readings.value.rounds,
    readingTasks: readings.value.tasks,
    queue: sync.queue,
  };

  // Before paint, so nothing on screen says "saved" until it is. React batches an action's state
  // changes into one render, which makes the record and its queued op one transaction.
  useLayoutEffect(() => {
    const db = dbRef.current;
    const before = savedLists.current;
    if (!db || !before) return;
    const meta = stringifyMeta({ session: session.meta, savedOrgCode: session.savedOrgCode, lastSyncedAt: sync.lastSyncedAt } satisfies SavedMeta);
    const changes = (Object.keys(current) as (keyof Lists)[])
      .filter((name) => current[name] !== before[name])
      .map((name) => ({ collection: name, previous: before[name], next: current[name], keyOf: keyOf[name] }) as unknown as CollectionChange);
    try {
      saveChanges(db, changes, { previous: savedMeta.current, next: meta });
      savedLists.current = current;
      savedMeta.current = meta;
    } catch (err) {
      console.error("Couldn't save to this phone", err);
      // Not in this effect's body: a toast is a state change, and this effect runs after every render.
      setTimeout(() => showToast("Couldn't save to this phone. Check it has free storage."), 0);
    }
  });

  /** Open this person's data and put it on screen. Returns what's in it, since state won't have updated yet. */
  const openStore = (id: string) => {
    dbRef.current = null;
    const db = openUserDb(id);
    const cutoff = Date.now() - SENT_ITEMS_KEPT_MS;
    const lists: Lists = {
      nodes: loadRows<AppNode>(db, "nodes"),
      pipes: loadRows<Pipe>(db, "pipes"),
      structures: loadRows<Structure>(db, "structures"),
      connections: loadRows<Connection>(db, "connections"),
      dmas: loadRows<Dma>(db, "dmas"),
      subnetworks: loadRows<Subnetwork>(db, "subnetworks"),
      conditionLogs: loadRows<ConditionLog>(db, "conditionLogs").sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime()),
      valveLogs: loadRows<ValveLog>(db, "valveLogs").sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime()),
      areas: loadRows<Area>(db, "areas"),
      kinds: loadRows<WorkKind>(db, "kinds"),
      workOrders: sortByDue(loadRows<WorkOrder>(db, "workOrders")),
      branches: loadRows<ReviewBranch>(db, "branches"),
      rounds: loadRows<Round>(db, "rounds"),
      readingTasks: loadRows<RoundTask>(db, "readingTasks"),
      // Newest first on screen; saved in the order they were made. Old finished items age out.
      queue: loadRows<SyncItem>(db, "queue")
        .reverse()
        .filter((i) => isUnsent(i) || i.status === "rejected" || new Date(i.at).getTime() >= cutoff),
    };
    const meta = loadMeta<SavedMeta>(db);
    network.setNodes(lists.nodes);
    network.setPipes(lists.pipes);
    network.setStructures(lists.structures);
    network.setConnections(lists.connections);
    network.setDmas(lists.dmas);
    network.setSubnetworks(lists.subnetworks);
    network.setConditionLogs(lists.conditionLogs);
    network.setValveLogs(lists.valveLogs);
    network.setAreas(lists.areas);
    jobs.setKinds(lists.kinds);
    jobs.setWorkOrders(lists.workOrders);
    review.setBranches(lists.branches);
    readings.setRounds(lists.rounds);
    readings.setTasks(lists.readingTasks);
    sync.setQueue(lists.queue);
    if (meta) {
      session.setMeta(meta.session);
      session.setSavedOrgCode(meta.savedOrgCode);
      sync.setLastSyncedAt(meta.lastSyncedAt);
    }
    savedLists.current = lists;
    savedMeta.current = meta ? stringifyMeta(meta) : null;
    dbRef.current = db;
    return { lists, meta };
  };

  /* ---------- reading the server ---------- */

  /** Read everything this person can see. Throws if the server can't be reached. */
  const pull = async (me: SessionMeta, abilities: Abilities) => {
    const gis = me.modules.includes("gis") && me.permissions.includes("gis:read");
    const jobsOn = abilities.seeJobs;
    const open = ["pending", "in_progress", "blocked", "submitted"] as const;

    const [n, p, conn, st, d, sn, cond, valves, areaList, openJobs, recentJobs, jobKinds, rows] = await Promise.all([
      gis ? api.gis.nodes.list.query() : [],
      gis ? api.gis.pipes.list.query() : [],
      gis ? api.gis.connections.list.query() : [],
      gis ? api.gis.structures.list.query() : [],
      gis ? api.gis.dmas.list.query() : [],
      gis ? api.gis.subnetworks.list.query() : [],
      gis ? api.gis.logs.conditionFeed.query({ limit: 200 }) : [],
      gis ? api.gis.logs.valveFeed.query({ limit: 200 }) : [],
      api.hierarchy.areas.query({}),
      jobsOn ? api.workOrders.list.query({ statuses: [...open], limit: 200 }) : [],
      // What I finished lately stays on my list for a while (W-01).
      jobsOn ? api.workOrders.mine.query() : [],
      jobsOn ? api.workOrders.kinds.query() : [],
      gis && abilities.post ? api.gis.reconcile.branches.query() : [],
    ]);

    const orders = sortByDue([...new Map([...recentJobs, ...openJobs].map((o) => [o.id, o])).values()]);

    // Proposals on the branches this person works on (their jobs', their own) sit over the live network.
    const mine = orders.filter((o) => o.assignedToUserId === me.user.id && o.branch && !["completed", "cancelled"].includes(o.status)).map((o) => o.branch!);
    const branches = gis ? [...new Set([personalBranch(me.user.id), ...mine])].slice(0, MAX_OVERLAY_BRANCHES) : [];
    const overlays = await Promise.all(
      branches.map(async (branch) => {
        const [bn, bp, bs, bc] = await Promise.all([
          api.gis.nodes.list.query({ branch }),
          api.gis.pipes.list.query({ branch }),
          api.gis.structures.list.query({ branch }),
          api.gis.connections.list.query({ branch }),
        ]);
        const own = <T extends { branch: string }>(list: T[]) => list.filter((r) => r.branch === branch);
        return { nodes: own(bn), pipes: own(bp), structures: own(bs), connections: own(bc) };
      }),
    );
    const layered = <K extends keyof (typeof overlays)[number], T extends { id: string }>(base: T[], key: K) =>
      overlays.reduce((acc, o) => overlay(acc, o[key] as unknown as T[]), base);

    const previews = await Promise.allSettled(rows.map((r) => api.gis.reconcile.preview.query({ branch: r.branch })));

    network.setNodes(layered(n as AppNode[], "nodes"));
    network.setPipes(layered(p, "pipes"));
    network.setStructures(layered(st, "structures"));
    network.setConnections(layered(conn, "connections"));
    network.setDmas(d);
    network.setSubnetworks(sn);
    network.setConditionLogs(cond);
    network.setValveLogs(valves);
    network.setAreas(areaList);
    jobs.setKinds(jobKinds);
    jobs.setWorkOrders(orders);
    review.setBranches(rows.flatMap((r, i) => (previews[i]?.status === "fulfilled" ? [fromPreview(r, previews[i].value)] : [])));
    sync.setLastSyncedAt(new Date());
    // After the main pull: a failure here (Metering trouble) must not hide the rest of what was read.
    await pullRounds(abilities).catch((err) => console.warn("Couldn't refresh the reading round", err));
  };

  /** The route's reading tasks, with what the phone needs to validate offline (M-08). Nothing is stored that the server can derive. */
  const pullRounds = async (abilities: Abilities) => {
    if (!abilities.readings) {
      readings.setRounds([]);
      readings.setTasks([]);
      return;
    }
    const [heads, routes] = await Promise.all([api.metering.snapshots.list.query({ limit: 100 }), api.hierarchy.routes.query({})]);
    const names = new Map(routes.map((r) => [r.id, r.name]));
    const latest = latestPerRoute(heads, 6);
    const nextRounds: Round[] = latest.map((h) => ({ id: h.id, routeId: h.routeId, routeName: names.get(h.routeId) ?? "Route", cycleDate: h.cycleDate }));
    const nextTasks: RoundTask[] = [];
    for (const head of latest) {
      const server = await api.metering.snapshots.tasks.query({ snapshotId: head.id });
      const meterIds = [...new Set(server.flatMap((t) => (t.meterId ? [t.meterId] : [])))];
      const meters = new Map<string, { serial: string; dialDigits: number }>();
      const past = new Map<string, PastReading[]>();
      await inChunks(meterIds, 20, async (meterId) => {
        const [detail, list] = await Promise.all([api.metering.meters.get.query({ meterId }), api.metering.readings.list.query({ meterId, status: "valid", limit: 6 })]);
        meters.set(meterId, { serial: detail.meter.serial, dialDigits: detail.meter.dialDigits });
        past.set(meterId, list);
      });
      nextTasks.push(...assembleTasks(head, server, meters, past));
    }
    readings.setRounds(nextRounds);
    readings.setTasks(nextTasks);
  };

  /** A session exists: find out who this is and load their world. Work that hasn't gone up yet stays as it is on the phone. */
  const enter = async () => {
    const { data, error } = await authClient.getSession();
    if (!data) {
      if (error && error.status !== 401) throw new Error("Couldn't check the session");
      throw new SessionEnded();
    }
    const [me, modules, orgs] = await Promise.all([
      api.access.me.query(),
      api.entitlements.list.query(),
      authClient.organization.list().then((r) => r.data ?? []),
    ]);
    const stored = dbRef.current ? null : openStore(data.user.id);
    void writeLastUser(data.user.id);
    const active = orgs.find((o) => o.id === data.session.activeOrganizationId);
    const meta: SessionMeta = {
      user: { id: data.user.id, name: data.user.name, username: (data.user as { username?: string | null }).username ?? "" },
      org: active ? { id: active.id, name: active.name, slug: active.slug } : session.meta.org,
      role: me.role,
      permissions: me.permissions,
      modules,
      level: workLevel(modules),
    };
    const abilities = abilitiesOf(meta.permissions, meta.level, meta.modules);
    const unsent = (stored ? stored.lists.queue : sync.queueRef.current).some(isUnsent);
    if (!unsent) await pull(meta, abilities);
    session.setMeta(meta);
    if (active) session.setSavedOrgCode(active.slug);
    session.setSignedIn(true);
  };

  /** Leaves the app's data on disk, ready for this person's next sign-in. Disconnects first so clearing the screen doesn't clear the disk. */
  const leave = () => {
    dbRef.current = null;
    savedLists.current = null;
    savedMeta.current = null;
    void clearLastUser();
    session.setSignedIn(false);
    session.setMeta(SIGNED_OUT);
    network.setNodes([]);
    network.setPipes([]);
    network.setStructures([]);
    network.setConnections([]);
    network.setDmas([]);
    network.setSubnetworks([]);
    network.setConditionLogs([]);
    network.setValveLogs([]);
    network.setAreas([]);
    jobs.setKinds([]);
    jobs.setWorkOrders([]);
    review.setBranches([]);
    readings.setRounds([]);
    readings.setTasks([]);
    sync.setQueue([]);
    sync.setLastSyncedAt(null);
  };

  // Back from a restart. With a session and this person's data on the phone, open it straight away
  // and refresh behind it if there's a connection: field work can't wait for signal. Otherwise there's
  // nothing to show yet, so try the server, and fall through to sign-in if it can't be reached in time.
  useEffect(() => {
    void (async () => {
      const [cookie, lastUser] = await Promise.all([authClient.getCookie().catch(() => ""), readLastUser()]);
      if (cookie && lastUser) {
        const { meta } = openStore(lastUser);
        if (meta) {
          session.setSignedIn(true);
          session.setBooting(false);
          enter().catch((err: unknown) => {
            if (!isSessionEnded(err)) return; // no signal: carry on with what's on the phone
            leave();
            showToast("Please sign in again. Your unsent work is safe on this phone.");
          });
          return;
        }
      }
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, BOOT_TIMEOUT_MS));
      await Promise.race([cookie ? enter() : Promise.resolve(), timeout]).catch(() => {});
      session.setBooting(false);
    })();
    // Runs once, at launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- signing in and out ---------- */

  const signIn: SessionValue["signIn"] = async ({ orgCode, identifier, password }) => {
    const code = normalizeOrganizationCode(orgCode);
    if (!code) return { ok: false, error: "Enter your organization code: letters and digits only, for example MAJISAFI." };
    const who = identifier.trim();
    const fetchOptions = { headers: { [ORGANIZATION_CODE_HEADER]: code } };
    try {
      const { data, error } = isEmailIdentifier(who)
        ? await authClient.signIn.email({ email: who, password, fetchOptions })
        : await authClient.signIn.username({ username: qualifiedUsername(code, who), password, fetchOptions });
      if (error) {
        return { ok: false, error: error.status === 429 ? "Too many attempts. Wait a minute and try again." : "Organization code, username or password is incorrect." };
      }
      void writeOrgCode(code.toUpperCase());
      if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return { ok: false, error: "", needsTotp: true };
      await enter();
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
    }
  };

  const verifyTotp: SessionValue["verifyTotp"] = async (code): Promise<SignInResult> => {
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code });
      if (error) return { ok: false, error: "That code did not work. Check your authenticator app and try again." };
      await enter();
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't reach the server. Check your connection and try again." };
    }
  };

  /** Unsent work stays in this person's database and carries on when they sign back in. */
  const signOut = async () => {
    await authClient.signOut().catch(() => {});
    leave();
  };

  /* ---------- sync ---------- */

  const device = useDeviceNetwork();
  const deviceOnline = device.isConnected !== false && device.isInternetReachable !== false;
  const online = deviceOnline && !sync.workOffline;

  const syncNow = async () => {
    if (sync.syncing) return;
    if (!online) {
      showToast("You're in offline mode", "warning");
      return;
    }
    sync.setSyncing(true);
    // Oldest first: a log has to reach the server before the op that links it to a job.
    const due = sync.queueRef.current.filter(isUnsent).reverse();
    const run = await runQueue(due, transport, (id, patch) => sync.setQueue((q) => q.map((i) => (i.id === id ? { ...i, ...patch } : i))));
    // Everything's up: read back what the server now says. Anything else would overwrite what hasn't gone yet.
    const pulled = !run.stoppedAt && (await pull(session.meta, session.abilities).then(() => true, () => false));
    sync.setSyncing(false);
    const { message, cue } = syncMessage({ stopped: !!run.stoppedAt, pulled, sent: run.sent, refused: run.refused });
    showToast(message, cue);
  };

  const postBranch: ReviewValue["postBranch"] = async (name, resolutions, override = false) => {
    const b = review.branches.find((x) => x.branch === name);
    if (!b) return { status: "failed", message: "This set of changes is no longer available." };
    try {
      const res = await api.gis.reconcile.post.mutate({ branch: name, token: b.token, resolutions, override });
      if (res.status === "posted") await pull(session.meta, session.abilities);
      return res;
    } catch (err) {
      return { status: "failed", message: err instanceof Error ? err.message : "Couldn't reach the server." };
    }
  };

  const discardBranch: ReviewValue["discardBranch"] = async (name) => {
    try {
      await api.gis.reconcile.discard.mutate({ branch: name });
      await pull(session.meta, session.abilities);
      showToast("Changes discarded");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't reach the server");
    }
  };

  const actions = useActions({ signIn, verifyTotp, signOut, syncNow, postBranch, discardBranch });

  // Upload on its own when the connection comes back or the app returns to the foreground.
  const wasOnline = useRef(online);
  const unsentCount = sync.queue.filter(isUnsent).length;
  useEffect(() => {
    if (online && !wasOnline.current && unsentCount > 0 && session.signedIn) void actions.syncNow();
    wasOnline.current = online;
  }, [online, unsentCount, session.signedIn, actions]);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && session.signedIn && online && sync.queueRef.current.some(isUnsent)) void actions.syncNow();
    });
    return () => sub.remove();
  }, [session.signedIn, online, actions, sync.queueRef]);

  /* ---------- values ---------- */

  const sessionValue = useMemo<SessionValue>(
    () => ({
      ...session.meta,
      booting: session.booting,
      signedIn: session.signedIn,
      abilities: session.abilities,
      hasGis: session.hasGis,
      savedOrgCode: session.savedOrgCode,
      signIn: actions.signIn,
      verifyTotp: actions.verifyTotp,
      signOut: actions.signOut,
    }),
    [session.meta, session.booting, session.signedIn, session.abilities, session.hasGis, session.savedOrgCode, actions],
  );

  const syncValue = useMemo<SyncValue>(
    () => ({
      queue: sync.queue,
      pending: unsentCount,
      awaitingReview: sync.queue.filter((i) => i.status === "applied" && !i.reviewed).length,
      online,
      workOffline: sync.workOffline,
      setWorkOffline: sync.setWorkOffline,
      syncing: sync.syncing,
      lastSyncedAt: sync.lastSyncedAt,
      syncNow: actions.syncNow,
      retryItem: sync.retryItem,
      discardItem: sync.discardItem,
    }),
    [sync.queue, unsentCount, online, sync.workOffline, sync.setWorkOffline, sync.syncing, sync.lastSyncedAt, actions, sync.retryItem, sync.discardItem],
  );

  const reviewValue = useMemo<ReviewValue>(
    () => ({ branches: review.branches, postBranch: actions.postBranch, discardBranch: actions.discardBranch }),
    [review.branches, actions],
  );

  return (
    <SessionContext.Provider value={sessionValue}>
      <NetworkContext.Provider value={network.value}>
        <JobsContext.Provider value={jobs.value}>
          <ReadingsContext.Provider value={readings.value}>
          <FieldContext.Provider value={field}>
            <ReviewContext.Provider value={reviewValue}>
              <SyncContext.Provider value={syncValue}>
                <ToastContext.Provider value={showToast}>
                  {children}
                  {toast && (
                    <View pointerEvents="none" style={{ position: "absolute", top: insets.top + 8, left: 16, right: 16, zIndex: 100, alignItems: "center" }}>
                      <View style={{ borderRadius: 999, backgroundColor: c.foreground, paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: c.background, fontSize: 14, fontWeight: "500" }}>{toast}</Text>
                      </View>
                    </View>
                  )}
                </ToastContext.Provider>
              </SyncContext.Provider>
            </ReviewContext.Provider>
          </FieldContext.Provider>
          </ReadingsContext.Provider>
        </JobsContext.Provider>
      </NetworkContext.Provider>
    </SessionContext.Provider>
  );
}

export { useField } from "./field";
export { useJobs } from "./jobs";
export { useNetwork } from "./network";
export { useReadings } from "./readings";
export { useReview } from "./review";
export { useSession } from "./session";
export { useSync } from "./sync";
export { useToast } from "./toast";
