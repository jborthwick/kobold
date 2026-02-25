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
[ ] Successor dwarves should have a roman numeral of their generation appended to the end of their name. So Bomer's succesor would be Bomer II, and then Bomer III, Bomer IV
[ ] add how a dwarf died to their hud panel for deceased dwarfs. Successors should remember how they predecessors died too.
[ ] Fighters still struggle to catchup and slay goblins they are chasing (they get stuck chasing for long periods)
[ ] Use a configurable sprite for Food depots and ore stockpiles
[ ] bug: LLM crisis calls don't appear to be happening anymore when enabled
[ ] bug: console doesn't clear on page refresh / game restart
[ ] bug: it takes too long for a fighter to catch and slay a goblin, they get stuck in really long chases





Dwarf fort upgrades:
[x] add more space between the food and ore storages
[x] have dwarves build separate rooms around the food and ore storage. but they should be attached as parts of a multi-room fort
[x] dwarves should be able to expand their fort as needed


Questions (don't start without clarifying):
[ ] question: should only a leader dwarf be able to call the llm?