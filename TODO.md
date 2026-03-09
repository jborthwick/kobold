
## Features
[x] Change first goal to: build 3 storage rooms and a kitchen
[x] Update colony HUD to also track meals stored (along with food, wood, and ore)
[x] Add meals in inventory to goblin HUD
[x] Add oscillation logging to headless to catch goblins stuck in a loop between 2 or 3 squares for extended periods
[ ] Remove goblin roles, and allow roles to be naturally defined by colony needs at first, and eventually influenced with what skills they're best at via the experience systsem
[ ] Instead of building generic storage rooms and having goblins designate them, turn storage rooms in specialized rooms. 
- [ ] Generalize storage rooms. Any kind of stockpile can go in here at all times.
- [ ] New room: Lumber Hut
- - [ ] Comes with 1 saw tool. Saws convert wood into planks over a brief time.
- - [ ] Comes with 1 wood stockpile in a corner.
- - [ ] Up to 3 wood stockpiles can be built in the lumber hut
- [ ] New room: Blacksmith
- - [ ] Comes with 1 anvil tool. Anvils convert ore into bars over a brief time.
- - [ ] Comes with 1 ore stockpile in a corner.
- - [ ] Up to 3 wood stockpiles can be built in the lumber hut.

- [ ] Update headless to mockup new room placement and remove multiple storage rooms at gen


## Bugs:
[X] bug: Adventurers explore range seems too limited
[X] bug: Constant glow GFX around danger (e.g. adventurer) is hidden by tree tiles. The glow effect should be at the top of all the tile layers.
[X] bug: Saw goblins sit in the kitchen (on top of the meals stockpile) for hundreds of ticks with the label "mining.. looking for vein". But really just waiting for hunger to tick up and then eating a meal from the stockpile.
[X] bug: running headless shows 50% of time is spent "mining ... lookking for vein". way more than any other action



