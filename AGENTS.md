## Competition Background
Background: js13kGames is a web game development competition known for its 13KB size limit. We jam from 13 August, 13:00 CEST to 13 September, 13:00 CEST — each year since 2012.

The theme this year is Unicorns and Rainbows.


## Competition Rules

### Your game must not exceed 13KB
Your game's code and assets must be zipped into a .zip archive with ≤ 13,312 bytes*.

The archive must contain an index.html file in the top level directory, and it must work in the browser once unzipped, allowing your game to be played straight away.

### No external resources
All game assets, data and code must be contained in your .zip.

Specific categories (like WebXR) may allow fine-grained exceptions, but reliance on external assets will exclude your game from the overall ranking.

### Theme: Unicorns and Rainbows
The theme is a rating criterion and impacts your score, but you are free to interpret and implement it however you think is best.

### Categories
Our 2 base categories, Desktop and Mobile, are fully covered by these rules.

### Use the source, Luke!
The competition focuses on size, but we value knowledge sharing just as much. The submission form will ask you to provide two sources of your game:
- Playable: your zipped game package,
- Readable: a GitHub repository with readable, unmangled source code.

Your repository should contain the entire source code needed to actually build your game — not just an unzipped version of it. We clone that repository for posteriority under the js13kGames organization on GitHub as a learning resource for others. You are free to continue working on your game past its submission (we'll have a snapshot of the version you submitted).

### Make sure it works
Your game must work and be playable in at least two browsers: latest Chrome and Firefox. There must be no console errors.

Other errors during gameplay can negatively affect your ratings as voters take them into account, but will not disqualify your game.

### Be neighbourly
Be mindful of shared resources and only touch data you are sure is yours. Games on our site share the same origin, so if you use localStorage — prefix your keys with a unique namespace. Do not use localStorage.clear() as it would affect all games.

### New content only
Do not submit old games or demos. You have a whole month to work on something creative, and that's more than enough time. Verbatim Breakout or Flappy Bird clones out of tutorials defeat the purpose of actual learning and are frowned upon by our community (which will reflect in poor ratings for your game). Cool, fresh ideas — even lacking in technical finesse — are in turn a very welcome sight.

You can, however, enrich your game with already existing content and resources, as long as you have the (legal) right to use them and it's in line with all other rules.

### Licensing
You must have the rights to use and publish every asset used in your game. We are generally lenient — except when it comes to violations of the rights of others.

At the same time we'll do our best to help you protect your rights: please report anyone who distributes your game without your consent. For the legalese, see Copyright ownership.

### Teams
You can work on your game with anyone you want. Just remember that prizes are limited, so you'll have to share your trophies with your teammates. Naturally, everyone on your team should also conduct themselves excellently towards others.

### Drafts & submissions
You can register a draft and preview your game live before you fully submit.

You may submit more than one game, but you can only have a single draft open at a time. Sending the same game as independent submissions targeting different platforms (e.g. separate desktop and mobile builds) is forbidden.

### Acceptance
We review submissions manually, which can take a couple of days. We reserve the right to reject any submission without giving a reason, although we strive to let you resolve any issues instead of simply rejecting your game.

### Deadlines
Submissions: 13 August, 13:00 CEST to 13 September 2026, 13:00 CEST
Unfinished: 14 September 2026
You may still submit your draft as unfinished. Unsubmitted drafts will be deleted otherwise.
Bugfixes: 14 September 2026
You may still still submit a PR to fix minor issues. Every change must be clearly documented in a GitHub pull request that will be manually reviewed. PRs containing new features will be rejected.
Voting: 14 September to 4 October 2026
You may still submit a PR to fix critical issues that prevent your game from being played or finished.


## The game
- A 13kb unicorn clone of Hyper Light Drifter.
- Easier combat, tuned for judges to have fun stomping bad guys.
- Programmatic level generation is core to levels, eg I can say “this tile is grass”, and the game has a concise function to draw some for me. Repeatable nicely.
- Properly scoped: ~3 mini levels, one boss. Plus one wave arena or something if there is space.
- Player character is a unicorn, melee attack with horn, charges your rainbow laser ranged weapon.
- Movement is tight; dash, rainbow bridge across gaps, etc.
- Something that captures HLD and makes you think what the game could be past a 13kb restriction.

- The setting is generally grass, water, ruins/rubble, very HLD. An overgrown sacred landscape that has fallen apart. Think broad green plateaus, brilliant blue water, collapsed white-stone temples, broken bridges, half-buried statues, strange geometric machinery still humming in the ruins.
- The player-unicorn fights Constructs; ancient stone/prismatic machines that still defend parts of the landscape. Imagine floating cubes or walker/crab/turtle style cubes. Great excuse for simple geometric sprites and very readable attack patterns.


## Development tooling
There is no browser in this toolchain, so two dev-only scripts stand in for one:

- `npm run preview:art -- <out.png> [x,y,w,h]` bakes the real terrain headless and
  writes a PNG. With a crop it also applies a stand-in for the runtime light
  shafts and colour grade, so a crop previews roughly what the player sees.
  Those numbers are duplicated from `game.js` and must be kept in step by hand.
- `npm test` runs the terrain, editor and game smoke checks. The game smoke
  imports the real `game.js` against a stubbed DOM and runs 240 frames; it is
  the only automatic check that a render change still executes.

Terrain art assertions are deliberately split: flat structural stone is checked
against the exported `STONE` palette by name, while ground materials carry tonal
noise and are checked as a shade of the material within a tolerance.

## Working style
Keep the size limit in mind, advise the user and alert them to costly work/directions. Do not code golf or use confusing one-letter variable names unnecessarily, unless explicitly asked.

Comments aren't included in the final zip file, but are helpful for the "Use the source, Luke!" rule; ensure the use of docblocks and comments throughout, explaining why, not what.

Use BEM for class and ID names. Keep styling clustered together and easy to understand/change - a class shouldn't have multiple styling rule blocks across different areas of the style.css file.

Do not apply CSS styling in the JS if it can be avoided. Prefer adding/removing classes, so all styling can be managed in one place.

Prefer UI/HUD elements in the DOM where possible and sensible.