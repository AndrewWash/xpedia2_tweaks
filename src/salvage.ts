/**
 * What "battlefield salvage" actually means, in names rather than in numbers.
 *
 * An item with a `specialType` is not picked up off the floor. It is what you
 * get for clearing a particular kind of TILE - a downed craft's engine housing,
 * a ruined machine - and the ruleset says nothing at all about which tile that
 * is. All it gives you is a number: Necroplane Parts are specialType 104, and
 * "recovery type 104" is not an answer to any question a player has.
 *
 * The other half of the mapping lives in the MCD files, the binary tile
 * definitions next to the maps. Each MCD record is 62 bytes and byte 59 is the
 * tile's Target_Type - the same number. So reading them turns
 *
 *     Necroplane Parts -> 104
 *
 * into
 *
 *     Necroplane Parts -> the CRASHEDPLANE tileset
 *                      -> the craft and terrains built from it
 *                      -> the missions those terrains appear on
 *
 * which is the chain the player wanted in the first place.
 *
 * WHY THIS IS WORTH 1.5MB OF FETCHES: it is read once, in the background, and
 * only the derived table - about seventy numbers and a few hundred names - is
 * kept or cached. The MCD bytes are thrown away as each file is parsed.
 *
 * WHAT IT DOES NOT DO: it does not say how many of the item one tile yields,
 * or whether a given map block actually places that tile. Both live in the map
 * files, not the tileset, and guessing would be worse than saying nothing.
 */
import { rul } from "./Ruleset";
import { listDir } from "./util";

/** One MCD record. Byte 59 of each is the tile's Target_Type. */
const MCD_RECORD = 62;
const MCD_TARGET_TYPE = 59;

const CACHE_KEY = "xpediaSalvageIndex";

/** specialType -> tileset name -> how many tile types in it carry that type. */
let index: { [type: number]: { [set: string]: number } } = null;
let pending: Promise<void> = null;
let problem = "";

/** True once the scan has finished (or come back from cache). */
export const salvageReady = (): boolean => index != null;

/** Why there is nothing to show, or "". */
export const salvageProblem = (): string => problem;

/**
 * Every directory that could hold tilesets: one per active mod, plus the base
 * game's own, which live outside the mod tree entirely.
 */
function terrainDirs(): string[] {
  const out = new Set<string>();
  const mods: any = rul.mods;
  for (const m of Array.isArray(mods) ? mods : Object.values(mods || {}))
    if (m && (m as any).dir) out.add((m as any).dir + "TERRAIN/");
  out.add("/UFO/TERRAIN/");
  out.add("/TFTD/TERRAIN/");
  return [...out];
}

async function mcdFiles(dir: string): Promise<string[]> {
  let names: string[] = [];
  try {
    names = await listDir(dir);
  } catch (e) {
    return [];
  }
  return names.filter((n) => /\.mcd$/i.test(n));
}

/**
 * Read one MCD and report which Target_Types it defines.
 *
 * Only the counts survive; the buffer is dropped on return, which is what keeps
 * the whole scan's peak memory at one file rather than at 1.5MB.
 */
async function scanFile(path: string): Promise<number[]> {
  let buf: ArrayBuffer;
  try {
    const res = await fetch(path);
    if (!res.ok) return [];
    buf = await res.arrayBuffer();
  } catch (e) {
    return [];
  }
  const bytes = new Uint8Array(buf);
  const out: number[] = [];
  for (let i = 0; i + MCD_RECORD <= bytes.length; i += MCD_RECORD) {
    const t = bytes[i + MCD_TARGET_TYPE];
    if (t) out.push(t);
  }
  return out;
}

/**
 * A fingerprint over the actual tileset file list, so the cache is rebuilt when
 * the installed mods change.
 *
 * FNV-1a over every "dir/name", not the joined string's LENGTH, which is what
 * this used to be - that would have missed a tileset being renamed, swapped for
 * another of the same name length, or moved between mods, and handed back a
 * stale table with no way to tell.
 */
function signature(files: { dir: string; name: string }[]): string {
  let h = 0x811c9dc5;
  const all = files
    .map((f) => (f.dir + f.name).toLowerCase())
    .sort()
    .join("\n");
  for (let i = 0; i < all.length; i++) {
    h ^= all.charCodeAt(i);
    // The usual FNV prime, via shifts so it stays in 32-bit integer maths.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return files.length + ":" + h.toString(16);
}

/**
 * Build the specialType table, from cache when the tilesets have not changed.
 *
 * Safe to call repeatedly: the first call owns the work and every later one
 * waits on the same promise.
 */
export function loadSalvageIndex(): Promise<void> {
  if (index) return Promise.resolve();
  /**
   * A standalone export carries the finished table with it.
   *
   * The exported HTML has no mod directory to read, so scanning is not an
   * option there - without this the salvage breakdown would degrade to "no
   * tileset files found" in every exported copy. See exportPedia.
   */
  const packed = window["xpediaSalvage"];
  if (packed && typeof packed == "object") {
    index = packed as any;
    return Promise.resolve();
  }
  if (pending) return pending;

  pending = (async () => {
    try {
      await scan();
    } catch (e) {
      // Never leave `index` null: the UI reads that as "still loading" and
      // would sit on a spinner for the rest of the session. An empty table
      // renders the honest "cannot name the tiles" branch instead.
      problem = "Could not read the tileset files, so the tiles this comes from cannot be named.";
      index = {};
    }
  })();

  return pending;
}

async function scan(): Promise<void> {
    const dirs = terrainDirs();
    const lists = await Promise.all(dirs.map(mcdFiles));
    const files: { dir: string; name: string }[] = [];
    for (let i = 0; i < dirs.length; i++)
      for (const name of lists[i]) files.push({ dir: dirs[i], name });

    if (!files.length) {
      problem = "No tileset (.MCD) files found, so the tiles this comes from cannot be named.";
      index = {};
      return;
    }

    const sig = signature(files);
    try {
      const raw = JSON.parse(localStorage[CACHE_KEY] || "null");
      if (raw && raw.sig == sig && raw.index) {
        index = raw.index;
        return;
      }
    } catch (e) {
      // A bad cache is just a rescan.
    }

    const built: { [type: number]: { [set: string]: number } } = {};
    // Batched rather than 650 at once: a browser will happily queue that many
    // and then stall every other request on the page behind them.
    const BATCH = 24;
    for (let i = 0; i < files.length; i += BATCH) {
      const slice = files.slice(i, i + BATCH);
      const found = await Promise.all(slice.map((f) => scanFile(f.dir + f.name)));
      for (let j = 0; j < slice.length; j++) {
        const set = slice[j].name.replace(/\.mcd$/i, "").toUpperCase();
        for (const t of found[j]) {
          if (!built[t]) built[t] = {};
          built[t][set] = (built[t][set] || 0) + 1;
        }
      }
    }

    index = built;
    try {
      localStorage[CACHE_KEY] = JSON.stringify({ sig, index: built });
    } catch (e) {
      // Too big for localStorage, or blocked. The scan still worked.
    }
}

/** Tilesets that define a given specialType, biggest contributor first. */
export function setsForType(type: number): { name: string; tiles: number }[] {
  if (!index || !type) return [];
  const hit = index[type];
  if (!hit) return [];
  return Object.keys(hit)
    .map((name) => ({ name, tiles: hit[name] }))
    .sort((a, b) => b.tiles - a.tiles || (a.name < b.name ? -1 : 1));
}

/**
 * Which terrains and craft are built from each tileset.
 *
 * Pure ruleset, unlike the table above - `terrains[].mapDataSets` and a craft's
 * `battlescapeTerrainData.mapDataSets` both name their tilesets outright.
 * Memoised, since neither changes under us.
 */
let usage: { [set: string]: { terrains: string[]; crafts: string[] } } = null;

function buildUsage() {
  if (usage) return;
  usage = {};
  const add = (set: string, kind: "terrains" | "crafts", id: string) => {
    if (typeof set != "string") return;
    const key = set.toUpperCase();
    if (!usage[key]) usage[key] = { terrains: [], crafts: [] };
    if (!usage[key][kind].includes(id)) usage[key][kind].push(id);
  };

  for (const t of Object.values<any>(rul.terrains || {}))
    for (const s of t.mapDataSets || []) add(s, "terrains", t.id);

  // Craft carry their tilesets one level down, on the wreck terrain they turn
  // into when you shoot them down - which is exactly the thing being salvaged.
  for (const u of Object.values<any>(rul.ufos || {}))
    for (const s of (u.battlescapeTerrainData && u.battlescapeTerrainData.mapDataSets) || [])
      add(s, "crafts", u.id);
  for (const c of Object.values<any>(rul.crafts || {}))
    for (const s of (c.battlescapeTerrainData && c.battlescapeTerrainData.mapDataSets) || [])
      add(s, "crafts", c.id);
}

export function usersOfSet(set: string): { terrains: string[]; crafts: string[] } {
  buildUsage();
  return usage[(set || "").toUpperCase()] || { terrains: [], crafts: [] };
}

/** The finished table, for packing into a standalone export. */
export function salvageIndex(): { [type: number]: { [set: string]: number } } {
  return index || {};
}

/* No reset hook - see the note in techTree.ts. */
