# PROTOCELL — Game Design & Technical Specification
*(working title)*

A factory/automation game in the lineage of Factorio, but instead of building an industrial base from mineral resources, the player builds a **living organism from the inside out** — constructing cells, membranes, transporters, enzymes, metabolism, circulation, immune systems, and ultimately reproduction. The core insight the entire game rests on: **biology already is a factory-logistics system**, and often a more elegant one than anything a factory game invents. Metabolic stoichiometry, gradient-driven transport, feedback control, and self-replication are native mechanics, not metaphors.

This document is a complete build spec. It is organized so an implementer can work top-down: vision → principles → simulation core → cell model → transport → metabolism → protein synthesis → volume/osmosis → rendering → the playable intro → tuning constants → roadmap. Five working browser prototypes already exist (see the final section) that demonstrate the feel and validate the mechanics described here.

---

## 1. Vision & narrative framing

### 1.1 Premise
The player is a **nanobot from a mechanical planet**, dispatched to seed and cultivate life on an organic world. This is a deliberate inversion of Factorio's premise (a biological engineer crash-lands and industrializes a living world that resists its machines). Here a *machine* arrives to build *life*.

This inversion is load-bearing, not cosmetic. A machine-mind thinks in blueprints, fixed recipes, deterministic throughput, and tight optimization — and biology punishes exactly that mindset. Life survives through redundancy, feedback, slack, and adaptation, not brittle optimization. So the difficulty curve and the narrative arc are the same arc: the player must learn to stop thinking like a machine and start thinking like a body. Early builds should be rigid and fail; mastery is embracing biological principles.

### 1.2 The nanobot as avatar
- The nanobot is a general-purpose molecular assembler — which is *what a ribosome is*. At the start, the player literally **is the ribosome**: they hand-assemble proteins because the nanobot is the only assembler in the cell.
- The long arc is the nanobot **building biological machines to replace each of its own functions**: ribosomes replace its assembly, the endocrine system replaces its logic/control, a nervous system eventually replaces its decisions. The endgame is the machine engineering its own obsolescence — life that finally runs without it. That completion *is* the mission ("create life").
- **Machine-ontology HUD**: the interface initially labels biology in machine terms ("fuel-grade substrate" for glucose, "charge" for ATP, "hull" for membrane, "components" for proteins) and the vocabulary drifts toward correct biological terms as the nanobot learns. This teaches real terminology alongside the metaphor.
- Open narrative hook for *why* it was sent (pick one): machines cannot truly self-replicate or open-endedly evolve, so they built a seeder to create something that can.

### 1.3 Signature features
- **Fractal zoom** as the game's identity: the same simulation renders at molecular scale (organelles inside a cell), cellular scale (arranging cells into tissue), organ scale (plumbing organs into the blood bus), and organism scale (holding homeostasis against the outside world). Moving between scales is core.
- **Reproduction as endgame** (Factorio's is "launch the rocket"): once the organism is robust enough to divert resources into building a gamete, the player "wins," and it seeds the next run — a natural hook for cross-generation evolutionary meta-progression where hard-won adaptations carry forward as a tech tree.
- **Native stoichiometry**: glycolysis, the electron transport chain, etc. have real fixed ratios, so the "balance your assembler ratios" puzzle is just how metabolism works — free.

---

## 2. Core design principles (the spine)

These principles govern *every* system and are the most important part of this spec. Violating them breaks the game.

### 2.1 Numbers are truth; visuals are costume
The simulation is exact scalar state. Everything the player sees (particles, ooze, tints, gauges) is a **rendering of that state and must never contradict it.** If a compartment's stored amount reads 40, it must never *look* like 20. Particles are spawned *from* the field, never the reverse — the field is never inferred from particle counts. This keeps metabolism exact (the whole appeal was precise ratios) while still giving a visceral picture. Corollary: the "lie" of the costume must be a perfectly consistent function of the truth.

This principle is the one most easily lost to convenience — five of the nine prototypes inverted it without anyone noticing (§16.2). So it is not left to discipline: §3.7 puts the simulation in a **separate process** from every renderer, which makes the inversion impossible to write rather than merely forbidden.

### 2.2 Every visible property is bound to a simulation variable
- Particle **density** = concentration
- Particle **sprite + motion** = species identity
- **Ooze / motion presence** = aliveness (stillness = death)
- Membrane **wobble character** = tension
- Enclosed **area** = volume
- Region **tint** = a concentration field (one scalar at a time)

Nothing is decorative. This is what makes a game about invisible quantities (homeostasis, gradients) readable at a glance.

### 2.3 Death = equilibrium; life = paying to stay out of it
Passive diffusion constantly erodes every gradient toward uniformity, and uniform concentration everywhere *is* what a corpse is. Being alive is the ongoing act of spending ATP to hold gradients away from equilibrium. This reframes the power economy: mitochondria don't just power construction, they **pay rent on staying un-equilibrated, every tick, forever.** When the power grid browns out, pumps stop, gradients slump, and the organism dies the way real cells die. This is the always-on power sink and the fundamental fail state in one mechanic.

### 2.4 Two truths, one costume, at every scale
The pattern "exact state + rendered costume bound to it" recurs at three levels and must be kept clean at each:
- numbers (truth) → particles (costume)
- grid field (truth) → blobby cell (costume)
- sim clock (truth) → render framerate (costume via interpolation)

All three seams run across the process boundary of §3.7, which is what keeps them clean: the truth side of each pair lives in the sim server, the costume side in a client.

### 2.5 Boundaries are provisional
Every "sealed box" in a single-cell scene (e.g., the extracellular space) only looks sealed because what is on the other side hasn't been drawn yet. Circulation is the mechanic that dissolves local boundaries by connecting each pocket to a shared transport network. Waste leaving one cell's neighborhood is a resource arriving somewhere else.

---

## 3. Simulation architecture

### 3.1 Grid substrate (the truth layer)
The world is a **2D grid of cells (tiles)**. Each tile holds an array of scalar amounts, one float per chemical species (glucose, ATP, lactate, amino-acid types, ions, O₂, CO₂, etc.). Concentration in a tile = `amount / tile_volume` (tile volume is fixed per resolution). There are **no particles in the simulation** — particles are purely a render-layer artifact spawned from these fields.

Every transport rule we need is a **local stencil** reading a handful of adjacent tiles, which is exactly what a grid makes cheap (and a particle soup makes expensive). Biology's transport is already local and diffusive, so the grid is the natural substrate, not a compromise.

### 3.2 The four grid operations
```
Diffusion (per species, per tile):     new = c + rate * (sum_neighbors(c) - n * c)      // a blur
Advection (bulk flow):                 push c downstream to the next tile along flow
Fick flux across a membrane edge:       J = P[species] * (c_a - c_b)                     // P = edge permeability
Osmosis (water):                        water moves toward the neighbor with higher total solute (osmolarity)
```
All are cheap, local, GPU-friendly (a diffusion blur is one of the cheapest shader ops).

### 3.3 Numerical stability (do not skip)
Explicit diffusion **blows up** if a single step moves a tile more than partway to its neighbors' average — values overshoot, oscillate, and explode. Two mitigations, use both:
1. **Sub-step the sim** at a fixed timestep sized for stability (independent of render framerate).
2. **Clamp every transfer** so a tile can never overshoot equilibrium in one tick (never cross the equilibrium point). This same clamp appears in the Fick and transport code.

### 3.4 Sim/render decoupling
The sim solves on stability-sized sub-steps; the render interpolates between sim states at whatever framerate the visuals need (the ooze wants 60fps; the grid solves at its own rate). Bind them but do not lock them to one heartbeat.

### 3.5 Scale via grid resolution (fractal zoom)
The zoom level *is* the grid resolution / tile-count-per-cell. Zoomed into one cell: ~1000 tiles per cell, lush individual particles, real soft-body wobble. Zoomed out to the organism: each cell coarsens toward a single averaged tile, fields render as heatmap tint, soft-body drops to a gently breathing foam. Only the viewed region needs fine resolution and full framerate; the rest runs coarse and slow (downsample/tile/multithread/GPU). A flat scalar array trivially supports all of this.

### 3.6 The hard part: moving boundaries
A grid is *fixed space with variable content*; a cell is *variable space with its own boundary*. Cell growth, division, and vesicle shedding move a boundary through the fixed lattice, which means re-partitioning which edges are membrane and which are interior **mid-simulation**. This is the genuinely difficult seam. **Build a dividing cell early** to stress it; everything else on the grid is comparatively easy.

### 3.7 Process architecture: the simulation is a server

§2.1 and §2.4 state the two-truths-one-costume rule as a discipline. Discipline is not enough — the prototypes prove it, having inverted the rule in five files out of nine (§16.2). So the separation is **structural**: the simulation runs as a standalone Node process that holds all state, and renderers are separate client processes that connect to it over WebSocket. A renderer cannot corrupt the truth layer because it has no reference to it.

**Qualified by §15.6 once this was hosted.** Ticking costs 5.5% of a core per cell, so a public server keeps the promise for anyone who has played recently and freezes the rest — the version of it nobody is present to observe.

- **The sim owns the clock.** It advances in fixed `SIM_DT` steps (§3.3) and never sees a frame delta. It ticks whether or not any client is attached — which is, exactly, §2.3's thesis about what being alive costs.
- **Clients subscribe to views, and hold no truth.** A client declares a region, a resolution, and a set of species; the server downsamples server-side and sends only that. This makes §3.5's fractal zoom a *protocol* feature rather than a rendering special case: zooming out is a new subscription, not different render code. §11.4's layer overlays are the species list in the same subscription.
- **Commands are the only channel by which a client affects the sim.** Placing a transporter, blebbing, building an enzyme — all are discrete messages. Combined with a seeded PRNG this makes the whole simulation deterministic and replayable from a command log, for free.
- **Field data crosses as binary frames; scalars and events cross as JSON.** See §15.3 for the wire format.

The payoff beyond correctness: the tuning loop and the §17 parameter sweeps run headless with no browser and no renderer at all, and multiple views at different zoom levels can watch one organism simultaneously.

---

## 4. The cell model

### 4.1 Cell as tiles
A cell is a contiguous region of cytoplasm tiles wrapped by a **one-tile-thick membrane ring**.

**Size: ~1000 interior tiles** (roughly a 32×32 blob), wrapped by a **~120-tile membrane ring (~10%)**. Do NOT use ~100 total tiles — at that size the ring is ~36% of the cell (a fat rind, not a skin), the interior has no depth for gradients to form, and diffusion equilibrates almost instantly. At ~1000 tiles the membrane is a proper skin, the interior has a deep middle (a dropped solute has ~15 tiles to traverse, so gradients spread visibly over time), and division re-tiling is easier (each daughter is a comfortable ~500-tile blob).

**Interaction scale split**: the ~120 membrane slots are hand-scale and clickable (transporters are placed on individual tiles). The ~1000-tile interior is a **field managed in aggregate** (read as density/tint, acted on through the membrane and a few interior structures) — the player never clicks individual cytoplasm tiles.

### 4.2 The membrane tile is a GATE, not a tank
A membrane tile has a location, holds an embedded protein, and carries local state (which transporter, its tension, its lipid composition). **But it holds no solute pool.** If it were an ordinary diffusion tile it would (a) buffer solute with a lag and (b) leak freely to both neighbors, dissolving the very gradients that are the whole game.

Instead: the membrane tile **mediates flux between its inner (cytoplasm) neighbor and its outer neighbor**, gated by a permeability that is near-zero by default (a sealed wall) and rises for one species when that species' transporter is embedded. **The tile is the wall; its outward-facing edge is the valve.**

Each membrane tile needs a **normal** pointing toward its cytoplasm neighbor (so a pump knows which way is "out"). The local rule is cheap; the only fiddly case is corner tiles with cytoplasm on two sides — exactly the geometry stressed during growth and division. Prototype that case in isolation.

#### 4.2a Not every membrane tile is a gate

§4.2's annulus is one tile thick *radially*, which rasterises to a wall **two tiles thick along the diagonals** — and the inner tile there touches cytoplasm on both sides, so it is buried wall, not a gate.

On the §4.1 cell that is **20 of 108 ring tiles: 18.5% cannot host anything.**

A gate tile is one with fluid on **both** sides — `gateTiles()` is the authority, and the client is sent that list rather than inferring it. Seating anything elsewhere is refused with a reason. Before this, a flagellum was correctly rejected there while a transporter was *accepted and silently transported nothing*, which is the worse failure: about one deployment click in five landed on dead wall.

> A boundary defined by geometry and a boundary defined by *what it touches* are not the same set, and the difference is where things silently stop working.

### 4.3 Compartments nest
The compartment model is recursive: extracellular space *contains* the cell, cytoplasm *contains* the nucleus (nuclear envelope), organelles have their own walls. Every boundary is a membrane with its own permeability vector; every enclosed volume carries its own concentrations. This same structure scales up to organs tapping the bloodstream — compartments inside compartments, membranes all the way down.

### 4.4 The membrane is ONE universal primitive
Every surface in the game is the same object type — a membrane with a per-species permeability vector plus embedded transporters — differently tuned:
- **blood–tissue interface**: general exchange
- **gut lining**: actively pumps nutrients inward from a food reservoir
- **kidney tubule**: tuned to reabsorb glucose/Na⁺, let urea pass
- **lung alveolus**: huge O₂/CO₂ permeability, large area, exposed to an air reservoir
- **organelle walls, nuclear envelope**: internal compartmentalization

This economy is a key architectural win: one parameterized component generates all interesting surfaces.

### 4.5 Growth, division, blebbing (tile operations)
- **Growth**: convert outer cytoplasm tiles to interior, crawl the membrane ring outward one tile at a time; **each new membrane tile costs phospholipids** (membrane is a build material — see §8.4).
- **Division**: a cleavage line of interior tiles converts into two back-to-back membrane rings with **opposing normals**, splitting one ~1000-tile cell into two ~500-tile daughters. This conversion (interior→wall, one normal→two) is the re-tiling event and the hardest seam.
- **Blebbing / vesiculation**: under critical membrane tension a cell can pinch off a vesicle, shedding volume and solute to survive instead of rupturing (see §10.4).

### 4.6 Surface-area-to-volume forces the next scale
Volume grows as radius³ while membrane area grows as radius², so a bigger cell has proportionally less surface per unit interior. Import capacity per unit of internal demand keeps dropping as the cell grows, until the core literally cannot be fed across its shrinking relative surface. **This SA:V squeeze is the emergent forcing function that pushes a cell to divide, and later pushes a ball of cells to invent circulation to feed its interior.** It should be a visible, spatial fact (a growing cluster of interior tiles no membrane can reach), not a scripted rule. See §17 for the full multicellular-transition chain built on this.

### 4.7 Cytoskeleton & motor transport — the intracellular belts (spatial gameplay)
**This is the answer to "where is the spatial/routing gameplay."** Without it the cytoplasm is a well-mixed diffusion soup and the interior is barely spatial. With it, the inside of a cell becomes a Factorio-style layout problem. Prototyped in `cytoskeleton_belts.html`.

The clean biological mapping — and note the ER is NOT the belt:
- **Cytoskeleton (microtubules, actin filaments) = roads/belts.** Physical tracks the player lays down from A to B; cost material to build.
- **Motor proteins (kinesin, dynein, myosin) = the vehicles/engines.** They walk along a filament carrying cargo directionally, **spending ATP per step** (hydrolysis per step; loaded costs more than empty).
- **Vesicles = trucks** (the containers cargo rides in).
- **ER + Golgi = the factory/packaging district** (a later assembler tier — §8.5 — that *produces* vesicles which then ride the cytoskeletal roads). The ER is manufacturing + folding + lipid synthesis, not a track.

**Why this is the missing layer, mechanically:** diffusion is free but slow, undirected, and gets exponentially worse with distance — a poor belt. Motor transport is fast and directed but costs ATP and requires the track to have been built. So the standing decision at every scale becomes: *is this route hot enough to deserve a powered highway, or is diffusion good enough?* — exactly the Factorio belt-vs-nothing decision, now with a gradient consequence.

**Emergent spatial texture (the payoff):**
- A highway feeding substrate straight to an enzyme keeps that enzyme's **local** concentration high (throughput up) while the bulk cytoplasm stays lean → **hotspots at consumers, cold zones elsewhere** — texture diffusion alone never produces.
- The highway **skips the bulk**: cargo rides the track, not the medium, so the interior between endpoints stays empty even as material streams across it. *Where you run the track* is a real routing decision, and interior real estate joins membrane real estate as a constrained resource.
- Scaling throughput = **adding more motors** to a track (like adding belts/inserters), with diminishing returns once the consumer's single-active-site ceiling is saturated (don't over-build the belt).

**Organelle placement is the other half of intracellular spatial play.** If mitochondria make ATP and pumps/motors consume it, a consumer far from a producer is starved unless you move the organelle closer or run a highway to it (real cells cluster mitochondria at high-ATP-demand sites). So the player arranges **factories (organelles) + belts (filaments)** in a bounded, growing space — the full missing Factorio layer, all native biology.

**What belts do and don't solve (important — see §17):** belts fix *transit* (moving cargo across the cell interior faster than diffusion), which removes the dead-core failure in the mid-size range. They do **not** raise *boundary flux* — the total that can cross the membrane per second, capped by surface area — so they buy a larger size window but do not defeat the SA:V ceiling, and at large size perfect mixing can even make starvation worse (17.4). Belts are tier 2 of the escalation ladder in §17.5, and are what makes long/thin giant-cell geometry viable.

**Implementation sketch (from the prototype):** a filament is a track (endpoints, cost). Motors are entities parameterized by position `t ∈ [0,1]` along the track, a direction, and a `carry` slot. A motor grabs a free solute particle near the "load" end, walks it to the "unload" end, releases it (as free solute near the consumer), and returns empty; ATP is charged per distance moved, higher when loaded. Free solutes still diffuse; ridden ones are positioned by their motor. Consumers (enzymes) pull from free local concentration, so delivery raises local concentration at the drop point. Prototype constants: motor speed ~200 px/s, ATP cost ~0.28/s loaded and ~0.09/s empty, per-glucose enzyme yield +2 ATP, baseline upkeep 1.5 ATP/s — tuned so a far enzyme *starves on diffusion* (ATP falls) but *thrives on the highway* (ATP climbs), making transport infrastructure a survival decision.

---

## 5. Species & resources

Managed species (each gets a distinct visual signature — see §12). Budget ~6–8 glanceable signatures max; everything else is a number-on-hover or a tint when relevant.

| Species | Role | Notes |
|---|---|---|
| Glucose | Fuel input | Imported down-gradient; cracked by glycolysis |
| Amino acids (typed, ~20) | Protein building blocks | Specific types; essential vs non-essential |
| ATP | Energy currency ("electricity") | Produced by metabolism; drained by upkeep & pumps |
| Lactate | Anaerobic waste (= lactic acid) | Solute → osmotic load; exported down-gradient |
| O₂ / CO₂ | Aerobic respiration gases | Cross freely (high P); CO₂ = acid (pH, later) |
| Na⁺ / K⁺ | Ions | Pumped; set membrane potential; K⁺ loss = heart-stop analog |
| Water | Solvent | Moves by osmosis; changes volume |
| Baseline osmolytes | Fixed intracellular proteins/ions | Constant; dominates osmolarity so metabolites don't swing it wildly |

**Amino acids are typed, not generic.** A protein is a specific *sequence* drawn from ~20 types, so recipes are bills of materials of specific types. Rare types gate rare proteins (essential amino acids must be imported; non-essential ones can be synthesized once the pathway is unlocked — a real tech tree that reduces import dependency).

---

## 5a. Discrete matter: what the player handles is countable

A field is correct physics and was illegible: on a mid-game cell glycine ran **0.0389 mean against 0.0392 max** — perfectly flat — while the renderer spent 436 dots depicting it. A field cannot be counted, pointed at, or picked up.

So the species the player handles are **particles**: real simulation entities with a persistent `id`, a position and a quantity. The renderer draws them because they are what there is.

> §2.1's *"numbers are truth, visuals are costume"* protects against the renderer lying about the simulation. It says nothing about whether the simulation is modelling at a grain the player can act on. **A perfectly truthful field nobody can point at is still the wrong representation.**

### 5a.1 The split, and why it is not arbitrary

| representation | species | why |
|---|---|---|
| **particles** | glucose, lactate | matter whose position gates something — an enzyme reaches for it, a carrier exports from where it sits |
| **inventory** | the five residues | a stock, not a place; see §5b |
| **field** | ATP, water, O₂, CO₂ | ATP is a *charge on the cytoplasm* (§5c); the gases and water are nobody's inventory |

Particles live **inside the cell only.** The extracellular medium stays a continuum because §2.5 models it as a boundary condition rather than as state (`bathRate = Infinity`, a well-stirred bath). Import mints one at the membrane; export consumes one and returns it to the bath.

There is **no interior field for a discrete species**, not even a derived projection — a parallel copy is a second copy of the truth, and two copies drift. `World.interiorAmount()` is the single accessor, because reading the grid for a discrete species returns a silent zero that looks exactly like an empty cell.

Count scales with the amount of matter, which scales with volume, so the intro cell is countable and a large one recovers a genuine gradient. **Legible when small, continuous when big, with no switch to throw.**

### 5a.3 Diffusion by random walk is not an approximation

The diffusion equation is the continuum *limit* of a random walk, so moving particles by random steps is the microscopically truthful version of what `ops/diffuse.ts` does to a field. For a 2D walk with per-axis steps of standard deviation σ over dt:

```
⟨r²⟩ = 2σ²   and   ⟨r²⟩ = 4·D·dt   ⇒   σ = sqrt(2·D·dt)
```

drawn from the **same `DIFFUSION` table** the field uses, so both reproduce the same `D` and §13/§17 stay comparable across the change. Asserted directly: 4,000 walkers reproduce `⟨r²⟩ = 4Dt` to within 15%.

Particles **reflect** off the boundary rather than clamping to it. Clamping piles matter onto the wall exactly where transport reads its gradient — the discrete cousin of the absorbing-sink bug §17.2 cost a rebuild.

### 5a.8 A thing you must catch cannot outrun you

> **Anything the player must walk to and collect cannot move faster than the player.**

`BOT_SPEED` is 9 tiles/s. At the residues' tabulated `D = 8` a bead netted 5.7 tiles/s of drift on a jitter path of ~44 tiles/s — uncatchable, and chasing it looked frantic rather than alive.

Which species are slowed is decided by **who handles them.** Glucose and lactate are handled by machinery and keep their `D` untouched, because glucose crossing the interior to reach an enzyme *is* §17's penetration depth and slowing it would blunt the SA:V wall.

The rule outlived its own use case — §5b removed the mechanic that needed it — and is kept because the next collectible thing will need it.

**Shape, not colour, tells them apart.** One family shape with five hues put the whole discriminating burden back on colour, the exact failure it was introduced to fix. Each residue has its own mark, saying something true where possible: **gly** a circle (side chain is a single hydrogen), **ala** a square, **val** a diamond (β-branched), **leu** a pentagon (bulkiest aliphatic here), **lys** a **plus** — positively charged at physiological pH, so the mark *is* the chemistry. Lysine is the one you never confuse, which matters because §12.3's squeeze is a lysine squeeze.

### 5a.9 Discrete when position carries information; continuous when it does not

Residues were made objects, then made catchable, and still failed — playtested as *"finding an amino acid is an impossible task, or sometimes a magical one where they are just around and you don't know why."*

**The second half is the damning one.** "Impossible" is a difficulty problem and could be tuned. "Sometimes magical, for reasons you cannot see" is not a mechanic at all, and no value of any constant fixes it.

> **A legibility problem will not yield to a tuning fix if the representation itself is wrong.** Two rounds of tuning went in before the answer turned out to be that residues should not have been objects.

> **Discrete when position carries information. Continuous when it does not.**

For a residue the only thing true about it is *how many the cell has*, so it is a stock (§5b) and §9.2's blocking case becomes **"you are out of lysine, import more"** — a supply decision rather than a scavenger hunt in a shaken box. This is defensible as physics too: at `D = 8` across an 18-tile cell the interior equilibrates in ~10 s against an arc measured in minutes, so the cytoplasm really is well mixed on the timescale that matters.

**§4.7's texture claim moved rather than died.** Gathering leaves no hole in a residue pool, but it still leaves one in **ATP**, drawn from `DRAW_RADIUS_ATP`, because a local energy brownout is a genuinely spatial event (§2.3).

### 5a.10 The amino transporter carries the residue you chose

`GENES.aminoTransporter.product.species` was hard-coded, so every amino transporter any player ever built was a **glycine** channel. §5 says "rare types gate rare proteins" and §12.3 deliberately squeezes lysine — so the game created the exact situation the rule exists to create and then withheld the only response to it.

A gene may be marked `selectableResidue`; the choice is made **at the nucleus**, riding with the blueprint, so which residue it carries is part of what you built rather than decided at the wall. With §6.7's finite real estate, importing all five types genuinely costs five gate tiles.

### 5a.11 A typed bill of materials needs a typed map

All five residue deposits were originally at the same coordinate — one undifferentiated blob — so *there was no such place as "where the glycine is"*. "Go and get gly" was not difficult, it was impossible.

> §5 gave the game a **typed bill of materials** and left it an **untyped map**. Whenever a mechanic types a resource, check the *world* is typed to match — otherwise the specificity exists only in the cost, never in the answer.

Each residue now has its own location, distance and direction, ordered so scarcity and distance agree: gly and ala are common and close, val and lys scarce and far. Each deposit is drawn with that residue's shape (§11.3e), its name and what is left, with an edge compass for off-screen ones that brightens for whatever the current build is blocked on.

**This settles §10A.6**, which had failed to find a reason to move by looking at the energy economy — ATP sits at its ceiling regardless:

> **The reason to travel is not energy, it is materials.** Glucose is everywhere; lysine is somewhere. Exploration is motivated by a resource you cannot substitute, not one you merely want more of.

## 5b. Building material is an INVENTORY, not chemistry

Amino acids were modelled four ways — concentration field, collectable grains, field again, field retuned — and each fix addressed the previous symptom while none touched the cause.

**The diagnostic that ended it.** Answering *"can the player see their glycine?"* required computing that 6 units over 896 tiles is a concentration of 0.0067, which at a dot-scale of 0.25 with a per-tile dither yields 23 dots — and then checking whether that survived a change of zoom. It did not.

> **If "how many do I have" requires arithmetic, the model is wrong.**

Concentration is the right primitive for a quantity whose *gradient does work* — glucose crossing a cell, lactate backing up behind a carrier, everything §17's SA:V wall is made of. It is the wrong primitive for a bill of materials.

### 5b.1 The model

**A residue is an integer you own.** No volume, no diffusion, no position, no per-species scale constant, and nothing that changes when the camera moves. `lys: 14` means you can place fourteen more lysines — `RESIDUES_PER_BOND` is 1, so the number on screen *is* the number of bonds remaining. It lives in a HUD strip, not in the world, so it cannot become illegible.

Blueprints show have-against-need per type and turn red on the one blocking you. The bill was always typed; nothing on screen had ever said which type you were short of until assembly stalled.

### 5b.2 Transporters became inserters

With no field there is no flux, so a residue transporter is not a channel. **In range of its deposit it pulls whole residues at a rate, and the deposit counts down.** No gradient, no equilibrium, no concentration. Rate scales with how strongly the deposit reaches the cell and with what is left in it, so §6.7's placement decision and §10A.2's reason-to-move both survive without any chemistry, and diminishing returns fall out of depletion rather than being scripted.

### 5b.3 A destination you cannot see is a rumour

Deposits were originally placed by scarcity alone, 60–132 tiles out. **The visible window is ±48 tiles**, so every one of them was permanently off-screen, and naming them, sizing them and giving them a compass were all decoration on something that could never be looked at.

They are placed from the viewport outwards: gly, ala and leu visible at the default zoom so the mechanic teaches itself, val and lys beyond the edge, which is what the compass and the flagellum are for.

> **Place things relative to what is on screen, then check.** A layout argued from the fiction alone will happily put the whole mechanic outside the frame.

### 5b.4 What this keeps and what it costs

**Kept:** typed bills of materials (§5), the blocking case (§9.2), finite membrane real estate with one type per transporter (§6.7), deposits that deplete (§10A.2), and materials as the reason to travel (§10A.6, §5a.11).

**Lost, and recorded rather than hidden:** residues no longer contribute to osmotic pressure. §7.2 makes volume a function of total solute, and building material dissolved in cytoplasm genuinely pushes water. It was a small term beside lactate and §12's crisis is a lactate crisis, so the trade is worth making — but it is a trade, not a free win.

> Model a quantity as a **field** when its gradient is the mechanic, and as an **item** when its count is the mechanic. Getting this backwards cannot be fixed by tuning the renderer, and every attempt to do so will look like progress.

### 5b.5 Imports arrive as PARTICLES, and pile up

§5b made residues a count, which fixed legibility and broke something else: *"the gly acids just seem to go directly into my inventory… there are no particles to pick up."* A number that increments on its own is not a loop. The transporter you placed had no visible output, nothing happened anywhere, and the supply line had no physical existence at all.

So an import mints a **residue particle at the transporter's own tile** and leaves it there. The count only rises when the nanobot walks over and collects it.

**Why particles work now when §5a's beads did not.** This looks like a straight reversal of §5a.9 and it is not. The first bead model failed for a reason that had nothing to do with the beads:

> **They had no source.** Scattered uniformly through the cytoplasm, five species at once, "go and get gly" meant searching a shaken box.

That is why §5a.8's fix — slowing them from 5.7 tiles/s to 0.45 — changed nothing that mattered. Speed was never the problem. A residue now *comes from somewhere*: the transporter you chose, built, and placed on a tile you picked. **A thing with a known source and a fixed location is findable by construction**, and no amount of tuning would have made the sourceless version findable.

The general form, which is the useful part:

> Findability is a property of **provenance**, not of appearance. Before making a collectible easier to see, ask where it comes from — if the answer is "everywhere", no visual treatment will fix it.

**The hopper is finite, and that is the mechanic.** Each port holds `HOPPER_CAPACITY = 8` residues and then **stalls**. An importer you never visit stops working, and the backlog is visible at the wall — so "your glycine importer is producing" is something you can see from across the cell rather than a number ticking in a panel. Measured, bot parked at the centre:

```
 20 s   inventory 24   waiting at the port 5
 45 s   inventory 24   waiting at the port 8   <- backed up, port stalled
180 s   inventory 24   waiting at the port 8   <- still stalled
walk there:  inventory 32,  waiting 0
```

**Two implementation details that were each a bug first.**

*Held in place, not merely slow.* At a drift multiplier of 0.02 residues still wandered ~9 tiles in two minutes — enough to escape the hopper's own count (it overfilled, 11 against a cap of 8) and the nanobot's pickup reach (a collection trip left stragglers). **A hopper whose contents drift out of it is not a hopper.** Residue grains have zero drift and `GrainStore.step` skips them entirely.

*Packed, not stacked.* Every residue was minted at the identical coordinate, so eight particles drew exactly on top of each other and a full hopper was indistinguishable from a single bead — destroying the one thing a backlog has to communicate, which is its size. They now sit in a fixed golden-angle packing about a tile apart. Deterministic rather than repulsive or jittered: §3.7 needs replay, it costs nothing per tick, and it *guarantees* separation instead of tending toward it.

Collection is automatic within `PICKUP_REACH` rather than click-per-item. The trip is the mechanic; forty individual clicks would be an interface.

### 5b.6 One idiom for everything that comes in: the PORT

Playtest: *"we should use the same particle dynamics for glucose… it is much easier to understand."*

Glucose used to cross the membrane by concentration flux — §6.2's Fick law between an outside tile and an inside one. That is correct physics and it made the thing the player had *built* into an arithmetic relationship between two numbers, neither of which was on screen. Residues had already become ports (§5b.2); running two mechanisms for "import" meant two explanations, and only one of them was visible.

**A transporter in range of its deposit mints particles at its own tile.** That is now the only way anything enters the cell. Same code path for glucose and residues, differing only in what happens next — glucose drifts off to be eaten, residues wait in the hopper for collection. (It used to differ in what a parcel was *worth*, too; §5d removed that.)

**This makes §17 more legible rather than less.** Glucose particles still random-walk once inside, at their tabulated `D`, so **how far a glucose gets from the wall before an enzyme eats it IS the penetration depth** the SA:V wall is built from. Same physics, now something you watch an individual grain do instead of a gradient you infer. *(The §17 sweep has not yet been re-run against this — see §16.1b.)*

Two bugs fell out of the conversion and both were invisible from the inside:

- **Only one deposit per species ever worked.** The import loop used `.find()`, which returns the FIRST patch of that species. Glucose has three; a player who swam to the richer one 95 tiles out and parked on it got nothing, because range was still being measured to a patch on the far side of the map. Selection is now by best *reach* — distance against each deposit's own harvest radius. The navigation fallback had the identical bug.
- **Depletion counted parcels, not quantity.** A glucose grain is four units, so deposits lasted four times as long as their `reserve` claimed.

### 5b.8 …and one for everything that leaves: the EXTRACTOR

The mirror image. A lactate carrier consumes waste grains within `EXPORT_REACH` and sends them out; it does not read a gradient.

**§6.4's saturation survives intact**, which is the property worth keeping: a carrier binds its cargo, so it has a hard `Vmax` and cannot be driven faster by piling more lactate against it. That is still why §12.3 needs two of them — and it is now visible as a queue the carrier cannot keep up with rather than as a number that stops climbing.

Two calibrations, both discovered by measuring:

- **Reach 4 → 7.** Waste is made at the enzymes and has to reach the wall before anything can take it, so a short reach made export *transport*-limited rather than Vmax-limited: two carriers cleared 138 grains down to only 61 in three minutes. That is exactly §6.8's boundary-layer finding, but at intro scale it reads as a carrier that does not work rather than as a lesson. At 7 the arc lands: 138 → 7, tension 0.59 → 0.00.
- **The rate display needed a leaky integrator, not an average.** Export is bursty by construction — the budget accrues for ~34 steps and then a whole 4-unit grain leaves at once, which is 480 units/s for one tick and zero for the rest. Smoothing that reads back as a number swinging between 0.04 and 9.12, which looks like a malfunction. Summing what actually left over a two-second window and dividing gives the number a player means by "how fast is it going".

**The membrane now runs three idioms, and each needs its own words.** Calling a port "at equilibrium" is not a wording slip, it is the wrong concept — a port is in range or it is not, and an extractor is keeping up or it is not. Neither has an equilibrium. The client says `drawing 0.87 glucose/s from the deposit — 87% remaining`, or `OUT OF RANGE — 41 tiles beyond reach, swim closer`, or `exporting 3.2 lactate/s`.

### 5c ATP is a LEVEL, not a shape

ATP was a per-tile concentration. That bought §2.3's local brownouts and §4.7's "building somewhere flat stalls you" — both real ideas — and cost the same legibility every other field cost: *how much energy do I have here* had a different answer everywhere, none of which the HUD could show.

It is one number now: **the charge on the cell**. Not matter you can point at — the adenine pool's state, and a pool has a level.

**Most of the machinery around it was correction.** Deleting the field deleted: a per-tile dissipation cap that saw an enzyme's 2-ATP deposit as a spike and destroyed ~87% of glycolysis' yield before diffusion could spread it; the proportional whole-compartment rescale written to work around that; and an upkeep loop walking every tile to bill a rent that is identical everywhere. A single ceiling on a single number has no spike to mistake.

Capacity moved 448 → 502, because the pool is now sized against interior **plus** membrane — matching §13.2's rent, which always billed both.

**What this gives up, stated rather than hidden:** local brownouts, and with them §4.7's energy texture. Position still matters for everything made of MATTER — an enzyme must be where glucose reaches it, a carrier where waste reaches it, a transporter facing its deposit — so §4.7's principle keeps a body. It just no longer applies to energy.

### 5d ONE UNIT: the particle

Playtested verdict, and it is the whole section: *"what the hell is particles vs. molecules vs. grains vs. residues — this is WAY too complicated. Simplify to one unit."*

The HUD was quoting **grains**, **particles**, **molecules**, **units** and **residues** for what were mostly the same thing, because `GRAIN_UNIT` converted between the parcel drawn on screen and its contents — four molecules to a glucose grain, four to a lactate, one to a residue. The conversion bought smaller particle counts and cost the entire vocabulary.

**A particle is now the unit**: the thing drawn, the thing counted on a deposit, the thing an enzyme eats, the thing a peptide bond spends. `ATP_PER_GLUCOSE` reads 8 rather than 2 because one particle is what used to be four molecules, and it always yielded 8.

Nothing on screen moved. Every rate was divided by exactly what the parcel used to hold, and deposit reserves were rescaled to match, so counts and behaviour are identical.

#### 5d.1 Two units for one substance is a class of bug, not a wording problem

Five separate defects were the same mismatch, each hiding behind a plausible number: a flux label that understated glucose fourfold; depletion counting parcels against a reserve measured in molecules; an import throttle comparing parcels to a molecule capacity; `ENZYME_BIND_TIME` left per-molecule while its call site went per-particle, running the enzyme **4× too fast** (28.6 ATP/s against 7.14); and `S_NOM = A_REST`, which looked like a law and was a unit coincidence, quartering the osmotic load so **§12.3's swelling crisis stopped arriving**.

Both survivors were caught by tests comparing a measured rate against its own derived constant — never by inspection, because both sides of a wrong comparison are individually reasonable numbers.

> **A constant defined as equal to another constant is not thereby safe from a change of units.** `S_NOM = A_REST` survived precisely because it had no digits in it to look wrong.

## 6. Transport (the three tiers)

All transport is either **advection** (bulk flow carrying dissolved solutes — the "belt") or **membrane exchange** (diffusion/osmosis/pumps across a boundary — the "inserter"). Membrane exchange has three building tiers. These are a **building-tier decision, not a strict upgrade** — the right choice depends on what else you have built.

### 6.1 Foundational physics (applies to all passive transport)
- Passive transport moves **zero net cargo at equilibrium** (thermodynamics): when inside = outside concentration, both-way rates match. Net flux ∝ gradient, and **reverses** past equilibrium. This is mandatory for anything free.
- Consequence that confuses players: a passive transporter looks "slow" near equilibrium and "fast" with a steep gradient — because net flux literally depends on the gradient, not because its intrinsic speed changed.
- **A transporter that moves cargo at a constant rate regardless of concentration — even uphill — is not passive. That is a pump, and the constant rate is exactly what ATP buys.**

### 6.2 Passive diffusion
Small nonpolar molecules (O₂, CO₂) cross the bare lipid bilayer freely: high P, down-gradient, free. Ions and glucose have near-zero bilayer P — they need a channel or carrier.
```
J = P * A * (c_out - c_in)      // Fick; P is the master tunable, the whole tech tree lives in P
```

### 6.3 Channel (open pore)
- An open, size/charge-selective pore. When open, throughput is **very high, uncapped, ∝ gradient** (no saturation). Cheap to build. Can be **gated** open/closed.
- Downsides, all mechanically real: **bidirectional and symmetric** (refluxes *hard and fast* the instant the gradient reverses — it slams to equilibrium and twitches around it), and **less selective** (an open hole leaks other small molecules — model a small collateral leak, e.g., ATP bleeding out, as the selectivity cost).
- **Correct tool ONLY when the gradient is guaranteed to stay steep** — i.e., when circulation downstream keeps the far side clear. Otherwise its speed just means it equilibrates and leaks faster.
```
J_channel = P_big * (c_in - c_out)     // signed, uncapped, symmetric
```

**Gating is the cell's only self-regulation, and it is not optional.** §6.3 lists "can be gated open/closed" as a feature of channels; in play it turns out to be the single lever the player has. Build more channels than consumers and solute accumulates, volume climbs, tension rises, and without a way to *shut a pore* there is nothing to do but watch — the bleb (§10.4) sheds a one-off chunk but does not stop the inflow that caused it. A gate is a conformational change: free, instant, reversible, and it costs only the decision. In the client, clicking a seated transporter toggles it.

The deeper point this exposes: **every import is a commitment**. §6.7 already frames placement as a real decision, but the decision has a second half — an unregulated channel is a liability once its cargo stops being consumed, which is why real cells regulate transporter activity as heavily as they regulate transporter count.

### 6.4 Carrier (facilitated transporter)
- Binds cargo, undergoes a conformational flip, releases, resets — a shuttle. **Slow and saturable** (a hard Vmax ceiling; one active site → limited turnover). Selective.
- **Superpower a channel physically cannot match: coupling.** Because it binds its cargo, a carrier can move two things per cycle (symport/antiport) and thereby use one gradient to drag another thing *uphill for free* (secondary active transport). Example: couple to the Na⁺ gradient to import glucose against its gradient without spending ATP. The real lactate carrier (MCT) co-exports a proton (H⁺) with each lactate — clearing waste and acid in one cycle (pH tie-in, deferred).
- Its fixed quantity is its **ceiling (Vmax), not its throughput**; below the ceiling, delivered flux still scales with gradient and dies at equilibrium. Model the saturating curve as Michaelis–Menten (a piecewise-linear cap is an acceptable stand-in).
```
J_carrier = clamp( Vmax_forward, k * (c_in - c_out) )   if favorable, gentle reverse otherwise
```

### 6.5 Pump (active transport)
- Moves cargo at a **fixed rate across any gradient, including uphill**, and **costs ATP per cycle** (throttles when ATP is low). This is what maintains gradients against diffusion's erosion — the thing being alive *is* (§2.3). Na⁺/K⁺ pump is canonical.
```
J_pump = fixed_rate    (direction set by pump design; consumes ATP per unit; gated by ATP availability)
```

### 6.6 Thermodynamic distinction (teach this)
An **enzyme** speeds up a reaction that already wants to happen (downhill) and spends no ATP — a catalyst. A **pump** forces an unfavorable move (uphill) and burns ATP — a motor. Same build pipeline, opposite thermodynamic roles. A player who feels this understands the whole energy economy.

### 6.7 Placement matters (spatial logistics)
Transporters are directional and face-specific: a glucose channel does nothing on the face pointing at the amino-acid zone. **Where on the membrane perimeter each transporter sits is a real decision**, and membrane surface is finite real estate. This is the earliest form of the "position on the bus matters" puzzle, running at single-cell scale, and it foreshadows circulation layout. Optionally: local depletion around an over-used import site (dots thin, gradient flattens, import slows) nudges the player to spread transporters out — the same diffusion-limitation that later motivates circulation.

### 6.8 Advection / the main bus (circulation)
Blood is the **main bus, but it is a shared concentration reservoir, not a router.** Nothing is addressed; organs read and write the concentration of the blood they touch. It is also **bidirectional** — delivering O₂/glucose/amino acids outbound and hauling CO₂/urea/lactate back.

Model as a **ring of well-mixed compartments** (8–32 is plenty; standard compartmental model). The heart is a pump moving volume `Q` from compartment `i` to `i+1` each tick, carrying solutes proportionally:
```
moved[s] = Q * c_i[s]        where c_i[s] = amount_i[s] / volume_i
```
Emergent, for free: a bolus absorbed at the gut travels the ring and is depleted as tissues extract it, so an organ far downstream drinks poorer blood than one near the gut. **Where you plumb an organ onto the loop is a real layout puzzle** — the Factorio "upstream machines steal your iron" mechanic, emerging from physics rather than a coded rule.

---

## 7. Volume & osmosis (the coupled dynamic)

This is the mechanic that ties metabolism, membranes, and death together. **It is fully implemented in the `full_cell` prototype and the exact model below is what that prototype runs.**

### 7.1 Core coupling
**Volume is the denominator of concentration.** Every internal concentration is `amount / volume`, so growing the cell dilutes everything already inside it (slowing every concentration-dependent reaction), and shrinking concentrates and speeds them. You cannot independently maximize "lots of space" and "high concentrations" — one equation binds them. The player is always trading floor space against reaction speed.

### 7.2 Osmosis drives volume
Water moves toward higher **total** solute concentration (osmolarity), independent of which solute. So accumulating any solute (notably trapped waste) raises internal osmolarity, water floods in, and the compartment's volume rises — which then dilutes *every* concentration at once. There is negative feedback (more volume → lower osmolarity → less inflow), so it self-regulates toward matched osmolarity — but matching requires volume to grow in proportion to accumulated solute, so **unremoved solute = relentless swelling.**

### 7.3 Membrane resists (nearly inextensible)
Real lipid bilayers barely stretch (~2–3% area before rupture) and their thickness (~4 nm) is essentially fixed. Cells enlarge by **manufacturing more membrane**, not stretching. So the membrane resists volume increase and builds **tension** (the master variable = area-vs-volume-demand): slack when there's more membrane than volume needs, taut as volume fills it, rupturing past threshold.

> **The prose above and the model in §7.4 disagree, and the model is what runs.** "Resists volume increase" reads like an elastic restoring force balancing osmotic pressure at some volume *below* `A_osm`. `STIFF` does not do that — it divides the *rate of approach*, so the fixed point is still exactly `A_osm` and stiffness only sets how fast the cell gets there. A cell with `STIFF = 1000` swells to the same final volume as one with `STIFF = 1`, just slower.
>
> That is a defensible game model (the lag is what gives the player time to react, and lysis still fires on the way up) and it is pinned by a test so it will not be "fixed" by accident. But it means membrane reinforcement (§8.4) cannot work by raising stiffness alone — stiffening buys *time*, not a higher safe volume. If reinforcement should raise the ceiling, it has to raise `RUPTURE`, which §8.4 already says it does. Worth revisiting if tension is ever meant to hold an equilibrium rather than merely slow one.

### 7.4 The exact model (from the prototype)
Working in 2D area `A` as the volume proxy:
```
A_REST   = π * R0²                       // R0 = rest radius (150 px in prototype)
B_OSM    = 150                           // fixed baseline osmolytes (proteins/ions) — dominates osmolarity
S_NOM    = 177                           // nominal resting solute load (so A ≈ A_REST at rest)
LP       = 1.6                           // water permeability / relaxation rate
STIFF    = 7                             // membrane stiffness (resistance to expansion past rest)
RUPTURE  = 0.30                          // fractional radius stretch at which the cell lyses (DRAMATIZED; real ≈ 0.02–0.03)

solute = count_in(glucose) + count_in(amino) + count_in(lactate) + count(ATP_pool) + B_OSM
A_osm  = A_REST * solute / S_NOM         // volume at which inside osmolarity matches outside
resist = 1 + STIFF * max(0, A/A_REST - 1)
A     += (A_osm - A) * min(1, LP*dt) / resist
Rc     = sqrt(A / π)                     // current radius (drives the blob)
stretch = Rc/R0 - 1
tension = clamp(stretch / RUPTURE, 0, 1)
if (stretch >= RUPTURE) lyse()
```
Note the real rupture strain is ~2–3%, but a cell that *visibly balloons* is the readable warning a game needs, so `RUPTURE` is intentionally dramatized to ~30% radius. This is a deliberate truth-vs-legibility trade, flagged so it's a conscious dial.

### 7.5 Consequences to render
- The cell **visibly swells** (radius = `Rc`) as solute accumulates.
- Membrane **tension** drives wobble character (slack/lazy → taut/higher-frequency quiver) and colour (lipid-tan → strained red).
- Tint = **concentration = count / A**, so a swelling cell's contents visibly **dilute** (the doom-spiral seed).
- Building the waste exporter drops solute → osmolarity falls → water leaves → the swollen cell **deflates** back to safe size. The exporter is structural life support, not cosmetic cleanup.

---

## 8. Metabolism & the ATP economy

### 8.1 Glycolysis (anaerobic, the intro's engine)
```
1 glucose  →  2 ATP  +  2 lactate      (low anaerobic yield; the "janky coal-burner" phase)
```
Two lactate, not one: a C₆ sugar splits into two C₃ units, so the waste comes out doubled. Earlier drafts of this spec said one, and the prototypes implement one — §13.3 corrects it and notes the pacing consequence, which is that §12.3's swelling crisis arrives about twice as fast.
Enzyme has **one active site**: it binds one glucose, processes it over a bind time, releases products, resets. This caps single-enzyme throughput; **scaling is "build more enzyme copies," not "make it faster."** Production rate = enzyme_count × turnover.

Catalyst, so **not consumed** by the reaction: pay the one-time build cost, produce indefinitely.

"Consume what you import to keep importing": glycolysis' first step traps glucose the instant it enters, holding internal free-glucose near zero, so the import gradient never reverses and the free channel keeps flowing.

### 8.2 The ATP death clock (upkeep)
Staying alive drains ATP every tick (pumps, maintenance) — the rent from §2.3. The player must get production above it. When ATP is low, `health` falls, which slows the ooze and particle motion (distress → the alive-vs-dead visual). At zero, dormancy (forgiving) rather than hard death in the tutorial.

**Upkeep is per-tile, not flat** (§13.2). The prototypes use a flat 1.8 ATP/s, which reads fine in the intro but cannot produce the SA:V wall — if the rent does not grow with the cell, growing is never punished and §17's entire forcing function evaporates. `UPKEEP_PER_TILE = 0.0016` is chosen so that a §4.1-sized cell pays exactly the playtested 1.8 ATP/s, and a bigger one pays proportionally more. The intro therefore feels identical while the late game acquires a cost curve.

Economy at intro size (see §13): drain **1.8 ATP/s**, starting reserve **55 ATP**, each glucose crack **+2 ATP**, enzyme bind time **0.28 s** (≈3.5 cracks/s ≈ 7 ATP/s when fed). Net strongly positive once glucose flows, but with a real throughput ceiling and a real supply-line dependency.

### 8.2a A full battery must not look like a stalled one

The adenine pool is conserved, so ATP pins at `ATP_POOL_PER_TILE × tiles` and sheds the surplus as heat. That is correct biology and it is what §12.4 wants — "a full battery and a growing pile of amino acids with nowhere to go IS the intro's cliffhanger, the game telling you to go build a ribosome, through the economy rather than through a prompt."

**It only works if the ceiling is visible.** Observed in play with two channels and four enzymes: ATP climbed to 448 and stopped, and the reasonable conclusion was that something had broken. A cell at capacity and a cell that has stalled present identically — a number that stopped moving — and they call for opposite responses: one means *go spend it*, the other means *go fix your supply*. The HUD therefore shows ATP against its ceiling with a bar, flags FULL, and reports the ATP/s being wasted as heat.

The same principle applies to volume. §7.2 makes swelling a function of *total* solute regardless of identity, so "why is my cell growing" has a specific per-species answer the simulation knows and the player cannot see. Measured in the same session: `baseline 847, lactate 236, glucose 38` — lactate was the whole story, and nothing on screen said so. An osmolarity breakdown, largest first, with the biggest *changeable* contributor named, turns an unexplained climb into an obvious next action (usually: gate the channel importing it, or build something that consumes it).

Generalising: **any quantity that saturates needs its ceiling on screen.** A bare number that stops moving is ambiguous in a way that reads as a bug.

### 8.3 Aerobic upgrade (mitochondria — later)
Burns lactate/pyruvate with O₂ the rest of the way: yield jumps from **2 → ~30 ATP** per glucose and **mostly eliminates the lactate waste**, turning the entire lactate crisis into a resource. This is the "unlock a proper power grid" progression gate (anaerobic → aerobic is a genuine milestone). O₂ becomes an input (lung membrane); CO₂ becomes a waste (and a pH source).

### 8.4 Membrane as a build material
Enlarging the cell requires manufacturing phospholipids (from fatty acids + ATP) — a second production line alongside proteins. "Reinforce the membrane" (more cholesterol/saturated lipids) is a real upgrade that **raises the rupture threshold** at the cost of lower permeability and less deformability. Growth ordering lesson: **build the hull (create slack) before you fill it**; pump first and you spike tension and pop.

### 8.5 ER & Golgi — the assembler/packaging tier (later)
The **endoplasmic reticulum** is NOT a transport track (that's the cytoskeleton, §4.7). It is a manufacturing-and-packaging facility and the "next assembler tier" above free ribosomes:
- **Rough ER** (ribosome-studded): synthesizes and folds proteins destined for membranes, secretion, or organelles — a dedicated folding/quality-control hall.
- **Smooth ER**: synthesizes lipids — including the **phospholipids that are the membrane build material** (§8.4) — plus calcium storage and detox.
- **Golgi**: modifies, sorts, and packages ER output into **vesicles**.

The vesicles this district produces are **trucks that then ride the cytoskeletal roads** (§4.7) to their destination. So the pipeline is: ribosome/ER makes and folds → Golgi packages into a vesicle → motor proteins haul the vesicle along a filament → it docks and delivers (e.g., inserts a transporter into a specific membrane face). This is where "deploy a transporter to the correct face" (§9.2 step 5) becomes an automated logistics chain rather than the nanobot hand-carrying it.

---

## 9. Protein synthesis

### 9.1 The recipe: amino acids + ATP
Building a protein is literally `amino acids + ATP → protein`. Peptide-bond formation is **endergonic (~4 ATP-equivalents per residue)**, so the base recipe is exactly what intuition suggests — and ATP cost **scales with chain length**, so small enzymes are cheap and big complex proteins are naturally gated behind a larger energy economy.

### 9.2 The construction pipeline (fully prototyped in `enzyme_build`)
1. **Select gene at the nucleus** (the blueprint library). Choosing the gene = choosing the recipe. In the intro, transcription is collapsed — the nucleus hands over the blueprint directly.
2. **Read the bill of materials.** The blueprint is a *specific sequence* of typed amino acids (e.g., Leu-Gly-Gly-Lys-Ala-Gly-Leu-Val → Gly×3, Leu×2, Lys×1, Ala×1, Val×1) plus ATP ≈ 4 × length. The panel checks the cytoplasm pool; if short one type, the build **blocks on that specific bead** until it's imported or synthesized. (The rare amino acid gates the protein — the core supply-chain puzzle. The prototype ships with a surplus so it never blocks; the blocking case is the richest unbuilt mechanic and should be added.)
3. **Assemble residue by residue.** The nanobot (= the ribosome, until one is built) pulls a matching amino-acid dot from the pool (consumed), spends ~4 ATP (the counter ticks down in lockstep; low ATP visibly stalls assembly mid-chain), and extends the chain by one bead. First protein: deliberate, click-each-bead. Later: one click-and-watch. After a real ribosome exists: fully hands-off. ("Hand-mine before you build the drill.")
4. **Fold.** The linear chain collapses into a compact shape with a **pocket** that is the negative mold of the substrate (glucose). The shape *is* the function; watching the string snap into working form is the payoff beat. (Future: misfolding under stress wastes the spent amino acids + ATP → proteostasis mechanic with chaperones and recycling.)
**Interaction rules (both learned the hard way).**

*Carrying has to allow walking.* The first client made every click a deploy while carrying, so a folded protein stranded the nanobot wherever it had gathered its last residue and the membrane became unreachable — the server refused, correctly, and the run was stuck with no way out. Clicking a membrane tile now walks the bot over and seats the protein on arrival; clicking anywhere else just walks.

*The two products need two gestures, and both must be visible.* A transporter is seated where you click; an enzyme is released where the bot stands, which means single-click must stay "walk" — positioning the enzyme near its substrate is the actual decision (§4.7). So the drop needs a second gesture: **double-click**, plus a button for discoverability.

The failure worth remembering is how it presented. The on-screen label said "carrying — click a membrane tile" for *both* products, so a player carrying an enzyme was pointed at the one action that could not work, concluded the game was broken, and went hunting for a button. **A single wrong affordance reads as a bug, not as a misunderstanding** — the label is now product-specific, the drop site is drawn as a ring around the bot, and the release button highlights during the one moment it matters (as does the bleb, for the same reason in §10.4).

5. **Deploy — and this is where enzyme and transporter split.** A **transporter** must be carried to a membrane tile and embedded **on the correct face**; the instant it seats, that tile's permeability for its species jumps and transport begins. An **enzyme** is simply released into the cytoplasm, where it floats and works wherever substrate is. (Infrastructure bolted to a wall vs. a free agent in the soup — a real, internalized distinction.)
6. **Run continuously.** Catalyst = not consumed (§8.1).

### 9.3 The genetic code (how 4 bases → 20 amino acids)
- 4 RNA bases (A, U, G, C), read **three at a time** → **4³ = 64 codons** for 20 amino acids. (One-at-a-time gives 4; two gives 16 — short; three gives 64.)
- **Redundancy**: most amino acids have several codons (glycine = GGU/GGC/GGA/GGG — the third position barely matters). This is **error tolerance** — many mutations are silent.
- **Punctuation**: AUG = "start" (also codes Met, so proteins begin with Met); UAA/UAG/UGA = "stop" (code nothing → release the protein). The message is self-delimiting, like a data packet with header and terminator.
- **tRNA = the physical lookup table**: a two-ended adapter with an anticodon on one end and its amino acid on the other. The ribosome doesn't "understand" the code — it ratchets along the mRNA and matching tRNAs base-pair in and drop off their amino acid. The code is enforced by the *set of tRNAs*.

### 9.4 Proteins denature

§9.5's ribosome retires hand-assembly, and on its own that is only a convenience: a full build-out is about fifteen proteins and then you are finished forever. **Production lines exist because demand recurs.**

Every protein carries an `integrity` that falls over time; at zero it stops working and must be replaced. That turns §5b's supply chain from a one-time errand into something the cell must keep doing — §2.3's thesis applied to structure rather than energy.

```
MEAN_LIFETIME  240 s     the only timescale in the mechanic
FRAILTY        0.4–1.7   per-protein, hashed from its identity (§3.7 needs replay)
STRESS_FACTOR  6         multiplier at maximum stress
STRESS_ONSET   0.6       below this tension, stress is ZERO
REPAIR_AT      0.25      where `efficiency` starts to taper — see §9.5a
```

**It is a consequence, not a tax.** Decay is driven mostly by stress — membrane tension (§7.3) and brownout (§2.3) — so a well-run cell replaces proteins slowly and a struggling one sheds them fast, giving a failing cell a spiral it can see coming: swelling strains the carriers, losing carriers worsens the swelling.

Four constraints, each of which cost a rebuild to find:

- **A half-life of a VALUE is not a half-life to an EVENT.** Exponential decay toward a 0.02 failure threshold takes 5.6 half-lives — nothing failed for 68 minutes. It is a plain linear countdown, so `integrity` reads directly as "fraction of working life left".
- **Stress must have an onset.** Ramping from the first drop of swelling made an ordinary tension of 0.42 decay 3× faster, killing enzymes at 80 s instead of 240 — and it read as the *ribosome* being broken rather than as an osmotic problem. Below `STRESS_ONSET` decay is a plain clock you can plan around; above it you are in §12.3's crisis and losing machinery is part of what that crisis IS.
- **A narrow frailty spread is a cliff, not a mechanic.** Infrastructure is built in one burst, so at ±25% it all expires together — measured, every protein failed inside a single minute, with the repair bill arriving exactly when production was lowest. At 0.4–1.7 the same burst fails over ~10 minutes, so attrition is a stream the cell can service.
- **Ribosomes do not denature.** They are the only thing that can replace a ribosome, so mortality gave the network no floor and any run of bad luck was unrecoverable. Automation, once earned, stays earned — at the cost of the symmetry that everything the cell folds can be lost.

### 9.5 The ribosome

Not a build menu. A menu would retire §9.2's bead-walking and leave the player choosing from a list — a worse version of the thing it replaced, with the tedium gone and the decision gone with it.

**A ribosome senses its own neighbourhood and decides what to make.** It has a position and a radius (`RIBOSOME_REACH = 16`), sees what is failing near it, fixes that, and serves the player's standing orders. So the question stops being *what do I build next* and becomes **where do I put the thing that keeps this part of the cell alive** — §6.7's placement decision applied to maintenance.

Reach is sized against the geometry: the membrane sits at 18.4 from the centre, so a **central ribosome cannot reach it at all**. Three at ~9 tiles from the centre sit 15.6 apart — inside reach, so they maintain each other — and cover 382° of the ring between them. One is deliberately not enough; siting has to be a decision.

Triage: **ribosomes → production (channel, enzyme) → everything else → renewals → player orders.** Without the production tier the cell spends its last ATP rebuilding a lactate carrier while the glucose channel that would have paid for it stays broken.

#### 9.5a Pre-emptive repair — replaced when it falters, not when it dies

Waiting for failure means every protein spends a window dead, so even a fully-covered cell runs with holes in it.

An earlier attempt at this was a cheap partial top-up, and the objection to it was correct: a second cost, a second threshold and a second timescale, all outranking actual repairs. This version adds none of those. **A renewal costs exactly what a replacement costs, because it is one** — same bill, same 4 ATP per bond. **The threshold is not a new number**: it is `REPAIR_AT`, already the point where `efficiency` says the protein has begun to falter. And **dead still beats tired** — renewals sit below every vacancy in the triage.

> **A protein is replaced, at full price, when it starts to falter.** It just no longer has to die first.

Measured on a covered cell with supplies held non-limiting: zero proteins died, zero seconds without a flagellum, integrity floor 0.20 — a brief dip while the replacement folds.

**The price is a third of the material budget.** A protein lives `1 − REPAIR_AT` of its span, so standing residue demand rises 1.33×. §10A.8 carries that as an explicit `PREEMPTION` term rather than a re-measured constant, because it is §9.5's policy cost and not §9.4's decay cost.

#### 9.5b A hole nothing covers is not a queue

The last flagellum denatured on a membrane tile outside every ribosome's reach. At 25 simulated minutes it had not been rebuilt and never would be — and the cycle closes on itself:

> you cannot swim to a deposit without a flagellum, and you cannot fold a flagellum without residues from a deposit.

The principle this violates was already written down for §9.2's sequences — the flagellum deliberately needs no lysine, because gating the thing you need to *go get more* behind the thing you are out of is a deadlock rather than a dilemma. It turned out to be gated by **time** instead, and nobody had checked.

1. **A vacancy outside every ribosome's reach is never repaired**, and nothing distinguished it from one that is queued. `covered` rides on the wire per vacancy; the client draws an uncovered hole as a solid crossed ring rather than a dashed one.
2. **A disabled control must say why.** The seek buttons greyed out on `flagella.length === 0` and stopped there, so an unresponsive UI was the only symptom of a state that had been developing for minutes.
3. **The unrecoverable case is stated, not deduced.** `stranded` is deliberately *not* `flagella.length === 0` — losing a covered flagellum is a thirty-second inconvenience, and conflating them trains the player to ignore the warning. It fires only when there is no flagellum, none coming, no covered vacancy, **and** not enough residues or ATP to fold one by hand.

> **A game may take away anything except the last means of recovery — and if it does, it must say so.** The failure was not that the cell could die; it is that it died silently, with a control that stopped responding as the only symptom.

### 9.6 The ribosome queue — asking for a protein

A ribosome that can only put back what was already there is a repair crew, not a factory:
nothing new could be built without the nanobot walking a chain bead by bead. The queue is
what makes automation able to *make* something.

**Orders sit below every repair and renewal in the triage (§9.5), and that ordering is the
design.** A cell that spends its last lysine on what you asked for while a glucose channel
rots is obeying rather than automating. A queue is what the ribosomes do with *spare*
capacity — which also means a cell under maintenance pressure visibly stops taking orders,
and that is information rather than a failure.

**A finished order is handed to you, not placed.** A ribosome knows where a repair goes —
back in the hole — and cannot know where you want something new, so §6.7's placement
decision stays yours. Taking one loads it into exactly the carrying state hand-assembly
ends in, so deploy, membrane validation and every event already work on it unchanged.

The queue is bounded (8). Unbounded, a player parks a hundred orders and walks away, which
turns the ribosome from something you direct into something you fill once.

### 9.7 Full pipeline (later layers)
DNA (master record) → **transcription** → mRNA (disposable working blueprint; number of mRNA copies of a gene = that protein's parallel production rate — the production dial) → ribosome reads codons → tRNAs translate. Expose the mRNA codon strip under the amino-acid beads as an optional depth layer.

### 9.8 Mutation as a mechanic (evolution + disease share one root)
A single base flip has a **spectrum** of outcomes falling out of the code's structure: **silent** (hit a don't-care third base — nothing changes), **missense** (swap one amino acid — a different protein, maybe better/worse — raw material of evolution), or **nonsense** (create a premature stop — truncated, useless protein). One mutation system yields the evolutionary tech tree and the disease system from a single elegant root. (Ribosome/tRNA decode animation intentionally deferred.)

---

## 10. Failure modes & death

### 10.1 No toxicity thresholds — kill via real mechanisms
"Solute X exceeds threshold → die" is a made-up mechanic and should be avoided. Lactate in particular is essentially non-toxic (it's a fuel). Deaths emerge from real coupled systems already in the model.

### 10.2 Osmotic lysis (primary, implemented)
Trapped solute → high internal osmolarity → water floods in → cell swells → membrane tension climbs → **lyse (burst)** past threshold. This is the §7 volume model driven by a metabolic backup. The chain — enzyme runs → lactate accumulates → osmolarity rises → water enters → volume grows → tension climbs → lyse — is entirely built from existing mechanics.

### 10.3 The doom spiral (self-accelerating)
Swelling dilutes everything, including glucose and the enzymes doing the work, so reaction rates sag exactly when throughput is most needed; and rising tension stresses the transporters that could clear the backup. Falling behind makes it harder to catch up. In the prototype, dilution is *shown* (tint = count/A) but not yet fed back into enzyme rate — **wiring dilution → slower reactions is a one-line addition** that makes the crisis accelerate itself.

### 10.4 Survivable pre-death, three acts
A red-line threshold is binary and unfair. The swell gives a **visible, gradual, survivable** warning: **swell → strain → (clear the waste, or emergency bleb to survive, or lyse if ignored).** Blebbing pinches off a vesicle to shed volume + solute at the cost of lost material (prototype: remove ~55% of interior lactate, `A *= 0.80`, enabled when `tension > 0.55`). Agency in each act, not a fail state that snaps shut.

### 10.5 Acidosis (pH — deferred by design)
Lactate is really lactic acid (lactate + H⁺); anaerobic runaway is really an acid runaway, and it's the **pH crash** (not lactate) that denatures enzymes. Model pH as a **global efficiency multiplier on every enzyme**. Under-ventilating (CO₂ buildup → carbonic acid) is another acid source. Deferred per current scope, but the coupled-transport carrier (§6.4) that co-exports H⁺ plugs in exactly here.

### 10.6 Other over/under-concentration diseases (the taxonomy)
One transport engine yields a whole disease taxonomy for free, each a distinct failure signature: hyperglycemia (osmotic), hypoglycemia (neurons brown out first — high glucose permeability, no storage), hyponatremia/water intoxication (cells lyse), hypernatremia/dehydration (cells shrivel), hyperkalemia (K⁺ gradient collapse → membrane-potential failure → heart-stop analog, a good sudden-death mechanic), acidosis/alkalosis (pH efficiency hit).

### 10.7 Cancer (later)
One of the player's own production buildings stops obeying its blueprint, replicates uncontrollably, drains resources, and spreads. Immune surveillance normally catches it; skimp on surveillance and it metastasizes. An internal enemy the player built.

---

## 10A. Motility & exploration (makes the outside a place)

Right now the environment is a uniform pantry. Motility turns it into a **place**, and gives the game an exploration axis. Prototyped in `motility_chemotaxis.html`, which runs a genuine grid field for glucose and closes the sense→decide→actuate loop over it (see §18 for what that prototype does and does not validate).

### 10A.1 Motors & rudders
Flagella and cilia are ATP-driven propellers. **Swimming is expensive** and competes directly with construction for ATP, so exploration is a deliberate diversion of the energy economy — kept in permanent tension with everything else, never free. Build a flagellum (a protein assembly, via §9.2) and running it drains ATP for thrust; steering biases which propellers fire.

### 10A.2 The environment becomes patchy
Once the cell can move, the outside stops being uniform: glucose-rich pockets, toxic zones, warm currents, regions other cells have already stripped bare. This creates a reason to **explore** (find richer food), a reason to **flee** (leave a depleting or hostile patch), and spatial stakes for the outside to match the cytoskeleton's spatial stakes for the inside.

### 10A.3 Chemotaxis — free from existing mechanics
A cell steers up a concentration gradient by sensing "is [nutrient] denser ahead than behind?" and biasing its motor. This is a **sense → decide → actuate** loop built entirely from concentration differences — the game's core currency — so it costs no new primitive. It gives gradients a *behavioral* output (not just a transport driver), and it is the seed that later industrializes into the **nervous system** (the same loop, scaled up). Foraging is the early-game version; a nervous system is the late-game version.

### 10A.4 Design tension to resolve deliberately
Factory games are usually about a *fixed* base you elaborate; motility is about a *mobile* unit. These pull in opposite directions. Recommended arc: **the single cell is mobile (a forager) in the early game; multicellularity anchors the player into a fixed, elaborate organism later.** The game transitions from *nomad* to *settler*, and the loss of easy mobility becomes a felt consequence of getting big — which dovetails with the SA:V wall (§17) that forces the jump.

### 10A.5 How motility works

**Thrust is paid out of the same ATP pool peptide bonds are**, at 3.6 ATP/s per firing flagellum. That figure is derived, not picked: one glycolysis enzyme nets ~7.14 ATP/s, so **running one flagellum costs almost exactly half an enzyme.** Coasting is genuinely free, which is what makes it a trade rather than a tax. (The prototype assigned `speed = 74` unconditionally every frame, so the tension §10A is built around did not exist at all.)

**The cell moves without re-tiling.** It keeps a continuous position in a larger world and the grid is a window that travels with it: the cell's tiles never move relative to the lattice, and what changes is which part of the world the *extracellular* tiles look at. This sidesteps §3.6's moving-boundary problem entirely, which is the right trade — re-tiling is the genuinely hard seam and motility does not need it.

**Velocity is set, not integrated.** At cell scale the Reynolds number is minute; a bacterium that stops swimming coasts a fraction of an atomic diameter. Modelling momentum would give a submarine, not a microbe.

**Thrust runs along the inward normal**, so a flagellum pushes the cell *away from itself* and a cell with every flagellum on one face can only travel one way. Steering is choosing which fire — another instance of §6.7.

**Chemotaxis is greedy and local.** A real cell climbs the gradient it can *smell*, not the best food on the map: between a near pocket and a far richer one it climbs the near one. The tested claim is that *the concentration where the cell is goes up*. Repellents need no new primitive — hostile patches subtract from the same sense, exactly as a real chemoreceptor handles one.

**Patch depletion is what makes foraging exist.** A patch that never runs out makes motility pointless. Depletion is attributed by **contribution share** — each patch loses in proportion to how much of what reaches the cell came from it — which is robust to any geometry and more honest than a radius test: you draw down what you are actually drinking from.

> The opening pocket's concentration at the membrane is load-bearing: raising it from 0.47 to 0.91 nearly doubled import and **lysed the cell on an arc it had always survived.** Any change that makes the environment richer re-tunes everything downstream of it, so the acceptance test for reshaping a pocket is that this number does not move.

### 10A.6 What actually motivates travel

Depletion alone does not. Measured with depletion working correctly, a cell sitting on an emptying pocket does not care: upkeep is 1.8 ATP/s against three enzymes grossing ~21 ATP/s, so **supply must fall below ~8% before ATP moves at all**, and ATP sat at its ceiling at richness 0.00. Draining a patch makes it *look* empty without making leaving *necessary*.

Energy was never going to be the reason, because **glucose is everywhere**. Materials are: a residue you cannot substitute, whose deposit is somewhere specific, gates a specific protein — so a lysine shortage is a destination rather than a wait.

> **A resource motivates travel when it cannot be substituted and is not uniformly available.** ATP fails both tests. Typed residues pass both.

Energy scarcity is still coming, from §14's growth and division — a body big enough that §17's SA:V wall bites. That is a design dependency, not something to chase with constants.

### 10A.7 The cell is pinned to the centre, so nothing looked like motion

Same playtest, second half: *"why aren't we actually swimming?"* — while the simulation was swimming **36.0 tiles in 8 s**, exactly `FLAGELLUM_SPEED × 8`.

§10A.5 records that the grid is a window that travels with the cell, so the cell's tiles never move relative to the lattice and the *world* moves past instead. That is the right simulation design — it sidesteps §3.6's re-tiling entirely — and on its own it is visually mute: the cell sits dead centre, the membrane never shifts, and the only thing on screen that moved was a patch gradient drawn at **alpha 0.10**, which is close enough to invisible.

A correct, measured, fully working 4.5 tiles/s therefore read as "the flagella do nothing". Three fixes, none of them touching the simulation:

- **Particulate motes in the medium**, anchored in WORLD space and hashed per world cell, so they slide past as the cell swims. Nothing in the sim moves them and nothing reads them — honest parallax, the visual equivalent of looking out of a window. Stateless and seamless.
- **Patch alpha 0.10 → 0.26**, so the terrain reads as terrain rather than as void.
- **Speed in tiles/s on the motility panel**, because when the avatar is pinned to the centre of the view, a number is the only unambiguous statement that it is moving.

The general lesson, and it is a counterpart to §11.3b's: *any smooth interpolation in the render layer asserts that something moved.* The converse also holds — **if the camera is locked to the thing that moves, nothing on screen asserts motion at all, and the player will conclude the mechanic is broken.** A moving frame of reference needs its own texture.

### 10A.8 Deposits are sized against what consumes them

The reserves were originally authored as "roughly twice the starting stock" — an inventory-shaped number in a world that had since acquired §9.4's metabolism for structure. Measured against §14's standing build-out (17 proteins, 181 residues) at a mean working life of 252 s, demand is **0.718 residues/s — 43 a minute, forever**, while the five deposits held 168 particles between them. **The whole map contained less amino acid than one build-out costs**, and regrowth ran two orders of magnitude below consumption, so the world was a fuel tank with about six minutes in it.

**Regrowth and reserve answer different questions**, and they had been conflated with only the second existing:

```
regrowth_i = 1.4 × demand_i     decides whether the world is sustainable AT ALL.
                                headroom for what a player cannot realise: travel time,
                                a hopper that stalls while they are elsewhere, and a
                                deposit at full richness regrowing nothing
reserve_i  = regrowth_i × 600   decides only how long you can ignore a deposit.
                                ten minutes of its own regrowth = one foraging circuit
```

The second identity ties deposit size to **circuit time**, so map pacing follows from how far apart the deposits are rather than from a tuned number: a deposit refills in exactly the time it takes to go round and come back.

The old global rate was a flat increment of *richness*, which is reserve-relative — so it scaled with the size of the pocket rather than with the demand it had to meet. **This is the same lesson `reserve` had already learned one field over** ("a single global rate cannot work across species whose quantities differ by two orders of magnitude") and the code had not followed through.

**An ore patch is not a gradient.** Scaling draw rate by `richness` makes extraction exponential, so a deposit asymptotes toward empty and **can never be stripped** — a two-minute stop collected 46% of it and the last quarter was unreachable at any duration. Residue draw now runs at full rate until a quarter remains, then tapers: the same curve `efficiency` uses for a worn protein, and a deposit becomes a quantity you can plan against.

Measured over a 30-minute five-stop circuit: 89 proteins lost, 88 rebuilt, inventory 264 → 968, zero seconds blocked. Parked on one deposit instead, the cell runs dry and spends 1133 of 1800 s blocked — so §10A.2's *reason to leave* survives the fix. **This also closes §10A.6**: denaturation is the sink that section was looking for, arriving in materials rather than energy.

### 10A.9 Auto-seek: go to whatever is lowest

Playtested ask: *"a feature where the seeker will seek whichever thing is in shortest supply, including glucose."*

**Sort the counts. Go to the lowest one.** The counts are the ones already on the HUD — residues from the inventory, glucose particles inside the cell — so "it is going for lysine because lysine is lowest" needs no explanation and no readout to audit. It drives `chemotaxis` rather than replacing it, so §10A.3's gradient climbing is still the machinery that gets there, and turning auto-seek off leaves the last course it set. Picking a species by hand takes the wheel back.

One piece of supporting machinery, kept only because without it the feature does not function: **`SWITCH_MARGIN`**. Two stocks a single particle apart swap places as they drain, so a seeker with no hysteresis turns around every time the numbers cross and travels nowhere.

#### 10A.9a The version that was built first, and why it was wrong

The first implementation modelled scarcity properly: seconds of runway (stock ÷ net drain), minus seconds of travel to that deposit, with glucose converted into ATP-equivalents so it could be compared against the pool it feeds rather than against a particle count. It needed income metering at the ports, a drain meter inside `EnergyPool`, a demand model derived from the standing build-out, and a brownout special case — because a starving cell spends nothing, so measured drain collapses toward zero exactly when the cell is dying and the runway reads as *enormous*.

Every piece of that was defensible. The whole was wrong for this game, and the objection is the one §5b already made about concentration and §5d made about `GRAIN_UNIT`:

> **A quantity the player cannot see is not a quantity they can play against.** Slack was derived, invisible on screen, and unpredictable from anything that was — so a decision made on it could only be trusted or distrusted, never anticipated.

Recorded because the failure mode recurs in this codebase and the tell was available early: **the feature grew four supporting subsystems before it did anything.** The shipped version is one sort and a margin.

**What sorting counts actually does, stated rather than defended:** interior glucose is a *pipeline*, not a stockpile — whatever is in transit between the membrane and the enzymes, capped by `INTERIOR_SATURATION` — so it is usually the smallest number on the table and the seeker picks it often. Measured over 25 minutes it spent 20 of them heading for glucose. Whether that is the right game is a balance question for a playtest, not an argument for a cleverer estimator.

---

## 11. Rendering & the visual language

This section is the "costume" half of §2.1. Every rule here is downstream of one constraint: the render layer reads simulation state and never writes it. §3.7 makes that structural — the renderer runs in a different process and physically cannot write back.

### 11.1 Concentration = transparent additive particle density
Render solute fields as semi-transparent dots with additive blending (`globalCompositeOperation = 'lighter'`), so overlap sums toward bright: **a crowded compartment glows, a sparse one is pale** — density reads as intensity with no legend. Dot count is a scaled sample of the field: `count = clamp(round(concentration / scale), 0, cap)`, spawned/despawned to match. Do **not** simulate millions of molecules; dots are cosmetic.

### 11.2 Motion
Each dot does an **independent Brownian random-walk** (a small random step per frame) — NOT pairwise collision (expensive, adds nothing legible). Two independent motion knobs:
- **Speed** (jitter rate) ∝ diffusivity: small molecules shimmer fast, big proteins lumber.
- **Character** (quality): jitter (staccato, ions), drift (slow sway, water), tumble (lazy loops, glucose), glide (smooth/directional, proteins). Two species at the same speed stay distinguishable by character.

Motion is **preattentive** — read in the periphery before conscious attention, which is why it's the channel that carries "what's in this compartment" at a distance (shape dies first when small; size and motion survive). A species' signature wiggle **rides on top of bulk flow** like a swimmer's stroke in a current; keep the two layers separable, and keep the signature small enough not to read as spurious flux.

To show **flux**, bias dots near a membrane to drift across in the net direction at a rate ∝ computed `J`. To show **advection**, carry dots along flow at the pump rate (the glucose bolus visibly travels and thins).

### 11.3 Per-type sprites & the redundancy rule
Spend the ~6–8 signature slots on managed species; make them **self-teaching** (ATP = spark/charge, water = near-invisible ambient dot, ions = tiny + / − specks, glucose = warm hexagon, amino acids = little modular blocks that foreshadow snapping into chains). Because transparent overlap **blends colours** (amber over teal muddies), never rely on colour alone: stack **colour + size + motion + silhouette** redundantly. This also keeps it readable for colour-vision-deficient players.

### 11.3a The dot budget is not optional (measured)

§11.1 says "do **not** simulate millions of molecules; dots are cosmetic" and gives the rule `count = clamp(round(concentration / scale), 0, cap)`. The cap in that formula is **per tile**, and a per-tile cap is not a budget. Implemented literally, with `scale` around 0.02–0.05 and the eight managed species of §5, the first client asked canvas2d for **102,798 dots per frame** — 205,596 arcs, 205,596 composite-mode changes, and 205,596 freshly built `rgba(...)` strings, every frame, against a practical budget of perhaps 50–100k arcs per *second*. Roughly 150× over, and unplayable.

Three rules keep it honest and cheap, in descending order of what they save:

1. **Dots are for the cell; tint is for the medium.** The extracellular space is ~90% of the tiles and the least informative part of the picture. §11.4 already prescribes tint for bulk regions — doing it is what turns ninety thousand arcs into one scaled blit.
2. **An aggregate budget, per species**, summing to ~1,500–2,000. A concentration spike then costs brightness, not framerate.
3. **Batch by species.** One `fillStyle` and one path per species per layer, instead of two state changes and two paths per dot: 2 canvas state changes a frame instead of 205,596.

Measured on a live cell after the rewrite: **1,119 dots, 2,238 arcs, 2 state changes, 16 strings** — a 92× reduction with no visible loss, because ninety thousand of those dots were stacked in a medium the eye reads as a wash anyway.

**Typing the amino acids multiplied this by five**, since each residue became its own full-field cloud. Any future species added to §5 costs a full particle layer, so the budget has to be divided, not extended.

The budget does clamp genuinely dense regions, which is a §2.1 tension — density stops tracking concentration at the top end. The resolution is to make the clamp *visible*: the on-screen counter reports the dot count and flags `(clamped)`, so the costume never quietly under-reports without saying so.

### 11.3b Particle placement must be spatially truthful

§11.1 says dots are "spawned/despawned to match" the field, and the word doing the work is **match**. Three artifacts came from implementations that got the count right and the *placement* wrong, and each one read as physics that was not happening:

| what the code did | what it looked like |
|---|---|
| reassigned dot *n* to the n-th emitted tile each frame | a constant swirl — the cytoplasm appears to circulate |
| retargeted an emptied dot without moving it, letting it ease | a tornado — a few dots streak across a static field |
| appended new dots in row-major order as concentration rose | the cell **fills from the bottom**, wherever production actually is |

The third is the most insidious, because it is a plausible-looking lie: ATP produced at an enzyme in the middle of the cell appeared along the bottom edge, and nothing about it looks like a bug.

The rule that makes all three impossible rather than merely unlikely: **placement is quota-driven, not order-driven.** Each tile gets the number of dots its own concentration justifies; a dot whose tile still has quota does not move at all; leftover quota is filled by dots *spawned at* those tiles. A dot that must relocate is a despawn plus a spawn — never a glide, because a glide is the visual language of flow.

Corollary worth stating plainly: **any smooth interpolation in the render layer asserts that something moved.** If nothing in the simulation moved, do not interpolate — snap.

#### 11.3c Placement must be truthful in TIME too

The quota rule above fixed *where* dots go and left *when they exist* broken, in a way that took a playtest to name: "the flashing is too much."

The quota was computed with a running accumulator that walked the interior in row-major order and awarded a dot each time a carried sum crossed 1. Spatially that is exact. But `acc` carries **across tiles**, so a small change in any one tile shifts every later crossing onto a different tile — and the dot set is reassigned wholesale. Measured on a live mid-game cell, between two consecutive received frames: **22.6% of all dots despawned and respawned every frame, and for lactate it was 52%.** Nothing in the simulation was moving. The renderer was re-rolling the picture thirty times a second.

This is the same defect class as the swirl, the tornado, and the fill-from-the-bottom — *order dependence* — merely projected onto the time axis instead of the space axis. Quota now comes from a fixed dither of each tile's own value:

```
quota = floor(c / scale + dither(worldX, worldY))
```

`dither` is a hash of **world** coordinates, so it is identical every frame and survives zoom (lod changes tile indices; keying off the index would re-roll every dot when the player touched the wheel). Expected total is still exactly `Σ c/scale`, so §11.1's proportionality is untouched and sparse regions still contribute rather than rounding away. What changes is that a tile gains or loses a dot only when **its own** value crosses a threshold. Measured churn fell from 22.6% to **1.4%**.

The rule, stated to match §11.3b's: **a dot's existence must depend only on its own tile.** Any placement rule with global coupling will shimmer, however correct its totals.

#### 11.3d How much is one dot worth?

Playtested: *"the amino acids and the lactate and glucose are overwhelming… make them represent more of an item each so there are fewer to understand."*

A species' dot budget is set by **how much it has to say**, and its scale derived from that rather than chosen by eye:

```
scale = (mean concentration × interior tiles) / target dots
```

Measured, that took a mid-game cell from 1,466 dots to 285 — 5.1× fewer, each worth 5.1× more, with no loss of information because the biggest contributor was a residue cloud that was essentially flat (glycine 0.0389 mean against 0.0392 max) and encoded nothing.

The legend prints the worth of one dot, because "fewer dots" otherwise reads as "less of it".

> **Give a quantity dots in proportion to how much spatial structure it actually has, not to how much of it there is.**

That argument was eventually followed all the way: residues stopped being drawn as dots at all (§5a.9), since a uniform wash is the honest depiction of a well-mixed pool and dots imply somewhere to walk to.

#### 11.3e Shape is the third channel

§11.1 gives density to concentration and colour to identity. With eight managed species — five of them amino acids — colour alone was seven hues shimmering in overlap, and the first playtest note about it was "unclear what each of the particles in the cell is". Shape is the channel that survives being small, dim, overlapped, or colour-blind.

The mapping is the carbon skeleton rather than a palette:

| species | shape | why |
|---|---|---|
| glucose | hexagon | a **hex**ose — six carbons |
| lactate | triangle | a triose — three carbons |
| ATP | four-pointed spark | energy, not matter |
| residues | square | one family, one shape, told apart by colour — the beads §9.2 threads onto a chain |

The payoff is that **glycolysis becomes readable without a HUD: one hexagon vanishes and two triangles appear.** §8.1's `LACTATE_PER_GLUCOSE = 2` is the C6 → 2×C3 split, and it is now something you watch rather than something you read. The legend draws its swatches through the same function the field renderer uses, so it cannot drift out of sync with the picture — which is §2.1 applied to the legend itself.

### 11.4 Level-of-detail handoff
Zoomed in (few compartments): lush individual dots, watch each import event. Zoomed out (thousands): render fields as **heatmap tint** (numbers on hover). Between: hybrid (tint + sparse representative dots at flux hotspots). Because a colour heatmap cleanly shows only **one** scalar, provide **toggleable layer overlays** (view the glucose field, flip to Na⁺, flip to pH) like a map app's data layers.

### 11.5 The ooze (aesthetic & meaning)
Overall feel: **squishy, viscous, constantly and gently oozing** — lava-lamp/jellyfish, slow to start and stop, damped, never snappy, low resting amplitude (so stress reads as a *departure* from calm). **Motion means alive; stillness means death** — on death, everything stills, the membrane slackens, colour drains (the truest death cue, and free, since it's the absence of the animation already running).

**Membrane oscillates while maintaining volume** — the wobble must be **shape-only** (a zero-mean perturbation of the radius; enclosed area held constant), because changing enclosed area would change concentration and make the costume lie. The prototype `memR`:

*Verified, and it holds better than "approximately."* Enclosed area is `½∮R²dθ`, so a zero-mean perturbation of `R` does not automatically preserve area — there is a second-order term. Working it out for the harmonics below: the first-order term vanishes for all `t` (distinct non-zero integer harmonics), **and so do all the cross terms**, leaving `A = πR₀²(1 + 0.00166·o²)`. That is a **constant +0.17% offset that does not vary with time** — the implied volume is perfectly steady while the shape oozes, which is strictly stronger than the requirement. Keep this formula; do not "improve" it. (The area error is ~57× smaller than the visible radial excursion, and the 140-gon render path's own −0.03% deficit partially cancels it.)
```
o = 0.02 + 0.05 * health
lazy   = o * (0.9*sin(3θ + 0.7t) + 0.6*sin(5θ - 0.5t) + 0.4*sin(2θ + 1.1t))   // zero-mean in θ → area preserved
tremor = tension * 0.014 * sin(9θ + 7t)                                       // taut high-frequency quiver
R(θ)   = Rc * (1 + lazy * (1 - 0.5*tension) + tremor)
```

### 11.6 Soft-body (the physical route)

Implemented in `apps/client/src/softbody.ts`, and it replaced §11.5's `memR` harmonic sum rather than sitting alongside it. The same three harmonics now drive an ambient **force** along the ring's normals instead of setting a radius directly, so the motion is damped and laggy — §11.5's "slow to start and stop, never snappy" — instead of kinematically exact.

**Two motions, deliberately separated.** This is the design decision worth carrying forward:

- **Breathing** — a uniform scale tracking `√(volume / restArea)`, which is how §7.5's "the cell visibly swells" actually reads on screen. At rupture that is a 30% stretch.
- **Ooze** — a bounded, zero-mean perturbation *around* the breathing shape, capped at 13% of radius.

They have to be separate because the membrane's **tiles do not move** — volume is decoupled from tile count until re-tiling exists (§3.6) — so a single leash tight enough to keep the ooze honest would also mute the swelling, which is the intro's most important warning. Splitting them lets the shape carry the volume faithfully while the wobble stays anchored to the real membrane.

**What made this necessary.** The membrane had been an oozing analytic curve; then, while fixing a real §2.1 violation (the drawn ring sat where the membrane tiles were not, so clicks meant to seat a transporter landed on cytoplasm), it became a ring of axis-aligned squares stamped from the tile list. Correct, and completely rigid. In a visual language where "motion means alive; stillness means death", a membrane that cannot move states that the cell is dead. Both constraints hold now: rest shape from the real tiles, motion on top.

The properties that matter are tested rather than asserted (`apps/client/test/softbody.test.ts`): enclosed area holds to <2% while the ring visibly moves, it never settles into a dead circle, tension raises frequency while *lowering* amplitude, a lysed husk goes slack and stops holding its area, and reduced motion slows the ooze without freezing it.


The right underlying object is a **pressurized soft-body loop**: a ring of points joined by springs with an outward pressure force holding a target area. Pressure target = volume; spring stiffness = membrane tension (the reinforcement upgrade stiffens springs); underdamped area-constrained motion *is* the "oscillate while maintaining volume" wobble. Two cells pressed together each hold their area and deform against each other → the shared interface flattens → a crowd packs into rounded polygons → **confluent tissue is a foam, for free.** (This lush soft-body is a close-up luxury; zoomed out, cells simplify to a breathing/static foam.)

### 11.6a The membrane ebbs, and drags when it swims

Playtest: *"while the membrane does spring in at startup, it doesn't move after that… I would expect a gentle ebbing and flowing when it isn't fully stretched, and that moving along would create drag and ripples."*

**The idle ebb existed and was too weak to see.** Ambient forcing scaled as `(1 − 0.45·tension)`, leaving a *relaxed* cell oscillating about 9 px on a 200 px radius — under 5%, indistinguishable from a still picture. §11.6 says spring stiffness IS tension, so slack should roll and taut should merely quiver; it now scales `0.35 + 1.45·slack`.

**Drag and ripples are new.** A uniform force opposing travel offsets the ring against its own leash — flattening the leading edge, bulging the trailing one — and a travelling wave sheds down the flanks, weighted by `1 − facing²` so it peaks at the sides where the shear is and vanishes at nose and tail. Both scale with `√speed`: responsive at a crawl, saturating rather than becoming a comet.

The drag force is deliberately **uniform across every node**. That deforms without inflating, so §11.5's guarantee holds and the shape still encloses exactly the volume the HUD reports.

**Two metrics were wrong before one was right**, and the pair is worth remembering when testing anything visual:

- *Distance from a nominal circle* scores a taut membrane's different steady shape as if it were motion.
- *Path length* rewards high-frequency tremor — a taut membrane quivers fast and short, covering more distance while looking perfectly still.

"Ebbing" is **amplitude**: peak-to-peak radial swing per node. Measure the thing the complaint was actually about.

### 11.7 Motion is not decoration

*This section required a **reduced-motion** setting that damped the ooze to 18% amplitude, defaulting to the OS `prefers-reduced-motion`. It was built, then removed on playtest evidence.*

Playtested: *"the motion reduction turned off is way better — nice and organic."* Then, having played with it off: *"remove this reduce motion thing and make the motion enabled by default."*

The setting is gone, along with the toggle and the OS default. The membrane now always breathes at full amplitude, and the only thing that stills it is death (§11.5) or low health.

**The reasoning that stands, and the reasoning that did not.** §11.5's rule survives untouched — *motion means alive, stillness means death* — and it is precisely why a damped setting was a poor fit here: it made a healthy cell read as a dying one, using the same channel the game reserves for mortality. A visual language cannot carry a comfort setting on the same axis as its most important signal without the two colliding. That is a design reason rather than a rendering one, and it only became visible with a cell healthy enough to sit and watch (§16.6).

**What is given up, recorded rather than glossed.** Vestibular accessibility. The original requirement was a real one — constant ambient motion genuinely does fatigue some players — and nothing replaces it. The button pulse still honours `prefers-reduced-motion` in CSS, but the cell itself no longer does. If this is revisited, the axis to damp is probably the *camera and parallax* (§10A.7's motes and patch drift, which carry no meaning) rather than the membrane (which carries the most).

---

## 12. The intro / tutorial (the playable arc)

The intro *is* the whole cell in miniature and doubles as the recap. It is fully prototyped in `full_cell` as a progressive build-up. **Un-loseable**: if ATP hits zero, drop into dormancy and nudge, don't hard-fail.

### 12.1 Opening state
A bare cell: oozing membrane, **nucleus** (clickable blueprint library, with the ribosome visible but locked = signposted goal), the **nanobot** drifting inside, and a small **ATP reserve already draining** (staying alive costs energy every second). Do nothing and ATP falls, the membrane slackens, motion slows — the pressure that makes the first build urgent. Outside: a **glucose-rich zone** on one face, an **amino-acid-rich zone** on another (concentration zones shown by dot density + faint tint).

### 12.2 Act 1 — Crisis (import food)
Build the **glucose channel** on the face pointing at the glucose zone. Glucose pours in **for free down its gradient** (a channel, NOT a pump — reading the gradient is the first lesson: don't pump in what already wants to enter). But ATP keeps falling: **raw glucose isn't energy yet.**

### 12.3 Act 2 — Stabilize (close the loop)
Build the **glycolysis enzyme** (via the §9.2 pipeline). It cracks glucose → 2 ATP (+ lactate). The ATP counter turns around and climbs — the death clock beaten, the cell self-sustaining. This is the emotional peak. Then build the **amino-acid transporter** on the opposite face; building material now stockpiles inside (waiting for a ribosome). Meanwhile **lactate accumulates**, raising osmolarity — the cell begins to **swell** (§7), tension climbs, the membrane reddens. Build the **lactate carrier** on a third face; waste flows out down its gradient, osmolarity drops, and the swollen cell **deflates** back to safety. (If the player dawdles, the swelling is the visible warning; the **bleb** button is the emergency escape.)

### 12.4 Act 3 — Automate (retire the nanobot's hand-labor)
Build the **ribosome** — the first true assembler — so protein production goes hands-off, consuming the stockpiled amino acids automatically as long as ATP holds. This is the Factorio "drill replaces hand-mining" moment and the intro's exit into the real game. The stockpiling amino acids that "had nowhere to go" are the deliberate cliffhanger the whole intro signposts.

### 12.5 Readability check
By the end, every species is identifiable by motion alone (glucose slow amber tumble, amino fast teal jitter, ATP bright flicker, lactate dull green drift), each transporter is on the face pointing at what it moves, and the ATP/amino/lactate/tension HUD reads the exact state under the costume.

---

## 13. Tuning constants (single config block)

**Critical implementation note:** these numbers *are* the difficulty of the intro, and balancing them against each other is the knob that makes the opening tense-but-fair. They must live in **one config block** (`packages/sim/src/constants.ts`), not scattered as magic numbers through the update loop — the prototypes scatter them, and worse, run three mutually incompatible ATP economies (§16.2). Every value below carries the derivation that produced it; a constant without a derivation is a bug waiting to be re-tuned by guesswork.

**Units are grid-native.** Lengths are tiles, times are seconds, amounts are per-tile. The prototypes' pixel and particle-count units (`R0 = 150 px`, `IMPORT_PULL = 130`) do not survive the move to a real field — several of them were choreography parameters describing how particles were *drawn*, not quantities the simulation had.

### 13.1 Geometry (from §4.1)
```
INTERIOR_TILES  = 1000                        // §4.1
MEMBRANE_TILES  = 120                         // §4.1, the ~10% ring
CELL_TILES      = 1120
R0              = sqrt(1000/π)   = 17.8       // rest radius, tiles
TRANSPORTER_FACE_TILES = 13                   // 0.34 rad half-width (old TRANSPORTER_WINDOW)
                                              //   = 0.68/2π = 10.8% of a 120-tile ring
```

### 13.2 ATP economy — upkeep must scale with size
The old flat `ATP_DRAIN = 1.8` cannot coexist with §17: if upkeep does not grow with the cell, there is no SA:V wall and no forcing function. Anchor per-tile upkeep so it reproduces the playtested intro pacing at intro size, and scales correctly thereafter:
```
UPKEEP_PER_TILE = 1.8 / 1120 = 0.0016    // ⇒ exactly 1.8 ATP/s at §4.1 cell size
ATP_START            = 55                // starting reserve; ~30 s of grace at intro size
ATP_PER_GLUCOSE      = 2                 // real anaerobic glycolysis stoichiometry — not a dial
ATP_PER_PEPTIDE_BOND = 4                 // §9.1, endergonic peptide-bond formation
ATP_DOT_SCALE        = 2                 // render only: 1 dot ≈ 2 ATP
health = clamp(ATP / 16, 0.2, 1)         // scales ooze amplitude & particle speed
```

### 13.3 Enzyme
```
ENZYME_BIND_TIME    = 1.12               // s per crack of ONE PARTICLE, one active site
  ⇒ turnover        = 0.893 glucose/s ⇒  7.14 ATP/s fed   (≈4× upkeep: real headroom, real ceiling)
LACTATE_PER_GLUCOSE = 2                  // CORRECTED from 1 — see below
K_ON                = 80                 // encounter rate; per PARTICLE concentration (§5d)
```
*Both of these were 0.28 and 20 in the molecule unit §5d retired. The ATP/s is unchanged — only the unit the rate is counted in moved. §5d.1 records the 4× bug that leaving one of them behind produced.*
**Stoichiometry correction.** §8.1 states `1 glucose → 2 ATP + 1 lactate`. Real anaerobic glycolysis is `1 glucose → 2 ATP + 2 lactate` (C₆ splits into two C₃ units). §1.3 makes native stoichiometry a signature feature, so the real ratio wins. Consequence to re-check when the intro is re-hosted: this **doubles the osmotic load per glucose**, so §12.3's swelling crisis arrives roughly twice as fast. That is probably an improvement in drama, but it is a pacing change, not a free correction.

### 13.4 Transport — permeabilities, not funnel strengths
On a real field, import is Fick (§6.2), so the primitive is a permeability, and §8.1's glucose trapping holds `c_in ≈ 0` so the working gradient is ≈ `c_out`. Derive `P` from the requirement that **one full-gradient transporter face feeds exactly one enzyme**:
```
P_CHANNEL_GLUCOSE = 3.57 / (13 tiles × 1.0) = 0.28   // tile⁻¹ s⁻¹ at unit gradient
P_BILAYER_DEFAULT = 1e-4                             // §4.2 — a sealed wall by default
P_BILAYER_GAS     = 0.9                              // O₂/CO₂ cross the bare bilayer freely (§6.2)
VMAX_CARRIER_LACTATE = 3.2, K_CARRIER = 55           // §6.4 saturating cap, from carrier_vs_channel
```
That derivation yields a legible design rule worth surfacing in-game: **one face feeds one enzyme.** A second enzyme needs a second face or a steeper gradient — which is §6.7's placement puzzle stated as arithmetic.

> **Tuning note, found while testing.** `VMAX / K = 3.2/55 = 0.058` means the lactate carrier saturates at a gradient of only 0.058, and internal lactate routinely runs an order of magnitude above that. So in practice **the carrier is pinned at Vmax essentially always**, and §6.4's "below the ceiling, delivered flux still scales with gradient" describes a band too narrow for a player to ever observe.
>
> That is fine for §6.4's headline lesson (a carrier is a *ceiling*, a channel is not) but it quietly erases §6.1's most counter-intuitive teaching point — that a passive transporter looks slow near equilibrium — for this particular transporter. If the carrier-vs-channel contrast is meant to *teach* saturation rather than merely have it, widen the proportional band by raising `VMAX` or lowering `K`, and re-check §12.3's deflation pacing after.

### 13.5 Diffusion — bounded by stability, tuned to legibility
Explicit 2D diffusion is stable only while `D·dt/h² ≤ 0.25` (§3.3). With `h = 1` tile:
```
SIM_HZ = 120  ⇒  SIM_DT = 1/120  ⇒  D_MAX = 0.25/SIM_DT = 30 tiles²/s   // hard ceiling, asserted in dev
D_GLUCOSE = 10, D_LACTATE = 12, D_AMINO = 8, D_ATP = 15, D_WATER = 20, D_O2 = 20, D_PROTEIN = 1
```
`D_GLUCOSE = 10` comes from §4.1's legibility requirement — a solute dropped at the membrane has ~15 tiles to cross, and spreading time is ≈ `L²/4D` = 225/40 ≈ **5.6 s**, slow enough to watch. Per-species `D` also drives §11.2's motion speed, so small molecules shimmer and proteins lumber for the same reason they do in reality.

### 13.6 Enzyme density, and the condition that makes belts worth building
Aggregate consumption `k` is not a free constant — it is `enzyme_density × turnover`. There are **two** ceilings on it, and the first draft of this section got the answer wrong by considering only one.

```
transit fails when  R_interior > L        L   = sqrt(2·D·c₀/k)      // §17.3
flux    fails when  R          > R_flux   R_f = 2·P/k               // 2D: perimeter vs area
```

Solving `L = R0` alone gave `k = 0.063` (≈18 enzymes per 1000 tiles). **The sweep falsified it immediately**: at that density the membrane cannot supply the interior at *any* size — every row read 100% starving and `Supply÷Demand` never rose above 1.09×. Flux binds long before transit does.

Worse, the two ceilings can arrive in either order, and the order decides whether §17.5's ladder has three tiers or two. Belts fix transit and do nothing for flux, so **belts are only ever useful in the window `L < R < R_flux`** — and that window exists only when:

```
k  <  2·P²/(D·c₀)  =  0.0151        // ≈ 4.2 enzymes per 1000 tiles
```

Above that threshold the cell hits the absolute flux ceiling before transit is ever its problem, cytoskeletal belts are strictly a waste of ATP, and §17.5 collapses to "grow, then divide". **This condition is the single most important number for making the escalation ladder real, and nothing in §17 states it.**

Adopted, comfortably inside the window:
```
enzyme_density = 0.00224   (~2.2 enzymes per 1000 tiles)
k              = 0.0080 glucose/tile/s
⇒ L       = 50.0 tiles     (transit knee)
⇒ R_flux  = 68.7 tiles     (absolute flux ceiling)
⇒ §4.1's intro cell at R_interior ≈ 16.8 sits at Supply÷Demand = 3.6× — safe on both counts, as it should be
```
The intro cell is *supposed* to be safe; §17 is about what happens when you grow past it. Measured results in §17.3.

### 13.7 Osmosis & volume (§7.4, re-expressed in tiles)
```
A_REST  = π·R0²  = 1000 tiles²
B_OSM / S_NOM    = 150/177 = 0.847     // the ratio is what sets resting volume; keep it
LP = 1.6, STIFF = 7, RUPTURE = 0.30    // dimensionless; RUPTURE dramatized from ~0.03 per §7.4
BLEB_TENSION_MIN = 0.55, BLEB_SHED_FRACTION = 0.55, BLEB_VOLUME_FACTOR = 0.80
```

### 13.8 Retired constants
`IMPORT_PULL`, `SUBSTRATE_ATTRACT`, and `TRANSPORTER_WINDOW` described how particles were *animated toward* a pore in the prototypes. On a real field there is no funnel — there is a permeability and a gradient, and the visible convergence of dots toward an import site is an emergent consequence rendered from flux (§11.2), not an input. `AMINO_POOL_CAP = 40` was a stand-in for the osmotic ceiling that §7 now provides for real.

---

## 14. Roadmap beyond the intro

Ordered roughly by natural progression. Each is grounded in mechanics the intro already establishes.

1. **Ribosome & automated protein synthesis** — retire hand-assembly; introduce the mRNA-copies production dial; consume the amino-acid stockpile.
2. ~~**Move to the real diffusion grid**~~ — **BUILT.** Replaced hand-tuned particle motion with a true scalar field + flux stencil, dots spawned from it. (The prototypes are costume-over-stub; this was the step that put the costume on the real sim. See §15, §11.3a, §11.3b.)
3. **Close the doom-spiral** — dilution feeds back into reaction rates (§10.3).
4. **Aerobic upgrade / mitochondria** — O₂ import via a lung-like membrane, 2→~30 ATP, lactate becomes fuel (§8.3).
5. **pH layer** — H⁺ as a species, pH as a global enzyme-efficiency multiplier, coupled-transport carriers that co-move protons (§6.4, §10.5).
6. **Cytoskeleton & motor transport** — intracellular belts/routing (§4.7); the spatial layer. Then the ER/Golgi assembler tier (§8.5) that feeds vesicles onto those roads.
7. ~~**Motility & chemotaxis**~~ — **BUILT.** Flagella, patchy depleting environment, gradient-following (§10A.5); the exploration axis and the seed of the nervous system. Note this arrived *before* items 3–6, out of the order below, because it needed nothing they provide — it is built entirely from §9.2's pipeline and the existing ATP field.
8. **Cell division** — the moving-boundary re-tiling (§3.6, §4.5); SA:V forces it (§4.6, §17).
9. **Multicellularity & the bloodstream** — driven by the corrected SA:V wall (§17): belts fix transit but not the r²-vs-r³ flux ceiling → cross the necrosis knee → flatten/wrinkle or divide → interior cells of the ball choke on trapped waste (the stall from the transport prototypes) → circulation as the ring-of-compartments main bus (§6.8), the in-game analog of angiogenesis; where swept-away lactate *goes* (liver → glucose; heart → fuel). This is the nomad→settler transition (§10A.4).
10. **Endocrine system = circuit network** — hormones as programmable signals; insulin/glucagon holding blood-glucose homeostasis; combinator-style controllers the player designs to hold bands automatically instead of hand-tuning.
11. **Nervous system** — the chemotaxis sense→decide→actuate loop (§10A.3) industrialized: sensing, signaling, coordinated actuation across a multicellular body.
12. **Immune system** — innate (always-on turrets) + adaptive (reactive "research," memory cells = permanent unlock, vaccination = pre-research); autoimmunity (friendly fire); cancer (§10.7).
13. **Reproduction endgame** — build a gamete; seed the next run; evolutionary meta-progression tech tree carrying adaptations forward (§1.3).

---

## 15. Implementation & tooling

### 15.1 Decisions
**TypeScript**, strict, npm workspaces. **Canvas2D** for the renderer. **2D permanently** — §7.4 already treats area as the volume proxy, all nine prototypes are 2D, and the fractal zoom reads better flat. The consequence for §17.3 is recorded there.

### 15.2 Layout
The process boundary of §3.7 is enforced by the dependency graph, not by convention: `sim` has no network and no DOM, so nothing downstream can smuggle state back into it.
```
protocell/
  prototypes/          ← the nine .html files, untouched, as reference (§18)
  packages/
    sim/               ← pure TS. no DOM, no net, no I/O. vitest lives here.
    protocol/          ← message types + binary codec. shared by server and client.
  apps/
    server/            ← node + ws. owns the clock, hosts a sim instance.
    client/            ← vite + canvas2d. renders, sends commands, holds no truth.
  scripts/
    sweep.ts           ← headless §17 re-measurement; imports packages/sim directly
```

### 15.3 The wire protocol
Client → server, JSON text, low volume. Commands are the only way a client affects the sim:
```ts
type ClientMsg =
  | { t: 'subscribe'; view: { x, y, w, h, lod: number, species: SpeciesId[] } }
  | { t: 'command';   cmd: Command }   // place transporter on tile, bleb, build enzyme
  | { t: 'control';   op: 'pause'|'resume'|'step'|'speed'; value?: number }
```
Server → client, binary frames for fields. Self-describing, so a frame needs no side channel to interpret:
```
0   4   magic 'PCFF'
4   4   uint32  tick
8   2   uint16  lod
10  2   uint16  speciesCount
12  2   uint16  width            (post-downsample)
14  2   uint16  height
16  2   uint16  originX          (world tiles)
18  2   uint16  originY
20  n*2 uint16  speciesIds[]     → pad to 4-byte alignment
..      Float32Array[speciesCount * width * height]
```
Scalars and discrete events stay JSON — `{t:'scalars', tick, atp, tension, volume}`, `{t:'event', kind:'lysed'|'folded', tick}` — small enough that devtools readability beats the bytes.

**Downsampling**: for `lod = 2^k`, box-average `k×k` blocks. Mean is the correct reducer because the payload is *concentration* and tile volume is fixed per resolution — §3.5's "each cell coarsens toward a single averaged tile." Averaging *amounts* instead would be wrong the moment tile volumes differ.

**Rates**: the server ticks at `SIM_HZ` (§13.5) and sends at a separate `SEND_HZ` (default 30) — §3.4's decoupling, now literally across a socket. The client keeps the two most recent frames and interpolates on the tick numbers in their headers.

**Backpressure**: if a socket's buffered amount exceeds a threshold, drop that tick's frame for that client rather than queueing. A slow client must never stall the simulation.

### 15.4 Float64 in the sim, Float32 on the wire
The truth layer stores amounts as **Float64**; the wire quantizes to Float32 at serialization. This was measured, not assumed: with Float32 fields, mass conservation caps out at **~2e-6 relative drift over 10k steps** — the read-modify-write rounds on every tile every step and it compounds. That is invisible in a demo and corrosive in a simulation meant to run for hours whose first principle is that numbers are truth. With Float64 the same test conserves to **better than 1e-12**.

The general rule this is an instance of: **the truth layer is exact to the practical limit; the costume is what gets quantized.** Lossiness belongs on the render side of the §3.7 boundary, where it is both harmless and free.

### 15.5 Constants discipline
One `packages/sim/src/constants.ts`, matching §13 exactly, every value carrying its derivation as a comment. §13 has demanded this from the start; the prototypes all violate it, which is why they drifted into three incompatible economies.

### 15.6 Many cells on one server

The server hosts a `Game` per cell — world, clock, clients, event queue — and a registry
decides which of them tick. Every one of those was a module-level global while there was
one game, which is why there could only be one.

**Ticking is the cost.** Measured: 0.46 ms/step, so 55 ms of CPU per wall-second per live
cell — **5.5% of one core**, ~18 per core saturated, ~48 on a 4-vCPU box.

That collides with §2.3, which makes it a principle that the sim runs whether or not
anyone watches. Honoured literally, cost scales with **total signups rather than active
players**. So a cell can be frozen — it keeps every byte and stops being stepped — and
three tiers fall out:

```
live    ticking, in RAM      bounded by CPU   MAX_LIVE_GAMES
warm    in RAM, not ticking  bounded by RAM   MAX_RESIDENT_GAMES
cold    in the store only    unbounded
```

The LRU only ever freezes an **unattached** cell, so §2.3 survives for anyone actually
playing: close the tab, come back in ten minutes, and your cell has been living without
you. What is given up is the cell of someone who has not played for a week.

**Catch-up on reconnect does not work**, and the arithmetic is the same arithmetic:
replaying a gap costs the same 5.5% of a core per second of absence, so ten minutes is
33 s of compute and an hour is 3.3 minutes. A frozen cell resumes where it stopped and
`hello` carries `frozenSeconds`, because resuming silently would read as lost time.

### 15.7 One cell per account

Google sign-in, Authorization Code flow, server-side: the browser carries only an opaque
code and the ID token is fetched by the server directly from Google over TLS.

**The whole authorisation model is one line** — the cell id is `u:<google-sub>`, *derived*
rather than stored. No mapping row to fall out of step, and no way for two accounts to
reach one cell. A `?game=` parameter is **ignored** for a signed-in player rather than
merged; honouring it would let anyone open anyone else's cell by naming it.

Sessions are a signed cookie (HMAC-SHA256, constant-time compare), not a session table:
the payload is a stable subject id, and a row to look up a value we already hold buys
nothing. Unauthenticated upgrades are refused at the handshake, because a socket that
connects and can do nothing is indistinguishable from a server that is down.

Not configured is a supported state: without `GOOGLE_CLIENT_ID` the server is anonymous
and unchanged, so local development needs no OAuth setup.

### 15.8 A save is a snapshot, not a replay

§3.7 records that a seeded PRNG plus a command log gives "exact replay for free". True,
and for the wrong problem: **replay is O(playtime)**, so at §15.6's cost a two-hour save
takes six minutes of CPU to open. Fine for reproducing a bug offline, useless as a load
screen.

`World.snapshot()` omits all geometry — grid, role and compartment maps, neighbour tables,
the nucleus, patch positions — because it is a pure function of construction and never
changes. Patches carry `richness` only. Planes are emitted only when non-empty: 2 of 13
are live, since §5c made ATP a pool and §5b made residues an inventory.

The test is **divergence**, not plausibility: restore into a fresh world, step both 3,600
ticks, demand bit-identical. A forgotten accumulator is invisible for one step and
compounds forever, so "the numbers look right" is not evidence.

### 15.9 Storage

A cell is an opaque blob keyed by its id — no queries, no joins, no search — so this is a
key-value store rather than a database. Metrics come from extracting saves into a
warehouse, not from making the hot path carry a schema.

```
31 KB gzipped per cell, 3 ms to produce
10,000 cells = 305 MB, under a cent a month
```

**Bytes are free and requests are not**, and that sets the policy: save on transitions —
disconnect, freeze, shutdown — with a slow autosave as crash insurance only, and never
rewrite a cell that has not stepped. Writing every live cell every minute would cost ~$60
a month in requests alone.

Two failure modes worth naming, because both are silent:

- The file store writes, **fsyncs, then renames**. Rename is atomic but only publishes
  bytes that are on disk; without the fsync a crash leaves a correctly-named zero-length
  save that has replaced a good one.
- A failed load **refuses the connection** rather than handing over a blank cell. An empty
  world would be overwritten by the next autosave, turning a transient storage fault into
  permanent data loss.

### 15.10 Deploying

One container serves the sim and the built client from **one origin**, which removes CORS
entirely, lets the session cookie work with plain `SameSite=Lax`, and collapses
`PUBLIC_ORIGIN`, `APP_ORIGIN` and the OAuth redirect host into one value that cannot
disagree with itself.

On Cloud Run, four flags are load-bearing and three of them are the difference between
working and *appearing* to work:

| flag | consequence of omitting it |
|---|---|
| `--no-cpu-throttling` | CPU is granted only during a request, so the cell silently freezes when the tab closes — §2.3 defeated, with no symptom but a number that did not move |
| `--max-instances 1` | A cell lives in RAM in one process; a second instance opens a second copy of the same cell and both write the same object. Corrupts rather than degrades |
| `--min-instances 1` | Scale-to-zero discards every resident cell |
| `--timeout 3600` | Sets how often the socket is cut, not whether it works — the client reconnects and resumes |

**This does not scale horizontally**, and that is a property of a stateful simulation
rather than an oversight. Growing past one machine means sharding players by subject, not
adding replicas.

---

## 16. Verification & known defects

### 16.1 The test suite
Headless vitest over `packages/sim`. The payoff of §3.7's process boundary is that none of this needs a browser:

- **Conservation** — diffusion alone holds total mass constant to 1e-9 over 10k steps.
- **Equilibrium** — two compartments joined by a channel converge to equal concentration and net flux reaches exactly zero (§6.1 — the test `cell_prototype` fails).
- **Reversal** — flux changes sign when the gradient flips.
- **Timestep independence** — identical scenario at 30 Hz and 240 Hz send rates yields bit-identical field state. The direct regression test for the §17.2 defect.
- **Determinism** — same seed and command log ⇒ identical field hash at tick N.
- **Stability** — no NaN or overshoot at maximum allowed `dt`; the CFL assert (§13.5) fires when deliberately exceeded.
- **Area preservation** — enclosed area of `memR(θ)` varies < 0.5% over a full cycle (§11.5).
- **Protocol** — encode → decode round-trips exactly; downsampling preserves the mean.
- **Detachment** — a sim with zero clients advances normally; connect, disconnect, and reconnect mid-run perturbs no state.
- **Penetration depth** — `L` matches `sqrt(2·D·c₀/k)` and is independent of `R` (§17.3's central claim), and the knee lands near `R_interior = 17.8` as §13.6 predicts.
- **Membrane gates** (§4.2a) — `gateTiles` is a strict, substantial subset of the ring; every gate tile has fluid on both sides and can host a flagellum; deploying *either* a transporter or a flagellum onto buried wall is refused rather than silently accepted; and `faceTiles` never returns dead wall, including for a face wide enough to reach the diagonal shoulders. The last one matters because the narrow cardinal faces §12 uses do not reach them, so the ordinary case cannot detect the bug.

- **Discrete matter** (§5a) — the random walk reproduces the same `D` the field uses (4,000 walkers against `⟨r²⟩ = 4Dt`); grains reflect off the boundary rather than piling on it; minting carries its remainder and taking splits the last grain, so quantising conserves; discrete species have NO interior field, so there is exactly one representation; grains are osmotically active; and §12's whole arc still runs on them.
- **Catchability** (§5a.8) — a residue bead drifts far slower than the nanobot walks, and the bot can actually walk to one and collect it. Glucose and lactate are asserted NOT slowed, because their `D` is §17's penetration depth and slowing it would blunt the SA:V wall.
- **The residue economy BALANCES** (§9.4, §10A.8) — every deposit regrows faster than the cell consumes that residue; a deposit refills in 300–900 s, so it is neither a tap nor a one-shot; one port can clear a deposit inside a single visit, so the regrowth is actually reachable; the map holds more than 4× a build-out; and staying put still loses, because one deposit serves one of the five types the cell is spending. See §16.5 for why this class of test did not exist before.
- **Repair and stranding** (§9.5a, §9.5b) — a covered cell loses no protein at all and spends no time without a flagellum; a renewal restores the protein in place rather than installing a second copy; a dead protein outranks a tired one; a central ribosome is asserted NOT to cover the membrane, since that is the siting decision the whole mechanic is about; and `stranded` fires only when no flagellum exists, none is coming, and none can be folded — never while one is merely worn.

**The suite runs in two passes.** `npm test` runs the sim/protocol/client suites in parallel, then the socket suite alone. The wire tests drive a real server ticking at 120 Hz in *wall-clock* time and assert things like "the nanobot reaches the nucleus within 20 s", so keeping compute-bound workers off its back is worth doing regardless.

**Correction — the diagnosis that motivated the split was wrong, and the real defect was better.** CPU starvation was blamed for intermittent wire failures ("10/10 alone, failures inside the full run"). The actual cause was a **race in the harness**: `connect()` resolved on `open` and the caller attached its `message` listener afterwards, so the `hello` sent the instant the server accepts was emitted with nobody listening and dropped — and the test then waited 25 s for a message that had already been and gone. Load only widened the window. Fixed by attaching the listener synchronously inside `connect()` and queueing what arrives before a test asks for it.

> **"It only fails under load" is a symptom, not a cause.** Accepting it as one buys a plausible story in place of a fix — and this codebase has now paid for that mistake twice, here and at §17.2, where a number that depended on the monitor's refresh rate was taken as physics.

#### 16.1a Two defects in the verification itself

A test suite reported success while an entire file had stopped running. §16 is worth nothing if the way results are read is itself unsound.

- **A crashed worker is not a skipped test.** A file exhausted its worker's heap; vitest dropped all 12 of its tests and printed `Test Files 8 passed (9)` / `Tests 122 passed (134)`. That is a failure, and it reads as success because the eye goes to `122 passed` and not to `(9)`. **Read the file count.**
- **The exit code was never being read.** Runs were invoked as `npm test | grep … | head`, and a pipeline exits with the status of its *last* command — so vitest's non-zero status was replaced by `head`'s zero on every run, including one taken alongside six genuinely failing tests. **Never pipe a test run you intend to trust.**

Both share a shape with §17.2 and §11.3b: **the apparatus was reporting something other than what it appeared to report.**

A related trap, from the same period: a wire test for transporter placement chose the *farthest* membrane tile — which is buried wall (§4.2a) — and asserted seating a carrier there succeeded. It did succeed, and the carrier then transported nothing. **The test encoded the bug and passed.** Coverage of a path is not coverage of its correctness.

#### 16.1b The §17 sweep is STALE — the wall is argued, not measured

`scripts/sweep.ts` still assumes the concentration model: it measures penetration depth from a diffusion field and a per-tile consumption rate, neither of which the simulation runs any more. **§17's figures should be read as historical until it is rewritten against particles.**

The argument that the wall survives is that glucose particles random-walk at their tabulated `D`, so the distance one covers before an enzyme eats it is the same quantity `L` was. That is reasoning — and §17.2 is this document's own warning about trusting a number whose apparatus has changed underneath it.

### 16.2 What the prototypes actually validate
The prototypes are persuasive and the design conclusions drawn from them hold. But most are **costume without a truth layer underneath**, and the table below is the honest accounting — it exists so that a claim in this document is never mistaken for a demonstrated result.

The central inversion: §2.1 requires that particles be spawned *from* a field and that the field never be inferred from particle counts. Five of nine prototypes do the opposite — `concIn() { return lacIn.length / VOL }` makes the particle array the state and concentration a read-out.

| Prototype | Validated | Aspirational / defective |
|---|---|---|
| `cell_prototype` | Area-preserving ooze (verified: constant +0.17% offset, time-invariant — better than §11.5 claims); per-species motion character; stillness = death | **No concentration variable exists at all.** Its "channel" gates on geometry with no gradient term and interior particles are clamped in, so it can never reflux — by §6.1's own test that is a free **pump**, not a channel. Zone tints are hardcoded and do not track the depletion actually happening. `alive` is a button, not ATP. |
| `enzyme_build` | The §9.2 pipeline end to end: bill of materials, per-bond ATP spend, fold, then catalysis with one active site | Pool ships with a surplus, so the blocking case (§9.2 step 2) never fires |
| `lactate_export` | Two genuinely finite compartments; the stall is a real thermodynamic consequence of the gradient flattening, not scripted | Flux has no magnitude — crossing is full-speed until a boolean flips, so §6.1's "looks slow near equilibrium" is exactly what it fails to show. The carrier has **no Vmax**, so §6.4's saturation is unvalidated. Circulation clears only half the space (a missing `&& !circ` guard pins particles at the wall). The two region tints use different scale factors for the same species, so at true equilibrium the inside renders 40% greener than the outside. |
| `carrier_vs_channel` | **The reference implementation.** The only §2.1-compliant prototype: flux is computed from the field, then a `flux` accumulator spawns particles to match. Correct saturating carrier vs. uncapped symmetric channel, honest reflux, and the fixed circulation-removal logic. | — |
| `full_cell` | The complete osmosis → swelling → tension → lysis dynamic; genuine coupled volume model; the four-act intro arc | Not tile-based — an analytic circle with angular transporter windows, so §4.1's geometry and §4.2's membrane-as-gate are untested |
| `cytoskeleton_belts` | Motors, ATP cost per step (loaded > empty), delivery raising local concentration at the drop point | The track is **hardcoded** and the build button costs nothing, so §4.7's central claim — that *where you run the track* is a routing decision — is the one part never tested. Diminishing returns come from the import throttle, not the enzyme's active site as §4.7 states. |
| `motility_chemotaxis` | A real grid field for glucose; the sense→decide→actuate loop genuinely closed over it | Toxin field is static and never diffuses; no source term; the grid's border ring is never updated and so acts as an infinite source. Swim speed is hardcoded every frame, so §10A.1's "swimming competes with construction" tension is not modeled. No fail state. |
| `sav_wall` | Superseded. Kept for the wrinkle/divide UI only | Membrane is an infinite fixed-concentration source (`nn[i] = N0` every substep), so it models only the *transit* limit — and it contains the absorbing-sink boundary bug §17.2 warns about, masked by the infinite source |
| `belts_vs_sav` | The corrected SA:V model: finite per-tile import, zero-order consumption, reflecting boundary. Belts fix transit but never `Supply÷Demand`; streaming socializes the famine | Diffusion is not `dt`-scaled (§17.2), so all measured numbers are display-dependent |

**Three incompatible ATP economies** run across these files — flat 1.8/s (`full_cell`), flat 1.5/s (`cytoskeleton_belts`), and per-tile 0.06 with a belt-cost term (`belts_vs_sav`). This is the concrete reason §13 is re-derived from scratch rather than adopted from any one prototype.

### 16.3 Corrections this document absorbed

Findings from implementation that changed a number or a model this document had stated with confidence. Each is now written into the section that owns it; they are listed here so the *class* of error stays visible.

- **ATP must not be osmotically active** (§7.4). A running enzyme drove the pool from 106 to 302 in two minutes and *that*, not the lactate, inflated the cell — turning §12.3's waste crisis into an energy crisis. Real adenine nucleotides are conserved, so the count is a constant and belongs in `B_OSM`.
- **Respiratory control cannot be modelled yet.** Stalling a full enzyme is correct biology, but it stops glucose being consumed, so internal glucose climbs toward the external concentration — and glucose is osmotically active. That inverts §7.2's negative feedback into a positive one and the cell lyses. §8.1's "glycolysis traps glucose the instant it enters" turns out to be load-bearing rather than flavour.
- **The ATP ceiling must be compartment-level, not per-tile.** A per-tile clamp saw an enzyme's whole deposit as a spike and destroyed ~87% of it, silently cutting yield to about 0.25 ATP per glucose while every number looked plausible.
- **In 2D the extracellular medium must be a boundary condition, not state.** Exported lactate builds a boundary layer that flattens its own gradient — measured 0.044 inside against 0.041 outside, so the driving gradient was 0.003 against a bulk-to-bulk 0.145. This cannot be fixed by widening the medium: steady-state 2D diffusion from a point source falls off as `ln(r)` and never converges, where 3D gives `Q/(4πDR)`. **A 2D cell in still water genuinely cannot shed waste.** Setting clearance to zero recovers the stall deliberately, and *is* the argument for circulation (§6.8, §17.7) made mechanical.
- **A waste-export face should be wider than an import face.** An import face points at something; waste points at nothing. A narrow export face drew so hard its inner neighbours sat at 2–8% of bulk, starving the carrier of its own substrate.
- **Permeability is per TRANSPORTER, not per membrane tile** (§13.4). Derived as "one 13-tile face feeds one enzyme", it meant a hand-built channel delivered a thirteenth of an enzyme's appetite and the intro deadlocked. `P` is now "one channel feeds one enzyme", which is also the biologically honest reading.
- **Membrane upkeep is billed to the cytoplasm** (§13.2), because §4.2 gives a membrane tile no pool to pay from — which is also where a real cell's membrane energy comes from.
- **The client drew the membrane in the wrong place**, reconstructing the ring from the *osmotic* radius √(volume/π) while the tiles sit at the fixed geometric radius. Clicks meant to seat a transporter landed on cytoplasm. The server now sends the tile list rather than letting it be inferred — precisely the failure §2.1 exists to prevent.
- **§12.3's build order is wrong for the physics.** It lists the amino-acid transporter before the lactate carrier, which reads sensibly and plays badly: lactate accumulates the entire time you build anything else, and the cell lysed mid-build. The carrier is urgent; the supply line is merely important.

### 16.4 The intro, as it actually plays

Verified end to end over a live socket (`npm run play-intro`), every protein hand-assembled by the nanobot with no free builds: the death clock, the discovery that raw glucose is not energy, the turn as the enzyme lands, the waste crisis arriving unprompted, and a recovery that costs something. No lysis.

### 16.5 Every test asserted that a mechanism WORKS; none asserted the numbers BALANCE

The defect behind §10A.8 was pure arithmetic and the suite could not see it. Tests covered that a port imports, a deposit depletes, a ribosome rebuilds, residues are whole counts — every mechanism on the path passed while **the world held less amino acid than a single build-out costs**.

That is a gap in kind, not in coverage. A mechanism test asks *does this do the thing*; it cannot ask *is there enough*, because "enough" is a relationship between two subsystems written months apart, and the two numbers never met in any single file.

**Where this recurs:** anywhere a *stock* authored by one system is drawn down by a *rate* authored by another. Live pairs: residues (deposits ↔ denaturation), glucose (pockets ↔ enzyme turnover), ATP (pool ↔ upkeep + swimming + bonds), membrane tiles (the ring ↔ what wants to sit in it). **Only the first has a balance test.**

> **A constant that carries its derivation still needs a test that the derivation is still true.** Comments record what was balanced against what at the time of writing; only an assertion notices when the other side moves.

### 16.6 Three defects only a real deployment could show

None of these were reachable from the test suite, and each was found by reading logs from
a running service rather than by reasoning about the code.

- **A 300x write amplification.** The autosave sliced the live set — "save
  `ceil(live / AUTOSAVE_S)` cells per second" — which is correct for hundreds of cells and
  degenerates for one: `ceil(1/300)` is 1, so a single cell was written every second
  instead of every five minutes. 3,600 writes an hour against 12. It surfaced only because
  GCS rate-limits writes to one object at ~1/s and returned 429; without that it would
  have been a silent bill. Each cell now carries its own due time.

  > A rate expressed as *work per tick* is not a rate per item. It degrades toward
  > "everything, constantly" exactly when the population is small — which is the case every
  > deployment starts in.

- **`/healthz` never reached the container.** Cloud Run's frontend intercepts that exact
  path and serves its own 404. Verified against the deployed service: `/healthz` 404s from
  Google while `/healthz2`, `/_health` and an arbitrary path all arrive.

- **An unreachable cell ticking forever.** With sign-in on, every cell is `u:<sub>`, so the
  anonymous default was created at boot and could never be visited — 5.5% of a core spent
  on a cell that had already starved to `ATP=0`.

### 16.7 Current state — tick 100,000

First sustained-survival run: **tick 100,000 = 13 min 53 s**, alive, hand-driven. Acceptance evidence for §9.4, §9.5, §10A.8 and §10A.9 *together*, which matters because each was previously observed to fix a symptom the next one re-broke.

```
ATP        500 / 502   pinned at the ceiling — energy in surplus
volume    1137         ⇒ stretch 0.066 ⇒ tension 0.221, well under STRESS_ONSET 0.6
residues   264 → 367   net +103 AFTER paying for every build and replacement
```

Materials and energy both in surplus, decay running at its baseline clock, neither stress input engaged. **A plateau, not a slope** — and that distinction is the point: a cell that lives fourteen minutes may still be losing half a protein a minute. Survival time is not the measurement; the trend in standing stock is.

Two things to watch: **glycine is the only net-negative residue** and also the most-demanded (27% of the bill), so it binds first if anything does; and leucine ran to 123 against valine's 52, a spread the seeker is supposed to flatten. Not diagnosed.

## 17. The multicellular transition (the SA:V wall)

**The push to multicellular is not "diffusion is too slow" — that is the symptom. The wall is the surface-area-to-volume ratio, and it is the most important forcing function in the design.** This section was materially corrected during prototyping (`belts_vs_sav.html`); the model below is the validated one and supersedes the earlier `sav_wall.html` sketch.

### 17.1 Two distinct bottlenecks (get this right — the earlier sketch conflated them)
As a cell grows there are **two separate limits**, stacked, and they have different fixes:

1. **Transit** — getting nutrient from the membrane to the deep interior before it is consumed en route. This is a *distribution* problem. **Cytoskeletal streaming / motor transport (§4.7) fully solves it** (real biology: giant cells use cytoplasmic streaming for exactly this).
2. **Boundary flux** — the *total* amount that can cross the membrane per second, capped by `transporter_density × membrane_area`. **Belts do nothing for this.** Surface grows as r² (2D: perimeter as r), interior demand as r³ (2D: area as r²). No amount of interior logistics changes how much can enter through the skin.

So belts raise the size ceiling but do not remove it. **The r²-vs-r³ intake ceiling is absolute.**

### 17.2 The finite-flux model (implementable — this is what the prototype runs)
Reaction–diffusion of a nutrient field on the grid (§3), one value per tile:
```
membrane tiles:   FINITE influx    nut += IMPORT_PER_MEM * dt      (NOT a fixed clamp — a rate; supply ∝ surface)
interior tiles:   consumption      nut -= CONSUME * dt             (roughly constant / zero-order: saturated enzymes run flat-out)
all cell tiles:   diffusion        standard 5-point Laplacian
outside the cell: REFLECTING no-flux boundary (a tile facing "outside" mirrors its own value — nothing leaks out)
```
**Critical bug to avoid (it cost a rebuild):** do NOT set outside tiles to zero and let membrane tiles diffuse into them — that makes the void an infinite absorbing sink, the membrane can never hold concentration, and the whole cell reads as 100% starving from frame one. The membrane is a *barrier*; use a reflecting boundary.

Prototype constants: `IMPORT_PER_MEM = 1.8`, `CONSUME = 0.30`, `DIFF = 0.19`, 4 substeps, starve threshold `0.16`, cap `1.2`. Streaming = periodically pull all interior tiles toward their mean (fast homogenizing mixing). Belt running cost ∝ `mass × radius` (transport work grows faster than r²).

> ⚠️ **These constants are not physical, and every number measured from them is provisional.** In `belts_vs_sav.html:102` the diffusion term is applied **per frame with no `dt`**, while consumption on the next line *is* `dt`-scaled. Diffusive transport therefore runs at the display's refresh rate while consumption runs in real time, so the ratio that sets penetration depth — and thus every quantitative result in §17.3 and §17.4 — varies with the monitor it was measured on (roughly **2.4× deeper at 144 Hz than at 60 Hz**). `sav_wall.html:124` has the identical defect.
>
> **Resolved.** `scripts/sweep.ts` has re-measured all of it on the fixed-timestep grid, and §17.3 and §17.4 now carry the corrected numbers. Every qualitative finding survived — flat floor, sharp knee, power-law takeoff, no stable middle, streaming socializing the famine — and two got sharper. The prototype's constants above are kept only as a record of what was run; do not reuse them.

### 17.3 The penetration depth and the sharp threshold
Because consumption is roughly **zero-order** (constant, not proportional to concentration), the steady-state profile falls *parabolically* from the membrane and reaches **exactly zero at a finite depth** — a genuine front, unlike the never-quite-zero asymptote of first-order decay. The penetration depth:
```
L ≈ sqrt(2 · D · c₀ / k)      — and crucially, L does NOT depend on cell size R
```
The healthy shell is therefore a **fixed thickness**. Consequence, measured in the sweep:

| interior radius vs L | starving fraction |
|---|---|
| R_interior < L | **exactly 0%** (cell is all shell) |
| R_interior > L | dead core appears and **accelerates**: dead volume ∝ (R_interior − L)ᵈ |

**Measured on the fixed-timestep grid** by `scripts/sweep.ts`, with the §13.6 constants (`D = 10`, `P = 0.2747`, `k = 0.0080`, starve threshold 0.16, 400 s settle). These numbers supersede the provisional ones:

| R_interior | membrane tiles | interior tiles | Supply÷Demand | starving | starving *with belts* |
|---|---|---|---|---|---|
| 17 | 108 | 912 | 3.64× | **0.0%** | 0.0% |
| 29 | 184 | 2 644 | 2.23× | **0.0%** | 0.0% |
| 44 | 284 | 6 092 | 1.53× | 69.1% | **0.0%** |
| 51 | 308 | 8 184 | 1.25× | 72.2% | 100% |
| 57 | 364 | 10 216 | 1.18× | 82.2% | 100% |
| 64 | 372 | 12 892 | **0.96×** | 79.5% | 100% |
| 71 | 436 | 15 856 | 0.92× | 86.1% | 100% |
| 84 | 532 | 22 172 | 0.80× | 90.5% | 100% |

Every qualitative claim survives the correction, and two sharpen:

- **The floor is genuinely flat, then the knee is violent.** 0%, 0%, then 69% — not a slide. There is **no stable "slightly too big"**: once you cross, necrosis runs away, so you cannot tolerate a little core death and carry on. That is what makes it a forcing function rather than a soft penalty.
- **The two bottlenecks are visibly distinct** (§17.1). At `R_interior = 44` supply is still ample at 1.53× and yet 69% of the cell is starving — a pure *transit* failure, and belts erase it completely (69.1% → 0.0%). By `R_interior = 64` supply itself has fallen below demand and nothing internal can help.

The game is 2D permanently (§15.1), so the takeoff we ship is the quadratic one. A real 3D cell's is cubic and considerably more violent — if the 2D knee ever proves too forgiving to read as a wall, the honest fix is to steepen consumption, not to fake a cubic in a square world.

The game is 2D permanently (§15.1), so the takeoff we ship is the quadratic one. Worth knowing that a real 3D cell's is cubic and considerably more violent — if the 2D knee ever proves too forgiving to read as a wall, the honest fix is to steepen consumption, not to fake a cubic in a square world.

### 17.4 The triage-vs-socialize tradeoff (emergent, not scripted)
A surprise from the corrected model, worth exposing as a mechanic: at large size, **belts can make starvation WORSE**, not better.
- **Diffusion alone triages**: it sacrifices the core to keep the rim fully fed, so a functional periphery survives.
- **Streaming socializes the shortage**: perfect mixing gives everyone an equal, insufficient share, so the whole cell browns out together and *more* of it falls below the starve threshold.

**Re-measured, the effect is far starker than the prototype suggested.** The old figure was ~54% diffusion vs ~64% belts; on the corrected grid the crossover is total:

| R_interior | diffusion alone | with streaming | |
|---|---|---|---|
| 44 | 69.1% | **0.0%** | belts save the cell outright |
| 51 | 72.2% | **100%** | belts kill it outright |
| 84 | 90.5% | 100% | |

At `R_interior = 51` the switch flips from "belts are the difference between a dead core and a healthy cell" to "belts are the difference between a working periphery and total brownout" — over a **7-tile** change in radius. Diffusion's triage keeps a functional rim alive; streaming's equal shares put *everyone* below the line at once. So intracellular distribution strategy is a real and sharply-timed choice, and running belts past the crossover is actively lethal rather than merely wasteful.

So intracellular distribution strategy is a real choice — keep a healthy edge and let the middle die, or share equally and fail uniformly.

### 17.5 The three-tier escalation ladder (replaces "grow until you die, then divide")
1. **Diffusion** — free, fine while small (R_interior < L). Measured: 0% starving through R_interior = 29.
2. **Cytoskeletal belts (§4.7)** — cost ATP; fix *transit*, buying a real size window; **mandatory for long/thin geometry** (this is how every real giant cell survives — neurons, *Caulerpa*, *Chara* — all thin/tubular/branched, never big spheres, so every interior point stays near a surface). Measured: at R_interior = 44 they take the cell from 69% starving to 0%.
3. **Change shape or divide** — because the flux ceiling is absolute and belts eventually *hurt* (17.4), past the wall you must either **flatten/wrinkle** (microvilli, brush border, flat cells) to pack surface, or **divide** into more small cells that each keep a healthy SA:V.

> **Tier 2 only exists if the constants allow it.** Belts fix transit and do nothing for flux, so they help only in the window `L < R < R_flux`. That window is non-empty only when `k < 2·P²/(D·c₀)` (§13.6). Tune consumption above that threshold and the cell hits its absolute flux ceiling before transit ever becomes the problem — belts become strictly a waste of ATP and this ladder silently collapses to two rungs. Any future change to `D`, `P`, or enzyme density has to be re-checked against that inequality.

### 17.6 Design consequences to bake in
- **The cliff is telegraphed, so it's fair.** The `Supply ÷ Demand` gauge falls *smoothly and continuously* (e.g. 1.69 → 1.31 → 0.96) while starvation is still pinned at 0%. Smooth predictable warning, dramatic sudden consequence — expose S/D as the readable early-warning meter.
- **A natural unit cell size falls out for free.** The optimum sits just under the knee. This reproduces a real biological fact — cells across nearly all organisms cluster in a narrow size range; an elephant's cells aren't bigger than a mouse's, there are just more of them. The game teaches this without stating it.
- **Make necrosis permanent (recommended mechanic).** Dead tissue should NOT revive when the cell shrinks. Then the smooth S/D warning genuinely matters and "I grew too fast" is a scarring decision, not a reversible dip.

### 17.7 The forced chain to circulation (updated)
```
cell grows
  → transit lag → build BELTS (fix distribution; also enables thin/tubular giant-cell geometry)
    → but boundary-flux ceiling (r² vs r³) is absolute, and belts eventually socialize the famine
      → cross the SA:V knee → necrosis takes off (no stable middle)
        → escape: FLATTEN/WRINKLE (buy time as one cell)  OR  DIVIDE into a ball of cells
          → interior cells of the ball now choke on their neighbors' exhaust (the extracellular stall from `lactate_export.html`)
            → build CIRCULATION to pipe supply to the core and haul waste away
              → you are now an organism
```
Every link is forced by the previous link's failure; none is an unlock the player buys. **Real-biology anchor:** this is the tumor necrotic-core limit — solid tumors grow to ~1–2 mm then develop dead centers and must trigger **angiogenesis** (recruit blood vessels) to grow further. Same reason flatworms are flat and insects are threaded with tracheal tubes. **In-game, circulation IS angiogenesis**, driven by the same cliff.

### 17.8 How the three spatial systems reinforce each other
- **Cytoskeleton (§4.7)** makes the *inside* of a cell spatial (routing) — and is tier 2 of the ladder above.
- **Motility (§10A)** makes the *outside* spatial (foraging/patches).
- **The SA:V wall (this section)** forces the jump from "one spatial cell" to "many cells needing a spatial transport network (circulation) between them."

Together they carry the spatial/arranging gameplay from intracellular layout → environmental navigation → inter-cellular logistics, i.e., across all of the fractal zoom levels.



## 18. Prototype reference

Nine self-contained browser prototypes (vanilla HTML5 canvas, no dependencies) validate the feel and encode the exact mechanics/constants above. Most are **costume-over-hand-tuned-stub** (motion choreographed for feel), but the osmosis/volume model in `full_cell` and the reaction-diffusion in `motility_chemotaxis`, `sav_wall`, and especially `belts_vs_sav` are **genuine dynamics on a real grid** and are the reference for §3's simulation core.

**Read §16.2 alongside this table.** The descriptions below say what each prototype *demonstrates to a viewer*; §16.2 says what it *actually implements*, and the two diverge in several places — most importantly for `cell_prototype` (its channel is a free pump, not a passive channel) and `lactate_export` (its carrier has no Vmax). `carrier_vs_channel` is the reference implementation for both transport law and the §2.1 field→particle pattern.

| Prototype | Demonstrates |
|---|---|
| `cell_prototype.html` | The single cell as workspace: oozing area-preserving membrane (verified exactly — §16.2), per-type motion, alive=motion / stillness=death (Cut-ATP button), two extracellular concentration zones, nucleus, nanobot. *Its "density=concentration" and "channel importing down-gradient" are costume only — there is no concentration variable in the file and the channel cannot reflux (§16.2).* |
| `enzyme_build.html` | Full protein-construction pipeline: blueprint sequence, nanobot pulling typed amino acids from the pool, prominent ATP counter dropping ~4/bond, folding into a pocket, then the enzyme running (one active site, catalyst) cracking glucose → 2 ATP + lactate, with ATP and lactate as **persistent accumulating species** (bright ATP cloud, green-tinting lactate). |
| `lactate_export.html` | Facilitated carrier exporting lactate **for free down its gradient**; the small extracellular space filling and **stalling** export (gradient flattens) — the stall is genuinely emergent from two finite compartments, and the argument for a bloodstream lands; **circulation** sweeping it away to keep the gradient steep. *Superseded by `carrier_vs_channel`: no Vmax on the carrier, no flux magnitude, and its circulation clears only half the space (§16.2).* |
| `carrier_vs_channel.html` | **The reference implementation — the only §2.1-compliant prototype.** Flux is computed from the field first, then a `flux` accumulator spawns particles to match; this is the pattern the real build follows. Side-by-side **carrier vs channel**: shuttle (slow, saturable Vmax, gentle) vs open pore (fast, uncapped, violent reflux, ATP leak); circulation reveals when the channel's speed pays off. Supersedes `lactate_export` on both transport law and circulation removal. |
| `full_cell.html` | **The integrated intro**: full membrane with all three transporters on their correct faces, both inflows, glycolysis enzyme, ATP economy with upkeep drain, nucleus, nanobot, and the **complete osmosis→swelling→tension→lysis** dynamic with a tension meter and a bleb escape. Progressive 4-button build-up = the tutorial arc. Contains the §7.4 and §13 constants as-run. |
| `cytoskeleton_belts.html` | **Intracellular spatial gameplay (§4.7)**: an enzyme placed far from the glucose import starves on slow diffusion (ATP falls) until the player lays a **filament highway** and **motor proteins** haul glucose directly to it at ATP cost (loaded > empty). Enzyme feed rate and ATP jump; adding motors scales throughput to the consumer's ceiling; the highway visibly **skips the bulk**, producing hotspots and cold zones. |
| `motility_chemotaxis.html` | **Motility & exploration (§10A)**: a mobile cell forages a patchy glucose field (rendered as the zoomed-out **tint = concentration field** LOD view) with a beating flagellum. It **senses** the local gradient (glucose − toxin), **decides** a heading (blue arrow), and **swims** up it (ATP cost), eating and depleting patches, avoiding a toxic zone. Toggling chemotaxis off drops it to a random walk that starves — showing the value of the sense→decide→actuate loop. Click to drop food patches. |
| `sav_wall.html` | **SUPERSEDED by `belts_vs_sav.html`.** First SA:V sketch: growing cell, fixed-thickness healthy shell, expanding necrotic core, wrinkle/divide escapes. Flaw: its membrane was an *infinite* source (held at fixed concentration), so it modeled only the *transit* limit — which meant belts would have wrongly appeared to fix everything. Kept for the wrinkle/divide UI only. |
| `belts_vs_sav.html` | **The corrected SA:V model (§17)** — the reference implementation. **Finite** per-membrane-tile import (supply ∝ surface), zero-order consumption, **reflecting no-flux boundary**, optional cytoskeletal streaming. Demonstrates: belts remove the dead core in the mid-range (fix *transit*) but never change `Supply÷Demand` (the *flux* ceiling); at large size streaming makes starvation *worse* (socialized famine vs. diffusion's triage); a sharp zero-then-power-law starvation knee with a smooth predictive `Supply÷Demand` warning gauge; `Net ATP/s` collapsing as belt cost outruns supply. Verified by parameter sweep. |

**Known gaps in the prototypes.** The list below is the *intentional* set — scope deliberately deferred. It is not the whole story: §16.2 records the **unintentional** defects found by auditing the code against these descriptions, several of which invalidate specific claims made in this table. Read both. In particular, the frame-rate-dependent diffusion in `sav_wall` and `belts_vs_sav` (§17.2) means every number measured from the SA:V prototypes is provisional.

Intentional gaps: motion is hand-tuned rather than grid-derived in the metabolic prototypes (`motility_chemotaxis`, `sav_wall`, and `belts_vs_sav` DO run real grid reaction-diffusion and are the reference for §3's true grid substrate); `sav_wall` is superseded by `belts_vs_sav` (finite-flux) and kept only for its wrinkle/divide UI; the amino-acid supply-chain *blocking* case (build stalls on a missing type) is not yet implemented (surplus is provided); the doom-spiral dilution→rate feedback is shown but not wired; permanent necrosis (§17.6) is not yet implemented; tuning constants are scattered rather than centralized; pH, division re-tiling, circulation, endocrine, nervous, immune, and reproduction (everything in §14 beyond the intro and the three spatial prototypes) are specced but not built. The three spatial systems from the design review — cytoskeleton belts (§4.7), motility/chemotaxis (§10A), and the SA:V wall (§17) — are each validated by a prototype.

---

*End of specification. The design spine (§2) is non-negotiable; everything else is a consequence of it.*