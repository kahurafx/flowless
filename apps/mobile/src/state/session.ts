import type { ModuleKey, WorkLevel } from "@flowless/shared-types";
import { createContext, useContext, useMemo, useState } from "react";
import { abilitiesOf, type Abilities } from "../lib/permissions";

/** Who is signed in, and what they may do. Persisted with the person's data, so a restart needs no connection. */
export type SessionMeta = {
  user: { id: string; name: string; username: string };
  org: { id: string; name: string; slug: string };
  /** Better Auth role string, e.g. "technician" or "owner,admin". */
  role: string;
  permissions: string[];
  modules: ModuleKey[];
  level: WorkLevel;
};

export const SIGNED_OUT: SessionMeta = {
  user: { id: "", name: "", username: "" },
  org: { id: "", name: "", slug: "" },
  role: "",
  permissions: [],
  modules: [],
  level: "none",
};

export type SignInResult = { ok: true } | { ok: false; error: string; needsTotp?: boolean };

export type SessionValue = SessionMeta & {
  /** Still finding out whether this phone has a session. */
  booting: boolean;
  signedIn: boolean;
  abilities: Abilities;
  /** GIS is licensed and the member may read it: the map, assets and logs exist. */
  hasGis: boolean;
  savedOrgCode: string;
  /** Organization code, then an email (owners and admins) or a username (staff), then the password. */
  signIn: (a: { orgCode: string; identifier: string; password: string }) => Promise<SignInResult>;
  verifyTotp: (code: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
};

export const SessionContext = createContext<SessionValue | null>(null);
export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error("useSession must be used inside <AppProvider>");
  return v;
}

export function useSessionState() {
  const [booting, setBooting] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [meta, setMeta] = useState<SessionMeta>(SIGNED_OUT);
  const [savedOrgCode, setSavedOrgCode] = useState("");
  const abilities = useMemo(() => abilitiesOf(meta.permissions, meta.level, meta.modules), [meta.permissions, meta.level, meta.modules]);
  const hasGis = meta.modules.includes("gis") && meta.permissions.includes("gis:read");
  return { booting, setBooting, signedIn, setSignedIn, meta, setMeta, savedOrgCode, setSavedOrgCode, abilities, hasGis };
}
