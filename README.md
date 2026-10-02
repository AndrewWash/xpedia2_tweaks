# xpedia2
XPEDIA NOW WORKS WITH ALL MODS

Sequel to https://github.com/baturinsky/xpedia

I'm changing a lot of things around, so have created it as a separate ptoject.

version 1.0 done.

# What's new 

*COMPARE - simple compare module to run two xpedia entries side-by-side. Highlights differences. "this or that"
*CENTCOM - Load save and view how weapons stack against one another for different enemy types for individual soldiers. 
*TECH - tech tree viewer. Load current save to parse available tech or search for ANY item/subject in the game and figure out how to get it from research, craft, enemies, etc. 

# How to use

put xpedia2 folder in your main game folder somewhere.

YOU MUST RENAME THE FOLDER TO JUST 'XPEDIA2'
click on xpedia.bat
export, or not. you can just click xpedia.bat each time if you'd like.
alternatively you can:

Command prompt and cd "path to game directory/xpedia2"
npm install
npm start
export
Do this each time you want use a different mod. I would recommend having seperate game folders for each game version to avoid conflicts. So like a xpiratez folder, an xcomfiles folder, 40k, reavers harmony, etc. dont put two mega mods in the same game folder.
---other notes
Have https://nodejs.org installed.

Open command prompt, CD to xpedia folder (placed in game dir)

Run `npm install` (or `yarn install` if you use) then `npm start`

It will read user settings to find out which mods and submods to use, then open the page.

If you run xpedia this way, you can click "Export" button on the main page

