import { get, writable } from 'svelte/store';

export const revealed = writable(false);
let revealedLock = false;

export const markersLoaded = writable(false);

export const linksPageSorted = writable(false);
export const loadingFile = writable("");
export const leftRightClickSwipe = writable(null);

export function reveal(on?) {
  if(!revealedLock)
    revealed.update(v => on==undefined?!v:on);
}

export function revealLock(on?) {
  revealedLock = on==undefined?!revealedLock:on;
  revealed.update(v => revealedLock);
}

export const loaded = writable(false);

export function warn(text:string){
  loadingFile.update(t => t + " · <em class='warning'>" + text + "</em>");  
}

export function inform(text:string){
  loadingFile.update(t => t + " · " + text);  
}


/**
 * The campaign save, shared between CENTCOM and the tech tree.
 *
 * Both screens answer questions about the same campaign, so picking a save in
 * one and finding the other still on the last is just annoying. The PATH alone
 * could ride in localStorage - and did - but that is not enough for two
 * reasons: a save dropped in as a file has no path to re-fetch it from and
 * would be lost on the next tab switch, and re-parsing on every switch is work
 * for nothing.
 *
 * So the parsed state travels too. `droppedSaves` keeps anything handed over by
 * picker or drag, keyed by the name it arrived under, for exactly as long as
 * the page lives.
 */
export const currentSave = writable(null);
export const currentSavePath = writable("");

/** Saves read from a File rather than a URL. No path to fetch them back from. */
export const droppedSaves = new Map<string, any>();

/** Set both halves at once, so no subscriber ever sees a mismatched pair. */
export function setCurrentSave(path: string, state: any) {
  currentSavePath.set(path || "");
  currentSave.set(state || null);
}

/**
 * A save soldier PAX asked CENTCOM to open, by Soldier.id. CENTCOM selects them
 * and clears this, so it fires once - a stale value must not hijack the picker
 * the next time CENTCOM is visited.
 */
export const centcomSoldier = writable("");
