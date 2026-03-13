
## Features
[x] ~~Audit why goblins aren't cooking 32 meals to reach goal 2~~ — Fixed by rebalancing cooking/smithing scores
[x] ~~Fire should eventually burn out on its own and not spread over the entire map by default~~ — Added spread decay + reduced FIRE_DURATION from 90→60
[x] ~~Once fire burns out on it's own quicker, we should increase the chance of fires~~ — Increased BASE_IGNITION from 0.0003→0.0004
[ ] add plant and tree regrowth after fires
[ ] Goblin deaths should sour the mood of surviving goblins for a while

## Audit Chapter Generation
[ ] Question: wHat actions/logs/traits/emotions get sent for chapter generation.
[ ] Use logging to headless tos ee what gets sent for chapter generation.
[ ] add chapter generation to headless mode.
[ ] What info should we send to make the most impactful story
[ ] Can it capture screenshots of key moments and add them to the chapters?


## Bugs:
[ ] bug: saw a goblin with -10 food in their hud display 
[ ] bug: goblins dont seem to forage much for mushrooms when they're hungry anymore. Almost starving to death sometimes than going to find a mushroom patch (especially if there's no kitchen to cook in yet)
[ ] bug: if a kitchen is built before other rooms (like storage room), then goblins heavily deprioritize cooking meals. Or never cook meals.
[ ] bug: build menu items highlight white after they've been selected and deselected the first time. They should remain gray when unselected.
[ ] bug: goblins sometimes build single walls away from the fort
[ ] bug: goblins get stuck not moving with "rembered patch" and "room wall". add headless logging for goblins sitting still for long stretches.
[ ] bug: if a kitchen is built before a storage room, goblins will delay placing a hearth in the kitchen and start cooking.
[ ] bug: saw two goblins just sitting far away from camp "looking for warmth" but not moving until they died of starvation



# Don't start without approval
[ ] Some oscillation bugs remain. Not a current priority.


