/**
 * Reading a saved game, for the "only show what I can field" filter.
 *
 * An OpenXcom save is plain uncompressed YAML in exactly two documents: a small
 * header (name, version, in-game date) and then the entire game state. js-yaml
 * handles both in one call - a 170 KB XPiratez save parses in about 17ms, so
 * there is no need to extract sections by hand.
 *
 * Only three things are taken out of it, and all three are needed:
 *
 *   discovered          completed research, the gate for buying and building
 *   bases[].items       what is in store at each base
 *   bases[].crafts[]
 *           .items      what is already loaded on a ship
 *
 * That last one is not optional. In the save being developed against, base
 * stores hold 129 distinct ids and the crafts add another 26 on top - kit that
 * is packed and ready is exactly what you want a loadout filter to show.
 */
import JSYaml from "js-yaml";
import { fetchText, listDir } from "./util";

export type SaveInfo = {
  /** Path to fetch, relative to the served root. */
  path: string;
  /** Bare filename, for the picker. */
  file: string;
  /** Folder it came from, which is the master mod's id (e.g. "piratez"). */
  dir: string;
  /** From the Last-Modified header, when the server sends one. */
  modified: number;
};

export type SaveState = {
  path: string;
  /** The save's own name, from the header document. */
  name: string;
  /** In-game date as "11 Mar 2601", for confirming which campaign this is. */
  date: string;
  /** Completed research ids. Mixed prefixing - see below. */
  discovered: Set<string>;
  /** Every item id held at a base or loaded on a craft, with total count. */
  owned: Map<string, number>;
  /** Base count, so the UI can say what it summed. */
  bases: number;
  crafts: number;
};

/**
 * Where saves live. Absolute, because the page is served from /xpedia2/ while
 * the OXCE root is the server root - a relative "user/" resolves to
 * /xpedia2/user/ and finds nothing. This matches the ruleset loader, which
 * builds its paths off an OXCPath of "/" (load.ts:92).
 */
const SAVE_DIR = "/user/";
const SAVE_EXT = [".sav", ".asav"];

/**
 * Find every save in the install.
 *
 * Deliberately not hardcoded to user/piratez/ - the folder is named after the
 * master mod, so it scans user/ for subdirectories and looks in each. listDir
 * scrapes the server's directory index, which is how the ruleset loader already
 * enumerates user/mods/.
 */
export async function findSaves(): Promise<SaveInfo[]> {
  const out: SaveInfo[] = [];
  let dirs: string[] = [];
  try {
    dirs = (await listDir(SAVE_DIR)) || [];
  } catch (e) {
    return out;
  }

  for (const entry of dirs) {
    if (!entry.endsWith("/")) continue;
    // mods/ holds rulesets, not saves.
    if (entry == "mods/" || entry == "../") continue;
    let files: string[] = [];
    try {
      files = (await listDir(SAVE_DIR + entry)) || [];
    } catch (e) {
      continue;
    }
    for (const f of files) {
      if (!SAVE_EXT.some((e) => f.toLowerCase().endsWith(e))) continue;
      // The index gives the bare filename, spaces and all. Decoding is only for
      // a server that percent-encodes its link text, and a stray % must not
      // throw - save names are whatever the player typed.
      let name = f;
      try {
        name = decodeURIComponent(f);
      } catch (e) {
        name = f;
      }
      out.push({
        path: SAVE_DIR + entry + f,
        file: name,
        dir: entry.replace(/\/$/, ""),
        modified: 0,
      });
    }
  }
  return out;
}

/**
 * Fill in modification times so the newest save can be offered first.
 *
 * Best-effort, and on this install it gets nothing: esbuild's dev server 404s
 * on HEAD and sends no Last-Modified even on GET, so there is no route to a
 * timestamp without downloading all 79 saves. One file is probed first and the
 * rest are skipped when that comes back empty - the alternative was 79 pointless
 * requests to learn the same thing. A server that does send the header (a real
 * static host, or a future change to the dev setup) gets newest-first for free.
 */
async function modifiedAt(path: string): Promise<number> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(path, { method });
      if (!res.ok) continue;
      const lm = res.headers.get("last-modified");
      if (!lm) return 0;
      const t = Date.parse(lm);
      return isNaN(t) ? 0 : t;
    } catch (e) {
      // Try the next method, then give up.
    }
  }
  return 0;
}

export async function stampSaves(saves: SaveInfo[]): Promise<SaveInfo[]> {
  if (!saves.length) return saves;

  // Probe one. No header there means no header anywhere on this server.
  const probe = await modifiedAt(saves[0].path);
  if (!probe) return saves;
  saves[0].modified = probe;

  await Promise.all(
    saves.slice(1).map(async (s) => {
      s.modified = await modifiedAt(s.path);
    })
  );
  return saves;
}

/** Newest first when timestamps came through, else by name. */
export function sortSaves(saves: SaveInfo[]): SaveInfo[] {
  const dated = saves.some((s) => s.modified > 0);
  return [...saves].sort((a, b) =>
    dated
      ? b.modified - a.modified
      : a.file.toLowerCase() < b.file.toLowerCase()
        ? -1
        : 1
  );
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function gameDate(time: any): string {
  if (!time || typeof time != "object") return "";
  const d = +time.day;
  const m = +time.month;
  const y = +time.year;
  if (isNaN(d) || isNaN(y)) return "";
  const month = MONTHS[m - 1] || String(m);
  return d + " " + month + " " + y;
}

/**
 * Parse one save into just the parts the filter needs.
 *
 * Returns null rather than throwing on anything unreadable - a half-written
 * autosave should disable the filter, not break the page.
 */
export function parseSave(text: string, path = ""): SaveState {
  if (!text) return null;

  let docs: any[];
  try {
    docs = JSYaml.loadAll(text, null, { json: true }) as any[];
  } catch (e) {
    console.error("save parse failed", path, e && e.message);
    return null;
  }
  if (!docs || !docs.length) return null;

  // Header first, state second. A save with only one document is not a save.
  const header = docs[0] && typeof docs[0] == "object" ? docs[0] : {};
  const state = docs.length > 1 && docs[1] && typeof docs[1] == "object" ? docs[1] : null;
  if (!state) return null;

  /**
   * Ids are matched exactly and never normalised. XPiratez mixes conventions in
   * this very list - STR_FARMING sits next to a bare BANDIT_ARMOR_P13 - so
   * assuming an STR_ prefix, or adding one, would silently drop entries.
   */
  const discovered = new Set<string>();
  for (const r of Array.isArray(state.discovered) ? state.discovered : [])
    if (typeof r == "string") discovered.add(r);

  const owned = new Map<string, number>();
  const add = (map: any) => {
    if (!map || typeof map != "object") return;
    for (const id of Object.keys(map)) {
      const n = +map[id];
      owned.set(id, (owned.get(id) || 0) + (isNaN(n) ? 0 : n));
    }
  };

  const bases = Array.isArray(state.bases) ? state.bases : [];
  let crafts = 0;
  for (const b of bases) {
    if (!b || typeof b != "object") continue;
    add(b.items);
    for (const c of Array.isArray(b.crafts) ? b.crafts : []) {
      crafts++;
      add(c && c.items);
    }
  }

  return {
    path,
    name: typeof header.name == "string" ? header.name : "",
    date: gameDate(header.time),
    discovered,
    owned,
    bases: bases.length,
    crafts,
  };
}

/** Fetch and parse one save. Null on any failure. */
export async function loadSave(path: string): Promise<SaveState> {
  let text: string;
  try {
    text = await fetchText(path);
  } catch (e) {
    return null;
  }
  return parseSave(text, path);
}
