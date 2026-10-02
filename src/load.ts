import JSZip from "jszip";
//import lzs from "lz-string";
import { readYaml, listDir, parseYaml, delay, readTextFile } from "./util";
import { inform, loadingFile, warn } from "./store";
import { fetchText } from "./util";

declare const
  fsData: (path:string)=>string
;

export async function unpackZip(text) {
  let jszip = new JSZip();
  let data = await jszip.loadAsync(text, { base64: true });
  let file = data.file("main");
  text = await file.async("string");
  return text;
}

export async function packZip(text) {
  let jszip = new JSZip();
  jszip.file("main", text)
  let file = jszip.generateAsync({
    type: "base64", 
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    }
  })
  return file;
}

/*async function testzip(){
  let p = await packZip("hello 443")
  console.log("zip", p, await unpackZip(p));  
}

testzip();*/

function parsePackedYaml(text: string) {
  let rul: any = {};
  let data = [];
  let reg = /^FILE: (.+)\n/gm;
  let matches: RegExpExecArray[] = [];
  let match: RegExpExecArray;
  while ((match = reg.exec(text))) matches.push(match);

  for (let i = 0; i < matches.length; i++) {
    let filename = matches[i][1];

    let file: string;
    if (i < matches.length - 1) {
      file = text.substr(
        matches[i].index + 7 + filename.length,
        matches[i + 1].index - matches[i].index - 7 - filename.length
      );
    } else file = text.substr(matches[i].index + 7 + filename.length);

    if (file.substr(1, 3) == "п»ї") file = file.substr(4);

    if (filename.substr(0, 5) == "TEXT@") {
      rul.lang[filename.substr(5)] = file;
      continue;
    }

    let parsed;

    if (filename.substr(0, 5) == "JSON@") {
      parsed = JSON.parse(file);
      filename = filename.substr(5);
    } else {
      try {
        parsed = parseYaml(file, filename);
      } catch (e) {
        console.error(e.message);
      }
    }

    if (filename == "xpedia") {
      rul.config = parsed;
      rul.modName = parsed.mod_name;
      continue;
    }

    if (parsed) data.push(parsed);
  }

  return { ...rul, data };
}

type OXCOptions = { mods: { active: boolean, id: string }[], options: any };

const OXCPath = "/", PediaPath = "";

export async function loadPacked() {
  let packed = window["xpedia"];
  if (packed != null) {
    //let json = lzs.decompressFromBase64(packed)
    let json = await unpackZip(packed);
    let data = JSON.parse(json);
    return data;
  }
}

function onlyDirs(files:string[]){
  return files.filter(dir=>dir[dir.length-1] == "/")
}

/** Folder name of a mod dir like "/user/mods/ReaverHarmony/" -> "ReaverHarmony". */
function dirName(dir: string) {
  let parts = dir.split("/").filter(p => p);
  return parts[parts.length - 1];
}

export async function loadFromFiles() {

  let [options, modDirs, standardDirs, rootDirs, xpediaDirs]: [OXCOptions, string[], string[], string[], string[]] =
    await Promise.all([
      readYaml(`${OXCPath}user/options.cfg`),
      listDir(`${OXCPath}user/mods/`, true),
      listDir(`${OXCPath}standard/`, true),
      listDir(`${OXCPath}`, true),
      listDir(`${PediaPath}mods/`, true)
    ])

  modDirs = onlyDirs(modDirs);
  standardDirs = onlyDirs(standardDirs);
  rootDirs = onlyDirs(rootDirs);
  xpediaDirs = onlyDirs(xpediaDirs);

  if(modDirs.length == 0){
    warn("can't find user/mods dir. Assuming we are in mod dir")
    modDirs = rootDirs;
  }
  
  if(options == null){
    warn("can't find user/options.cfg file. Loading all mods")
  }


  // OXCE looks for mods in standard/ (xcom1, xcom2 and the bundled XcomUtil_*
  // etc. mods) as well as user/mods/. user/mods is listed last so a user copy
  // of a mod overrides the bundled one, as in the game.
  let gameModDirs = [...standardDirs, ...modDirs];
  if (!gameModDirs.includes(`${OXCPath}standard/xcom1/`))
    gameModDirs.unshift(`${OXCPath}standard/xcom1/`);

  let allModDirs = [...gameModDirs, ...xpediaDirs];
  let modMetadataById = {};
  let rawMetadata = await Promise.all(allModDirs.map(dir => readYaml(`${dir}metadata.yml`)))

  let xpediaModIds: string[] = [];
  for (let i in rawMetadata) {
    let data = rawMetadata[i];
    // a missing metadata.yml comes back as the 404 page, which parses to a string
    if(data==null || typeof data != "object")
      continue;
    let dir = allModDirs[i];
    // OXCE uses the folder name when metadata.yml has no id (ReaverHarmony,
    // Better_Ingame_UI, ...). Without this every such mod was stored under
    // "undefined" and silently dropped.
    let id = data.id != null && data.id !== "" ? String(data.id) : dirName(dir);
    modMetadataById[id] = { ...data, id, dir };
    if (xpediaDirs.includes(dir))
      xpediaModIds.push(id);
  }

  let isXpediaMod = (id: string) => xpediaModIds.includes(id);

  // Mods activated in options.cfg, in the options.cfg order. That order is the
  // game's load order, so later mods override earlier ones.
  let optionIds: string[];
  if(options?.mods){
    optionIds = options.mods.filter(m => m.active).map(m => String(m.id));
  } else {
    optionIds = Object.keys(modMetadataById).filter(id => !isXpediaMod(id));
  }

  let activeMaster = optionIds.find(id => modMetadataById[id]?.isMaster) || "xcom1";

  // A master can itself be built on another master (piratez has master xcom1).
  // The game loads the whole chain, base first, so do the same.
  let masterChain: string[] = [];
  for (let id = activeMaster; id && modMetadataById[id]?.isMaster && !masterChain.includes(id); id = modMetadataById[id].master)
    masterChain.unshift(id);
  if (!masterChain.includes(activeMaster))
    masterChain.push(activeMaster);

  // Same rule as the game: a mod loads if it has no master, master "*" (any
  // master), or a master in the active chain. Previously only an exact master
  // id match was accepted, so every "*" mod was dropped.
  const masterOk = (mod) =>
    mod.master == null || mod.master === "" || mod.master == "*" || masterChain.includes(mod.master) || mod.master == "xpedia";

  let activeMods = [
    // xpedia's own common data, under everything
    ...xpediaModIds.filter(id => modMetadataById[id].master == "xpedia"),
    ...masterChain,
    ...optionIds.filter(id => {
      let mod = modMetadataById[id];
      if (!mod) {
        console.warn(`mod "${id}" is active in options.cfg but no folder for it was found (zipped mods are not supported)`);
        return false;
      }
      return !mod.isMaster && masterOk(mod);
    }),
    // xpedia's per-mod extras (e.g. piratez_xpedia), on top of their mod
    ...xpediaModIds.filter(id => {
      let mod = modMetadataById[id];
      return mod.master != "xpedia" && masterChain.includes(mod.master) && (mod.active !== false);
    })
  ].filter((id, i, all) => modMetadataById[id] && all.indexOf(id) == i);

  let activeModsMetadata = activeMods.map(id => modMetadataById[id])
  for (let mod of activeModsMetadata)
    mod.rulDir = mod.dir;

  let langDirs: string[] = [];
  for (let m of activeModsMetadata) {
    langDirs.push(`${m.dir}Language/`);
    if (m.isMaster)
      langDirs.push(`${m.dir}Language/OXCE/`);
  }

  let [ruls, langs] = await Promise.all(
    [loadRulsFromMods(activeModsMetadata),
    loadLanguagesFromDirs(langDirs)]
  );
  
  return { ruls, langs, mods: activeModsMetadata }
}

/** Folders that only hold game assets. Skipped when scanning for .rul files. */
const assetDirs = new Set(["language", "maps", "routes", "terrain", "resources", "sound", "sounds", "music", "units", "geograph", "geodata", "ufograph", "ufointro", "images", "sprites"]);

/** OXCE loads every .rul file anywhere under the mod folder, not only in Ruleset/. */
async function listRulsRecursive(dir: string, depth = 0): Promise<string[]> {
  let entries = await listDir(dir);
  let ruls = entries.filter(name => name.toLowerCase().endsWith(".rul")).map(name => dir + name);
  if (depth < 4) {
    let subdirs = entries.filter(name => name.endsWith("/") && !assetDirs.has(name.slice(0, -1).toLowerCase()));
    let nested = await Promise.all(subdirs.map(sub => listRulsRecursive(dir + sub, depth + 1)));
    ruls.push(...nested.flat());
  }
  return ruls;
}

const extRegexp = /^(.+)\.([0-9a-z\-]+)?$/i;

function splitName(name){
  let m = name.match(extRegexp);
  return m?{body:m[1],ext:m[2]}:{body:name,ext:""};
}


async function loadLanguagesFromDirs(dirs: string[]) {

  let langFiles = await Promise.all(dirs.map(path => listDir(path)));
  let files: { lname: string, dir: string }[] =
    langFiles.map(
      (list, dirInd) => list.filter(file => ["yml", "html", "txt"].includes(splitName(file).ext))
        .map(lname => ({ lname, dir: dirs[dirInd] }))
    ).flat();

  let lng = {};
  //let files: { lname: string, dir: string }[] = lnames.map(lname => dirs.map(dir => ({ lname, dir }))).flat(1);

  let data = await Promise.all(files.map(f => {
    let path = `${f.dir}${f.lname}`;
    return splitName(f.lname).ext == "yml"?readYaml(path):readTextFile(path);
  }))

  for (let i in data) {
    let text = data[i];
    let fname = files[i].lname;
    if (typeof text == "object") {
      let lname =  Object.keys(text)[0]
      lng[lname] = { ...(lng[lname] || {}), ...text[lname] }
    } else {
      let split = splitName(fname);
      if(split.ext != "yml"){
        let split2 = splitName(split.body);
        lng[split2.ext] = lng[split2.ext] || {};
        lng[split2.ext][split2.body] = text;
      }
    }
  }

  return lng;
}

async function loadRulsFromMods(mods: { id: string, rulDir: string, dir: string }[]) {
  let dirLists = await Promise.all(mods.map(mod => listRulsRecursive(mod.rulDir)));
  let files = mods.map((mod, i) => dirLists[i].map(path => ({ mod: mod.id, path, modDir: mod.dir }))).flat(1);
  let ruls = await Promise.all(files.map(async file => {
    let data = await readYaml(file.path);
    return { ...data, file }
  }))
  return ruls;
}

/**
 * Identifies the game install the cache was built from. The cache lives in the
 * browser's IndexedDB for http://localhost:2601, which is the same origin for
 * every xpedia install - so running xpedia from an XPiratez folder and then from
 * another mod's folder showed the cached XPiratez data. Keying the cache on the
 * active mod list and mod folders makes it rebuild when they change.
 */
async function cacheKey() {
  let [options, mods] = await Promise.all([
    Promise.resolve().then(() => fetchText(`${OXCPath}user/options.cfg`)).catch(() => ""),
    Promise.resolve().then(() => fetchText(`${OXCPath}user/mods/`)).catch(() => "")
  ]);
  let activeMods = (options.match(/^mods:[\s\S]*?(?=^\S)/m) || [options])[0];
  return `${location.pathname}|${activeMods}|${mods}`;
}

export function useCache(data, key?: string) {
  return new Promise((done) => {
    let request = indexedDB.open("xpedia", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore("cache", { keyPath: "id" })
    }

    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("cache", "readwrite");
      const store = transaction.objectStore("cache");

      if (data == "load"){
        const query = store.get(1);
        query.onsuccess = () => {
          let data = query.result?.data;
          if (key != null && query.result?.key !== key) {
            done(null);
            return;
          }
          done(data?JSON.parse(data):null);
        };        
      } else {
        if(data == "wipe")
          store.delete(1);
        else
          store.put({ id: 1, key, data: JSON.stringify(data) });
        done([]);
      }

      transaction.oncomplete = () => {
        db.close();        
      }
    }
  })
}


export let packedData;

export async function loadRules(rul) {
  loadingFile.set("loading from js")
  let data = await loadPacked();
  if (data) {
    packedData = true;
    loadingFile.set("")
    await delay(10);
  } else {
    loadingFile.set("loading from cache")
    let key = await cacheKey();
    data = await useCache("load", key);
    if(!data){
      loadingFile.set("loading from local files")
      data = await loadFromFiles();
      useCache(data, key);
    }
  }

  if(data == null){
    warn("Failed to load rules")
    return;
  }

  inform("parsing")
  rul.load(data);
  await delay(10);
}

export async function loadData(path:string){
  if(typeof fsData != "undefined"){
    return fsData(path);
  } else {
    return path;
  }
}

export async function readStyle(id:string){
  let css = document.getElementById(id) as HTMLLinkElement;
  return css.href?(await (await fetch(css.href)).text()):css.innerHTML;    
}

