## Features
[ ] Plan: investigate adding visual weather effects (rain, snow, storms, lightning, etc) -- rain/storm/lightning/cold in
[X] Update build menu user flow to be: 1. click room type to build. 2. stamp room 3. stop building automatically. And then remove the stop building button since it will no longer be needed.
[X] Allow the player to cancel a build with ESC or by clicking the selected room again in the build menu.
[X] Update zooming to be much more responsive. its very slow.


## Bugs:
[X] Loop: goblins sometimes get stuck in 2 tile loops, pivoting between "foraging" and "hearthsite" and doing neither until another need forces a redirection
[X] Firefighting: another 2 tile loop of a goblin toggling between "forest" and "Water" targets forever until they starved. 
[X] bug: saw a goblin keep harvesting even though they were extremely hungry. (Fixed via AI utility scoring rebalance)
[X] After building a room, you should be able to stamp more rooms until pressing cancel.
[X] Loop: goblins move between two tiles forever, "remembering ore vein" and "hearthsite"
[X] Tree and mushroom tiles are appearing on top of (and thus hiding) goblin and fire tiles. My guess is there are other layering issues with other tile types. do a sanity check of our layering system.
[X] Remove the "{goblin} is starving" messages that are flooding the console
[X] Room building shouldn't allow being placed on Stone and Ore tiles. It does logically, but graphically it appears on top of them.
[X] The wild fire sprite is no longer visible when a fire is spreading
[X] Overlay no longer can be activated by pressing O
[X] Can no longer cycle through goblins with brackets
[X] Loop: goblins sometimes move between two tiles in a loop for a long while, between "remembering site" and "foraging"

