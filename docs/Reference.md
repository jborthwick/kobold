Here are all the sources organized by category:

**From Tynan Sylvester directly:**

- **Book: *Designing Games* by Tynan Sylvester (O'Reilly, 2013)** — https://tynansylvester.com/book/ — His game design philosophy covering how games generate experiences through systems, reward scheduling, elegance, and emotional mechanics. The theoretical foundation behind RimWorld.

- **GDC Talk: "RimWorld: Contrarian, Ridiculous, and Impossible Game Design Methods" (2017)** — https://www.youtube.com/watch?v=VdqhHKjepiE — Free on YouTube. Covers framing RimWorld as a story generator, strategic feature omission, shipping without "critical" features, and a methodology for selecting what actually matters.

- **GDC Talk Slides (PDF)** — https://media.gdcvault.com/gdc2017/Presentations/Sylvester_Tynan_RimWorld_Contrarian_Ridiculous.pdf — The presentation deck if you prefer skimming the key points.

- **AIAS Game Maker's Notebook Podcast** — https://open.spotify.com/episode/1T43NtHpjpY1BSwnapcACI — Discussion of core systems, "elastic failure," and his theory on why people play games.

- **Interview with Tynan (Cultured Vultures, 2018)** — https://culturedvultures.com/tynan-sylvester-rimworld/ — He names his key influences (McKee's *Story*, Kahneman's *Thinking Fast and Slow*, *Blue Ocean Strategy*) and discusses hitting an unexplored design space.

- **Tynan's personal site** — https://tynansylvester.com/ — Links to his blog, book, and background.

**Game design analysis articles:**

- **"Failure Cascades in Simulation Games" by James Muirhead** — https://muirhead.design/2024/04/27/the-art-of-the-spiral-failure-cascades-in-simulation-games/ — Excellent breakdown of how RimWorld handles death spirals vs. recovery, the expectations system as anti-cascade mechanic, wealth-based raid scaling, and the Man in Black as a one-time deus ex machina.

- **"RimWorld, Dwarf Fortress, and Procedurally Generated Storytelling" (Gamedeveloper.com)** — https://www.gamedeveloper.com/design/rimworld-dwarf-fortress-and-procedurally-generated-story-telling — The three pillars of emergent storytelling: set story framework, semi-control over characters, and event systems. Good comparative analysis.

- **"Is Maslow's Hierarchy of Needs Compatible with RimWorld?" (Gamedeveloper.com)** — https://www.gamedeveloper.com/design/is-maslow-s-hierarchy-of-needs-compatible-with-rimworld- — Analyzes RimWorld's needs and expectations system through the lens of Maslow's hierarchy and the hedonic treadmill.

- **"Algorithmic Authors: RimWorld's AI Storytellers as Agents of Literary Genre" (Medium)** — https://medium.com/@coyega1328/algorithmic-authors-rimworlds-ai-storytellers-as-agents-of-literary-genre-eff70ea4560c — Academic-style essay analyzing each storyteller as enforcing a specific literary genre through procedural rhetoric (Cassandra = classical tragedy, Phoebe = pastoral critique, Randy = existential absurdism).

- **"The Story Generator: A Game Design Analysis of RimWorld" (Substack)** — https://zaydqazi.substack.com/p/the-story-generator-a-game-design — Broad overview of storyteller system, colony management, biome design, combat, and player freedom. More surface-level but decent as a starting summary.

- **"How RimWorld Found Success Through Ridiculous, Contrarian Design" (Gamedeveloper.com writeup)** — https://www.gamedeveloper.com/design/video-how-i-rimworld-i-found-success-through-ridiculous-contrarian-design — Summary/context article around the GDC talk.

**Technical/systems wiki pages (the real number-crunching):**

- **Wealth Management Wiki** — https://rimworldwiki.com/wiki/Wealth_management — Detailed breakdown of how wealth converts to raid points, the formula, and whether micromanaging wealth is actually worth it at different difficulty levels.

- **Raid Points Wiki** — https://rimworldwiki.com/wiki/Raid_points — The full formula: wealth points + pawn points, difficulty multipliers, adaptation factor, combat power costs per raider type. This is the real technical reference.

- **Wealth Wiki** — https://rimworldwiki.com/wiki/Wealth — How building wealth counts at half, item wealth at full, the wealth-to-raid-points curve, and the expectations mood system tied to wealth.

- **Mood System Wiki** — https://rimworldwiki.com/wiki/Mood — Base mood values, mental break thresholds, how mood target vs. mood bar works, rate of mood change (+12/hr up, -8/hr down).

- **Needs System Wiki** — https://rimworldwiki.com/wiki/Needs — All the individual need bars (food, rest, recreation, beauty, comfort) and how they feed into mood.

- **AI Storytellers Wiki** — https://rimworldwiki.com/wiki/AI_Storytellers — Population curves, event scheduling differences between Cassandra/Phoebe/Randy, commitment mode, and the actual Storytellers.xml data.

**Architecture/modding (for studying how the systems are built):**

- **RimWorld XML Def Structure** — https://rimworldwiki.com/wiki/Modding_Tutorials/XML_file_structure — How RimWorld's entire content system works: data-driven XML definitions with C# handling behavior. Good architecture pattern to study.

- **RimWorld Modding Wiki: Basic Concepts** — https://rimworldmodding.wiki.gg/wiki/Basic_Concepts — Clear explanation of the Def/Thing separation (Defs are blueprints, Things are runtime instances), XML patching, and Harmony code patching.

- **Linking XML and C# Wiki** — https://rimworldwiki.com/wiki/Modding_Tutorials/Linking_XML_and_C — How worker classes, DefOf references, and DefModExtensions bridge data and behavior. Useful if Kobold needs a similar data-driven architecture.

- **RimWorld Auto-Documentation (GitHub)** — https://github.com/Epicguru/Rimworld-Auto-Documentation — Auto-generated docs of all vanilla defs with example values. Great for seeing how Tynan actually tuned the numbers.

- **RimWorld Modding Resources Hub** — https://spdskatr.github.io/RWModdingResources/ — Community-curated links for modding guides, xpath tutorials, art assets, and inheritance patterns.