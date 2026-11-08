import { createContext, useContext, useMemo, useState } from "react";
import type { AppNode, Area, ConditionLog, Connection, Dma, Pipe, Structure, Subnetwork, ValveLog } from "../lib/types";

/**
 * The network area (G-01): what the server last said about the map, plus the records this phone has
 * made since. Read-only for screens; changes come from `useField()` actions, which also queue the
 * calls that tell the server.
 */
export type NetworkValue = {
  nodes: AppNode[];
  pipes: Pipe[];
  structures: Structure[];
  connections: Connection[];
  dmas: Dma[];
  subnetworks: Subnetwork[];
  conditionLogs: ConditionLog[];
  valveLogs: ValveLog[];
  /** The organization's areas, for jobs that target one. */
  areas: Area[];
};

export const NetworkContext = createContext<NetworkValue | null>(null);
export function useNetwork(): NetworkValue {
  const v = useContext(NetworkContext);
  if (!v) throw new Error("useNetwork must be used inside <AppProvider>");
  return v;
}

export function useNetworkState() {
  const [nodes, setNodes] = useState<AppNode[]>([]);
  const [pipes, setPipes] = useState<Pipe[]>([]);
  const [structures, setStructures] = useState<Structure[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [dmas, setDmas] = useState<Dma[]>([]);
  const [subnetworks, setSubnetworks] = useState<Subnetwork[]>([]);
  const [conditionLogs, setConditionLogs] = useState<ConditionLog[]>([]);
  const [valveLogs, setValveLogs] = useState<ValveLog[]>([]);
  const [areas, setAreas] = useState<Area[]>([]);
  const value = useMemo<NetworkValue>(
    () => ({ nodes, pipes, structures, connections, dmas, subnetworks, conditionLogs, valveLogs, areas }),
    [nodes, pipes, structures, connections, dmas, subnetworks, conditionLogs, valveLogs, areas],
  );
  return {
    value,
    setNodes, setPipes, setStructures, setConnections, setDmas, setSubnetworks, setConditionLogs, setValveLogs, setAreas,
  };
}
