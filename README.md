# xpedia2
Check out https://baturinsky.com/xpedia for live version with N.1 XPiratez loaded in

Sequel to https://github.com/baturinsky/xpedia

I'm changing a lot of things around, so have created it as a separate ptoject.

Currently WIP.

# What's new 

*COMPARE - simple compare module to run two xpedia entries side-by-side. Highlights differences. "this or that"
*CENTCOM - Load save and view how weapons stack against one another for different enemy types for individual soldiers. 
*TECH - tech tree viewer. Load current save to parse available tech or search for ANY item/subject in the game and figure out how to get it from research, craft, enemies, etc. 

* Planned:
* * Better support for multiple mods - planned, not done.

# How to use

Unpack or clone it into a subdir of the game.

Have https://nodejs.org installed.

Open command prompt, CD to xpedia folder (placed in game dir)

Run `npm install` (or `yarn install` if you use) then `npm start`

It will read user settings to find out which mods and submods to use, then open the page.

If you run xpedia this way, you can click "Export" button on the main page

