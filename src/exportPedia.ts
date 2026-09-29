import { defaultLanguage, rul } from "./Ruleset";
import { readStyle, packZip } from "./load";
import { loadSalvageIndex, salvageIndex } from "./salvage";

export async function exportPedia(onlyCurrentLanguage = false) {
  document.body.style.cursor = "wait";
  /**
   * The tileset table has to be computed HERE, while the mod directory is still
   * reachable. The exported file has no mods to read, so it can only ever carry
   * a table someone else built for it - without this, every export loses the
   * "battlefield salvage" breakdown and says the tilesets cannot be found.
   */
  await loadSalvageIndex();
  let jsPath = (document.getElementById("xpedia-js") as HTMLScriptElement)?.src;
  let js = await (await fetch(jsPath)).text();
  let style = await readStyle("main-css");
  let lightStyle = await readStyle("light-css");

  /**
   * Carry the theme you are looking at into the file.
   *
   * light.css is an override switched on by clearing its `media`, so writing a
   * fixed value would export a page that ignores your choice. Read the live
   * attribute instead; `xpediaTheme` seeds the same answer for the first run,
   * before the exported file has any localStorage of its own.
   */
  const lightMedia =
    document.getElementById("light-css")?.getAttribute("media") == "none" ? "none" : "";

  let src = rul.src;

  if (onlyCurrentLanguage) {
    let langs = {} as any;
    langs[defaultLanguage] = src.langs[defaultLanguage];
    langs.icon = src.langs.icon;
    let langName = rul.langName;
    if (langName != defaultLanguage) {
      langs[langName] = src.langs[langName];
    }
    src = { ...src, langs };
  }

  //let packed = lzs.compressToBase64(JSON.stringify(rul.src))
  let packed = await packZip(JSON.stringify(src));

  //debugger;
  let html = `
<head>
  <meta name="description" content="Online reference for OpenXCom games" />
  <style id="main-css">${style}</style>
  <style id="light-css" media="${lightMedia}">${lightStyle}</style>
  <script>
  window.xpediaTheme = "${lightMedia == "none" ? "dark" : "light"}";
  window.gameDir = ".";
  window.xpediaDir = "xpedia2/";
  window.xpedia = "${packed}";
  window.xpediaSalvage = ${JSON.stringify(salvageIndex()).replace(/</g, "\\u003c")};
  window.GlobeMarkers = "${window["GlobeMarkers"]}"
  clog = (...args)=>{}
  </script>
  <script>${js}</script>
</head>`;

  download("xpedia.html", html);
  document.body.style.cursor = "default";
}

//For possible app implementations
declare const
  fsSave: (name: string, data: string) => string
  ;

export function download(filename, text) {
  if (typeof fsSave != "undefined") {
    fsSave(filename, text)
    return
  }
  var element = document.createElement("a");
  element.setAttribute(
    "href",
    "data:text/plain;charset=utf-8," + encodeURIComponent(text)
  );
  element.setAttribute("download", filename);

  element.style.display = "none";
  document.body.appendChild(element);

  element.click();

  document.body.removeChild(element);
}

