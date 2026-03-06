## Features
First iteration of player build tools:
[X] Instead of the game starting with three stockpiles and goblins hardcoded to build walls around them: the player will now determine where to place rooms. 
[X] Placing a room is like delegating a zone in simcity. The player first choose a room type form a menu (e.g. storage), and can mouse over the map. The cursor should show a preview of where the room will be placed when clicked. 
[X] After clicking to place a room, the land should be stamped a tint for that room type, and goblins can start using it
[X] Goblins should feel a need to enclose rooms (build walls around expased sides, but always leave doorways)
[X] Storage rooms should be 5x5 generic rooms.
[X] Once a storage room has been designated, goblins are elligible to build a stockpile. 
[X] Once a stockpile a built, goblins should only want to place other materials of that type in the room. E.g. a generic storage room becomes the lumber storage room after a goblin places the first stockpile. 
[X] Goblins should add the stockpile room most needed by the colony to new storage rooms.
[X] Goblins shouldn't start new lumber storage rooms if there's already one thats elligible
[ ] Allow rooms to be buildable anywhere, not just in the spawn area
[ ] Move the build menu out of the world hud. Assume we'll have more room types and update the menu accordingly
[ ] Plan: investigate adding weather effects (rain, snow, storms, lightning, etc)
[ ] Shrink the minimap by half


## Bugs:
[X] Loop: goblins sometimes get stuck in 2 tile loops, pivoting between "foraging" and "hearthsite" and doing neither until another need forces a redirection
[X] Firefighting: another 2 tile loop of a goblin toggling between "forest" and "Water" targets forever until they starved. 
[X] World Gen: There's often a super gigantic patch of mushrooms at the spawn point. Mushroom patches should be smaller, but more frequent. (i think the spawn zone picker is finding a giant patch and choosing it)
[ ] bug: saw a goblin keep harvesting even though they were extremely hungry. and only stopped once their health dropped super low. at that point they went and gathered mushrooms.
[ ] After building a room, you should be able to stamp more rooms until pressing cancel.
[ ] Loop: goblins move between two tiles forever, "remembering ore vein" and "hearthsite"

