TODO:
[x] More things should add memories: sharing food, being attacked by goblins, slaying goblins, etc
[x] move the dwarf hud into its own panel
[x] Extend dwarf memory to uncapped (instead of capped at 5)
[x] Give each dwarf a starting trait (e.g. lazy, forgetful, helpful, mean, paranoid, etc)
[x] Give each dwarf a quirky starting bio (e.g. "is far from home", "loves his dog", "never learned to swim", )
[x] Give each dwarf a personal goal
[x] 5 goblins spawn at the beginning and wander, instead of just later as a raid
[x] dwarves shouldn't yield to dead dwarves while foraging (d.alive check already present)

[x] dwarf hud should not have less opacity for dead dwarves
[x] use a tombstone sprite for dead dwarves instead of a flipped red dwarf
[x] ore is gathered to another community stockpiole
[x] dwarves can use ore to create walls
[x] dwaves try to build fortified spaces around the depot and stockpile (enclosed areas surrounded by walls)
[x] memories: each hit by a goblin should not create a memory
[x] memories: building fort walls should not create a memory
[x] console: make it less noisey (remove each health update, each wall placement, etc)
[x] have minors favor ore over food when they have enough food
[x] have dwarves favor finding food over their base goals (i.e. fighter chasing goblins) at certain hunger/health thresholds
[x] Dwarves should only remember resouces (food, etc) that they can act on (e.g. they should not remember trees cause they can only forage mushrooms)
[x] Dwarves should remember general patches/fields of resources, not specific tiles. So if there's a group of 10 mushrooms, they only remember that as one patch, not as 10 distinct resources.
[x] bug: the dwarf panel used to show the llm messages, but i'm not seeing it anymore
[x] bug: dwarves can get stuck yielding to each other for long bouts
[x] update dwarf HUD panel to show inventory (food, ore, etc)
[x] hide vision and metabolism from the dwarf HUD panel
[x] if dwarf inventory is full, they should probably return home to unload. sometimes the get stuck out in a field with a full inventory.
[x] The fighter needs an easier way to chase down goblins they find. Goblins should move slightly slower than dwarves, or a fighter should be able to speed up when chasing goblins
[x] Successor dwarves should have a roman numeral of their generation appended to the end of their name. So Bomer's succesor would be Bomer II, and then Bomer III, Bomer IV
[x] add how a dwarf died to their hud panel for deceased dwarfs. Successors should remember how they predecessors died too.
[x] Fighters still struggle to catchup and slay goblins they are chasing (they get stuck chasing for long periods)
[x] Use a configurable sprite for Food depots and ore stockpiles
[x] bug: console doesn't clear on page refresh / game restart
[x] bug: it takes too long for a fighter to catch and slay a goblin, they get stuck in really long chases. maybe add a stagger state to enemies after the get hit for a few ticks to allow the fighter to catchup?
[x] Allow resource tiles (mushrooms, ore, etc) to be depleted and removed (turned back into dirt)
[x] Allow new mushroom patches to appear on map every so often
[x] Rename depots to stockpiles for all resources types to simplify language
[ ] new feature: add a new 'lumberjack' dwarf class that harvests trees and adds them to a new stockpile type (wood)
[x] update dwarf panel to keep a history of every response and integrate responses and memories into a single list along by tick time
[x] Remove the text label from stockpiles
[x] Make stockpiles clickable to see their information, like dwarves.
[x] Make goblins (enemies in general) clickable to see their information, like dwarves
[x] Dwarves (and enemies) can still get stuck in walls as they're being built
[x] Allow camera panning past the edges of the map (since the conosle/HUD covers a good portion of the scren)
[x] bug: i think goblins are no long staggering when hit, fighters are chasing them forever again
[x] Add when goblins are slain to the console
[x] Add any new dwarf memories to the console
[x] Remove crisis start/end from console for now as its spamming
[x] Make console history persist through the whole session (so you can scroll back through it)
[x] Relationship status of the deceased should be told to successors (just like death cause)
[x] Update zoom to be smoother and/or less sensitive. right now just barely touching zoom throws us to the max or min levels

Dwarf fort upgrades:
[x] add more space between the food and ore storages
[x] have dwarves build separate rooms around the food and ore storage. but they should be attached as parts of a multi-room fort
[x] dwarves should be able to expand their fort as needed
[x] Investigate fort design. after the first few rooms the builder starts just encircling the already created rooms instead of expanding the fort with more rooms.
[ ] Let builders add doors as part of the wall building
[ ] Add a goal of enclosing the whole fort eventually, so there's only a few doors to get in and out

