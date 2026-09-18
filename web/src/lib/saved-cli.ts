import { pickDefaultInstalled } from "./cli-pick.mjs";

export const CONFIG_KEY = "career-ops:config";

export function readSavedCliId(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const id = raw ? JSON.parse(raw).cliId : "";
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function persistCliId(cliId: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ ...prev, mode: prev.mode || "cli", cliId }),
    );
  } catch {
    /* quota / private mode */
  }
}

export { pickDefaultInstalled, pickSoleInstalled } from "./cli-pick.mjs";

/** Saved Config cliId, or the default installed CLI (and persist that pick). */
export async function resolveCliId(): Promise<string | null> {
  const saved = readSavedCliId();
  if (saved) return saved;
  try {
    const r = await fetch("/api/clis");
    const d = (await r.json()) as { clis?: { id: string; installed?: boolean }[] };
    const picked = pickDefaultInstalled(d.clis);
    if (!picked) return null;
    // The fetch above may have taken a while: re-check for a choice the user
    // made (e.g. via Config) while it was in flight, so a slow detection
    // result can never clobber a fresher explicit save.
    const savedMeanwhile = readSavedCliId();
    if (savedMeanwhile) return savedMeanwhile;
    persistCliId(picked);
    return picked;
  } catch {
    return null;
  }
}
