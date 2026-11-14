export type TimeRange = { startNs: number; endNs: number };

export type AppIdentity = {
  packageName: string;
  pids: number[];
  processNames: string[];
};
