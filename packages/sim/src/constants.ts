/**
 * THE single config block. SPEC.md §13 / §15.4.
 *
 * Every value here carries the derivation that produced it. A constant without a
 * derivation is a bug waiting to be re-tuned by guesswork — which is exactly how the
 * prototypes ended up running three mutually incompatible ATP economies (§16.2).
 *
 * Units are grid-native: lengths in tiles, times in seconds, amounts per tile.
 * The prototypes' pixel and particle-count units do not survive the move to a real
 * field; several were choreography parameters describing how particles were *drawn*
 * rather than quantities the simulation had. See §13.8 for what was retired.
 */

// ─── §13.1 Geometry ──────────────────────────────────────────────────────────

export const INTERIOR_TILES = 1000;
export const MEMBRANE_TILES = 120; // the ~10% ring
export const CELL_TILES = INTERIOR_TILES + MEMBRANE_TILES; // 1120

/** Rest radius in tiles: sqrt(1000/π). A 32×32-ish blob, per §4.1. */
export const R0 = Math.sqrt(INTERIOR_TILES / Math.PI); // 17.84

/**
 * Tiles spanned by one transporter face. The prototypes' TRANSPORTER_WINDOW was an
 * angular half-width of 0.34 rad; 0.68/2π = 10.8% of a 120-tile ring ≈ 13 tiles.
 */
export const TRANSPORTER_FACE_TILES = 13;

// ─── §13.2 ATP economy ───────────────────────────────────────────────────────

/**
 * Upkeep is PER TILE, not flat.
 *
 * A flat drain cannot coexist with §17: if rent does not grow with the cell, growing
 * is never punished and the SA:V wall — the design's most important forcing function —
 * evaporates. Anchored so a §4.1-sized cell pays exactly the playtested 1.8 ATP/s:
 *
 *     1.8 ATP/s / 1120 tiles = 0.0016
 *
 * The intro therefore feels identical to `full_cell.html` while the late game acquires
 * a real cost curve.
 */
export const UPKEEP_PER_TILE = 1.8 / CELL_TILES; // 0.001607

/**
 * Starting reserve.
 *
 * Was 55, which gave "~30 s of grace" — correct while builds were free. Once §9.2's
 * construction became real, that number stopped working, and the reason is structural
 * rather than a tuning miss: **the opening reserve has to fund the entire bootstrap**,
 * because nothing produces ATP until the glycolysis enzyme exists, and the enzyme cannot
 * work until the glucose channel exists. Both are proteins, and both cost 4 ATP a bond.
 *
 *   glucose channel   6 residues  =  24 ATP
 *   glycolysis enzyme 8 residues  =  32 ATP
 *   ~30 s of walking and assembling at 1.6 ATP/s upkeep = ~48 ATP
 *   ----------------------------------------------------------
 *                                    ~104 ATP before the first ATP is earned
 *
 * At 55 the cell simply could not afford to become alive, and the intro deadlocked with a
 * half-built channel.
 *
 * 140 was the arithmetic answer and it was still not enough in practice, for two reasons
 * the sum above misses: the bot GATHERS from a local patch rather than from the whole
 * cell, so it stalls on a local shortage long before the global reserve is spent; and it
 * spends real seconds walking between the nucleus, the residues, and the deploy site,
 * paying upkeep the whole way. Measured, the run died mid-enzyme with 78 ATP still in the
 * cell but not where the bot was standing.
 *
 * 220 covers the bootstrap with genuine margin. §12 is meant to be un-loseable, and the
 * tension in Act 1 should come from watching the number fall, not from a deadlock the
 * player has no way to read or recover from.
 */
export const ATP_START = 220;

/** Real anaerobic glycolysis stoichiometry. Not a dial — see §1.3 on native ratios. */
export const ATP_PER_GLUCOSE = 8;

/** §9.1: peptide-bond formation is endergonic, ~4 ATP-equivalents per residue. */
export const ATP_PER_PEPTIDE_BOND = 4;

/** Render-only: how many ATP units one drawn dot represents. */
export const ATP_DOT_SCALE = 2;

/**
 * Ceiling on ATP per tile — the conserved adenine nucleotide pool (see species.ts).
 *
 * A cell cannot bank unlimited ATP. The total ATP + ADP is fixed, so once everything is
 * phosphorylated there is no free ADP left to charge and glycolysis simply stops. That is
 * real respiratory control, and it does useful work here: a cell with nothing to spend
 * energy on stops burning glucose instead of inflating forever.
 *
 * It also creates exactly the pressure §12.4 wants. A full battery and a growing pile of
 * amino acids with nowhere to go IS the intro's cliffhanger — the game telling you to go
 * build a ribosome, through the economy rather than through a prompt.
 *
 * Must sit comfortably above the bootstrap cost, or the cell cannot hold enough charge to
 * build its own metabolism — the ceiling would clip the starting reserve before the first
 * protein was finished. Raised from 0.25 when hand-assembly made the bootstrap real.
 */
export const ATP_POOL_PER_TILE = 0.5;

/** §13.2. Scales ooze amplitude and particle speed; low reads as visible distress. */
export function health(atp: number): number {
  return Math.min(1, Math.max(0.2, atp / 16));
}

// ─── §13.3 Enzyme ────────────────────────────────────────────────────────────

/**
 * Seconds to crack ONE GLUCOSE PARTICLE. One active site, so this is a hard per-copy
 * ceiling.
 *
 * 1.12, not 0.28. This was the last unconverted number left by §5d's collapse to one unit,
 * and it was a live 4x bug rather than a stale comment: the enzyme held its substrate for
 * `ENZYME_BIND_TIME * held`, `held` was the parcel's contents, and when a parcel stopped
 * being four molecules and became one particle the hold time silently fell to a quarter.
 * Measured, a single enzyme cracked 3.4 particles/s against a design ceiling of 0.893 and
 * grossed 28.6 ATP/s against 7.14 — the intro economy was four times over-provisioned and
 * every §13 derivation downstream of turnover was wrong.
 *
 * Worth recording HOW it hid. `ATP_PER_GLUCOSE` and `LACTATE_PER_GLUCOSE` were both
 * re-expressed per particle, so the yield PER CRACK stayed right and the only thing wrong
 * was the RATE. Nothing looked out of place in a snapshot; the check that caught it was a
 * test asserting throughput against `ENZYME_TURNOVER`, which is exactly what §13's
 * "a constant carries the argument that produced it" is for.
 */
export const ENZYME_BIND_TIME = 1.12;

/** 0.893 glucose particles/s ⇒ 7.14 ATP/s when fed — about 4× upkeep at intro size. */
export const ENZYME_TURNOVER = 1 / ENZYME_BIND_TIME;

/**
 * CORRECTED from 1. A C₆ sugar splits into two C₃ units, so real anaerobic glycolysis
 * is `1 glucose → 2 ATP + 2 lactate`. §1.3 makes native stoichiometry a signature
 * feature, so the real ratio wins over the prototypes' 1.
 *
 * Consequence: this DOUBLES the osmotic load per glucose, so §12.3's swelling crisis
 * arrives roughly twice as fast. Probably better drama, but it is a pacing change —
 * re-check the intro when it is re-hosted.
 */
export const LACTATE_PER_GLUCOSE = 2;

// ─── §13.5 Simulation clock & diffusion ──────────────────────────────────────

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;

/**
 * Explicit 2D diffusion is stable only while D·dt/h² ≤ 0.25 (§3.3). With h = 1 tile
 * that puts a hard ceiling on every diffusion coefficient. Asserted in dev rather than
 * left to explode quietly — `assertCFL` in ops/diffuse.ts.
 */
export const CFL_LIMIT = 0.25;
export const D_MAX = CFL_LIMIT / SIM_DT; // 30 tiles²/s

/**
 * D_GLUCOSE comes from §4.1's legibility requirement: a solute dropped at the membrane
 * has ~15 tiles to cross, and spreading time ≈ L²/4D = 225/40 ≈ 5.6 s — slow enough to
 * watch a gradient form. The rest are scaled by molecular size, which also drives
 * §11.2's motion speed: small molecules shimmer, proteins lumber, for the same reason
 * they do in reality.
 */
export const DIFFUSION: Readonly<Record<string, number>> = {
  glucose: 10,
  // Lactate is ~90 Da against glucose's ~180, so it genuinely diffuses faster; the
  // Stokes-Einstein scaling with molecular radius puts it around 1.6x. The prototypes'
  // 12 was a guess. It matters more than it looks: waste must cross the whole cell to
  // reach its export face, and at 12 the carrier face sat starved at 2-8% of bulk
  // concentration while the cell backed up behind it.
  lactate: 16,
  amino: 8,
  atp: 15,
  water: 20,
  o2: 20,
  co2: 20,
  protein: 1,
};

// ─── §13.4 Transport ─────────────────────────────────────────────────────────

/**
 * On a real field, import is Fick (§6.2), so the primitive is a permeability, not a
 * "funnel strength". §8.1's glucose trapping holds c_in ≈ 0, so the working gradient is
 * ≈ c_out. Derived from the requirement that ONE CHANNEL FEEDS ONE ENZYME:
 *
 *     P = 3.57 glucose/s / 1.0 = 3.57  per transporter, at unit gradient
 *
 * ── Why per TRANSPORTER and not per membrane tile ────────────────────────────
 * This was originally derived per tile across a 13-tile face, which is right if the
 * player paints a whole face at once. Once §9.2's construction became real it stopped
 * working, because a hand-built protein seats exactly ONE transporter on ONE tile — so a
 * channel delivered a thirteenth of an enzyme's appetite, the cell could not cover its
 * own upkeep, and the intro stalled at ~0 ATP with a working enzyme and a working
 * channel. Thirteen hand-built channels would have cost 312 ATP against a 140 reserve.
 *
 * The per-transporter reading is also the biologically honest one. A GLUT1 channel turns
 * over ~1200 glucose/s while hexokinase manages ~100–1000/s, so in reality one
 * transporter comfortably feeds one enzyme and then some. "One channel feeds one enzyme"
 * is if anything conservative, and it is a far more legible rule than a tile count.
 *
 * §6.7's placement puzzle survives intact — the decision is still WHERE the channel sits,
 * and membrane tiles are still one-transporter-each — it is just no longer priced as
 * thirteen separate builds.
 */
export const P_CHANNEL_GLUCOSE = ENZYME_TURNOVER / 1.0; // 3.571

/**
 * Sustained transporter density across a membrane, used by §17's flux ceiling.
 *
 * §17.1 defines the boundary-flux limit as `transporter_density × membrane_area`, and
 * the sweep's `IMPORT_PER_MEM` is that product per tile — NOT the permeability of a
 * single transporter. A membrane fully saturated with maximum-throughput channels is not
 * a cell, it is a hole; real membranes carry a mixture, and each transporter costs
 * amino acids and ATP to build and maintain.
 *
 * At 1 transporter per ~13 tiles, effective import per membrane tile is
 * `3.571 / 13 = 0.2747` — exactly the figure §17.3 and §17.4 were measured with, so
 * those results stand unchanged.
 */
export const TRANSPORTER_DENSITY = 1 / TRANSPORTER_FACE_TILES;
export const IMPORT_PER_MEM = P_CHANNEL_GLUCOSE * TRANSPORTER_DENSITY; // 0.2747

/** §4.2: a membrane tile is a sealed wall by default. Near-zero, not zero. */
export const P_BILAYER_DEFAULT = 1e-4;

/** §6.2: O₂/CO₂ are small and nonpolar, and cross the bare bilayer freely. */
export const P_BILAYER_GAS = 0.9;

/**
 * §6.4's saturating carrier, derived on the same principle as the channel above: ONE
 * CARRIER CLEARS ONE ENZYME'S WASTE.
 *
 *     3.571 cracks/s × 2 lactate = 7.14 lactate/s
 *
 * `carrier_vs_channel.html` used 3.2, which was right for a demo where the carrier was
 * one of two side-by-side illustrations. It is wrong here: at 3.2 a single hand-built
 * carrier cannot keep up with a single enzyme, so §12.3's deflation never arrives however
 * long you wait, and the player is punished for a shortfall they cannot see.
 *
 * The §6.4 contrast with a channel survives, because the contrast was never about
 * absolute speed. A channel is uncapped and scales with gradient without limit — at a
 * gradient of 10 it moves 35.7 while the carrier is still pinned at 7.14 — and it refluxes
 * just as hard the moment the gradient turns. Saturable-and-gentle versus
 * unlimited-and-violent is the lesson, not slow versus fast.
 */
export const CARRIER_HEADROOM = 2;
export const VMAX_CARRIER_LACTATE =
  ENZYME_TURNOVER * LACTATE_PER_GLUCOSE * CARRIER_HEADROOM; // particles/s

/**
 * The headroom is not padding. At exactly 1× production a single carrier can only hold
 * the waste level STEADY, so a cell that has already swollen stays swollen forever — and
 * §12.3 promises the opposite ("the swollen cell deflates back to safety"), while §10.4's
 * three acts require that clearing the waste is genuinely a rescue rather than a plateau.
 * Measured at 1×, lactate sat flat at its peak and the cell never came down.
 *
 * Real MCT carriers clear lactate far faster than glycolysis makes it, for the same
 * reason: a cell that could only break even would have no way back from exertion.
 */
export const K_CARRIER = 55;

// ─── §13.6 The chain that closes ─────────────────────────────────────────────

/**
 * Penetration depth L = sqrt(2·D·c₀/k) (§17.3), where k is aggregate zero-order
 * consumption — which is not a free constant, it is enzyme_density × turnover.
 *
 * Setting L equal to the §4.1 cell radius, so the spec'd cell sits exactly at the knee
 * (§17.6's "natural unit cell size"):
 *
 *     k = 2·D·c₀/L² = 2(10)(1)/318 = 0.063 glucose/tile/s
 *     enzyme_density = k / 3.57 = 0.0177  ⇒  ~18 enzymes per 1000-tile cell
 *
 * So §4.1's cell size, §8.1's turnover, and §17.3's penetration depth are mutually
 * consistent at D_GLUCOSE = 10. THIS IS A PREDICTION — scripts/sweep.ts must reproduce
 * it. If the re-measured knee does not land near R_interior = 17.8, one of these three
 * constants is wrong.
 */
export function penetrationDepth(D: number, c0: number, k: number): number {
  return Math.sqrt((2 * D * c0) / k);
}

export const PREDICTED_KNEE_RADIUS = R0; // 17.84 tiles

// ─── §13.7 Osmosis & volume (§7.4, re-expressed in tiles) ────────────────────

export const A_REST = Math.PI * R0 * R0; // 1000 tiles²

/** The RATIO is what sets resting volume; the prototype's absolute counts do not port. */
export const B_OSM_OVER_S_NOM = 150 / 177; // 0.847

export const LP = 1.6; // water permeability / relaxation rate
export const STIFF = 7; // membrane resistance to expansion past rest

/**
 * Fractional radius stretch at lysis. DRAMATIZED — real bilayers rupture at ~0.02–0.03.
 * §7.4 flags this as a deliberate truth-vs-legibility trade: a cell that visibly
 * balloons is the readable warning a game needs. Keep it a conscious dial.
 */
export const RUPTURE = 0.3;

export const BLEB_TENSION_MIN = 0.55;
export const BLEB_SHED_FRACTION = 0.55;
export const BLEB_VOLUME_FACTOR = 0.8;


/**
 * Whole residues per second, per open transporter, sitting on a deposit (§5b). Falls off
 * with distance from the deposit and, once it is nearly stripped, with what is left.
 *
 * ONE A SECOND, which is both a legible number and a derived one.
 *
 * 0.3 was authored against nothing but feel, and §9.4 then gave residues a demand it could
 * not meet. The standing build-out consumes 0.718 residues/s across five types, so a single
 * port covered 42% of the cell's total need — and because the five deposits are in five
 * different places, a cell parked on one of them is importing exactly one type while
 * spending all five. Playtested verdict: "impossible to keep up with the denaturing."
 *
 * The rate has to be set by the foraging CIRCUIT, not by the instantaneous comparison:
 *
 *     deposit reserve (glycine, the biggest)             217 particles
 *     collectable before the taper bites (75% of it)     163
 *     seconds parked at one stop of a five-stop circuit  ~100
 *     ⇒ rate needed to clear a deposit in one visit      ~1.6/s
 *
 * 1.2 sits well under that on purpose. One port on the tightest residue does NOT quite
 * keep up, and the answer is to build a second port for that type — which is the decision
 * this whole system exists to pose, and a much better one than a number that silently
 * covers everything.
 *
 * Was 1.0 against a 163-particle glycine deposit, before §9.5's pre-emptive repair raised
 * standing demand by a third and the reserves with it.
 */
export const RESIDUE_IMPORT_RATE = 1.2;


/**
 * How many residues one transporter will stack at its tile before it stalls (§5c).
 *
 * A finite output hopper, so an importer you never visit backs up and stops — the
 * backpressure is visible at the wall and it is what makes collecting a thing you have to
 * actually do. Eight is a couple of proteins' worth of one residue: long enough that you
 * are not shuttling constantly, short enough that ignoring a port has a cost.
 */
export const HOPPER_CAPACITY = 8;





/**
 * Seconds between re-evaluations of what the cell is short of (§10A.9).
 *
 * The scarcity table moves on the timescale of minutes, so sampling it at 120 Hz buys
 * nothing and would make `SWITCH_MARGIN`'s hysteresis arbitrate 120 times a second instead
 * of twice. Half a second is imperceptible to a player and 240x cheaper.
 */
export const AUTO_SEEK_INTERVAL = 0.5;


/**
 * Radius of the cluster a transporter's waiting output occupies, in tiles (§5c).
 *
 * Big enough that a full hopper reads as a PILE — its size is the signal that a port is
 * backed up — and small enough that the pile still reads as belonging to that one port
 * rather than smeared along the membrane. At HOPPER_CAPACITY 8 this puts roughly a tile
 * between neighbours, which is a clear gap at the shapes' drawn size.
 */
export const HOPPER_SPREAD = 2.0;


/**
 * How far a waiting residue looks for neighbours to push away from, and how fast (§5b.5).
 *
 * The spacing the pile settles at: repulsion only sees other grains inside this radius, so
 * a heap spreads until everything is about this far apart and then stops by itself. 2.2
 * tiles is a clear gap at the drawn size without smearing a port's output along the wall.
 */
export const SETTLE_RADIUS = 2.2;
/** Tiles per second. Fast enough to see it happen, slow enough to read as settling. */
export const SETTLE_SPEED = 0.9;


/**
 * How strongly a toxic zone repels, relative to an attractant of equal normalised strength
 * (§10A.3). Above 1 so a hazard genuinely deflects a hungry cell, but comparable — at the
 * old effective weight of ~40 the cell simply could not enter a region containing both.
 */
export const HOSTILE_WEIGHT = 1.5;


/**
 * Whole glucose GRAINS per second, per open channel, on its deposit at full richness
 * (§5b.6). One grain is GRAIN_UNIT.glucose molecules.
 *
 * Set against ENZYME_TURNOVER, which is 0.893 particles/s. §13.4 says one face should feed
 * one enzyme, and after §5d's unit collapse the corrected reading showed a single channel
 * delivering only 0.66 of one — under-provisioned by a third, which is why three enzymes on
 * one channel starved in every trial this session. 0.9 is the base rate before distance
 * and richness scale it; at the home deposit that lands near parity.
 */
export const GLUCOSE_IMPORT_RATE = 0.9;


/**
 * How far a lactate carrier reaches for waste to export, in tiles (§5b.8).
 *
 * Measured at 4 the carriers barely worked: waste is made at the enzymes and has to reach
 * the wall before anything can take it, so a short reach made export transport-limited
 * rather than Vmax-limited and two carriers cleared 138 grains down to only 61 in three
 * minutes. That IS §6.8's boundary-layer finding — the far side of the membrane is not the
 * bottleneck, getting waste TO the membrane is — but at intro scale it reads as a carrier
 * that does not work rather than as a lesson.
 *
 * 7 tiles lets a carrier sweep a real neighbourhood while still leaving the middle of a
 * large cell out of reach, which is where §17 wants the problem to bite.
 */
export const EXPORT_REACH = 7;


/** Seconds over which a carrier's export rate is averaged for display (§5b.8). */
export const EXPORT_WINDOW = 2;


/**
 * How many grains of a machine-consumed species the interior will hold before its ports
 * stop importing (§5b.6).
 *
 * A whole-cell ceiling rather than a port-local one, because glucose is eaten wherever it
 * drifts to — the question is whether the CELL is saturated, not whether one patch of wall
 * is. Generous: at 4 units a grain this is ~240 molecules, well over a minute of full
 * consumption for three enzymes, so it only bites when import genuinely outruns demand.
 */
export const INTERIOR_SATURATION = 60;
