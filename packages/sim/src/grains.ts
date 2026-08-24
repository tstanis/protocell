/**
 * Discrete matter. SPEC.md §5a.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Everything the player handles used to be a continuum field, rendered as cosmetic dots.
 * That is correct physics and it was illegible: measured on a mid-game cell, glycine's
 * concentration ran 0.0389 mean against 0.0392 max — perfectly flat — and the renderer
 * spent four hundred dots saying nothing. A player cannot count a field, cannot point at
 * one molecule of it, and cannot pick it up.
 *
 * So the species the player touches are now COUNTABLE THINGS. A grain is a real entity in
 * the simulation with an identity that persists across ticks, a position, and a quantity.
 * It is not a costume: the renderer draws grains because grains are what there is.
 *
 * ── The split, and why it is not arbitrary ───────────────────────────────────
 * Grains live INSIDE the cell only. The extracellular medium stays a continuum field,
 * because §2.5 already models it as a boundary condition rather than as state (`bathRate`
 * is Infinity — an effectively infinite, well-stirred bath), and §11.3a already draws it
 * as tint rather than dots. Import mints a grain at the membrane; export consumes one and
 * returns its quantity to the bath.
 *
 * That split also resolves the tension between "few particles" and "real gradients". Grain
 * count scales with the amount of matter, which scales with volume — so the intro cell
 * holds a countable ~16 glucose and a large one holds hundreds, and §17's penetration-depth
 * wall re-emerges at exactly the scale where it matters. Legible when small, continuous
 * when big, with no switch to throw.
 *
 * ── Diffusion is a random walk, and that is not an approximation ─────────────
 * The diffusion equation is the continuum LIMIT of a random walk, so moving grains by
 * random steps is the microscopically truthful version of what `ops/diffuse.ts` does to a
 * field, not a cheaper stand-in for it. For a 2D walk with independent per-axis steps of
 * standard deviation σ over a timestep dt, the mean squared displacement is
 *
 *     ⟨r²⟩ = 2σ²  and  ⟨r²⟩ = 4·D·dt   ⇒   σ = sqrt(2·D·dt)
 *
 * so the walk reproduces the same D the field uses, from the same DIFFUSION table. That is
 * what keeps §13 and §17 comparable across the change rather than quietly re-tuned.
 */

import { DIFFUSION } from './constants.js';
import { AMINO_TYPES, SPECIES_ID, speciesName, type SpeciesId } from './species.js';

/**
 * ONE PARTICLE IS ONE THING. SPEC.md §5d.
 *
 * This used to be `GRAIN_UNIT`, a per-species conversion between the parcel drawn on
 * screen and the "molecules" inside it — four glucose to a grain, four lactate, one
 * residue. It bought smaller particle counts and cost the entire vocabulary: the HUD ended
 * up quoting **grains**, **particles**, **molecules**, **units** and **residues** for what
 * were mostly the same thing, and a rate reported in one was silently compared against a
 * quantity measured in another. Three separate bugs this session were exactly that
 * mismatch, and each hid behind a plausible-looking number.
 *
 * So the conversion is gone. A particle is the unit — the thing drawn, the thing counted
 * on a deposit, the thing an enzyme eats, the thing a bond spends. Every rate in §13 is
 * now per particle, which is why `ATP_PER_GLUCOSE` reads 8 rather than 2: one glucose
 * particle is what used to be four molecules, and it always yielded 8 ATP.
 *
 * Nothing on screen moved. The counts are identical, because the rates were divided by
 * exactly what the parcel used to hold.
 */
export const PARTICLE = 1;

/**
 * Per-species multiplier on D for the random walk. SPEC.md §5a.8.
 *
 * ── The rule this encodes ────────────────────────────────────────────────────
 * A thing the player must physically walk to and collect CANNOT move faster than the
 * player. That sounds obvious; it was violated on the first build and playtesting found it
 * immediately — "they move around so quickly you cannot go get them."
 *
 * The arithmetic is damning. BOT_SPEED is 9 tiles/s. At the residues' tabulated D of 8, a
 * bead nets sqrt(4·D·t) = 5.7 tiles of drift per second, and its actual jitter path runs
 * about 44 tiles/s. The bot could not catch one, and chasing it looked frantic rather than
 * alive.
 *
 * ── Why residues and not glucose ─────────────────────────────────────────────
 * The split is by WHO HANDLES IT, and that turns out to be the principled line:
 *
 *   - Glucose and lactate are handled by MACHINERY. A transporter mints them at the
 *     membrane and an enzyme reaches for them; nothing has to chase anything. Their D is
 *     also load-bearing — glucose must cross the interior to reach an enzyme, and that
 *     traverse IS §17's penetration depth. Slowing it would re-tune the economy and blunt
 *     the SA:V wall, so it is left exactly alone.
 *   - Residues are handled by the PLAYER, on foot. So they move at a speed a walker can
 *     work with.
 *
 * ── Honesty about what this is ───────────────────────────────────────────────
 * There is a real physical story available — a bead is a packet of molecules rather than a
 * monomer, and Stokes-Einstein gives D proportional to 1/radius, so an aggregate genuinely
 * diffuses slower. It is a true story and it is not the reason. The reason is that this
 * quantity became something the player must catch, and catchability is a design
 * requirement that the diffusion table knows nothing about. Recorded plainly rather than
 * dressed up as derivation, because §13's whole discipline is that a constant carries the
 * argument that produced it — including when the argument is "the game needs this".
 *
 * ── SUPERSEDED, and kept because the lesson outlived the fix (§5a.9) ────────
 * Slowing the beads to 0.05 made them catchable and did NOT make them findable, which is
 * what actually killed the mechanic: "it is impossible for a player to reason about where
 * concentrations of amino acids are." Residues went back to being a field, so no entry
 * here applies to them any more and nothing the player must collect exists at all.
 *
 * The table stays because the rule is real and the next collectible thing will need it.
 * The lesson is the more useful half: **a legibility problem will not yield to a tuning
 * fix if the representation itself is wrong.** Two rounds of tuning went into making beads
 * catchable before the actual answer turned out to be that they should not have been
 * objects.
 */
export const GRAIN_DRIFT: Readonly<Record<string, number>> = Object.freeze({
  /**
   * Metabolites drift at a fraction of their tabulated D (§5b.7).
   *
   * At the full value glucose has D = 10, so a grain nets 6.3 tiles/s and its jitter path
   * runs about 44 tiles/s — sub-tile per simulation step, but ~0.8 tiles between the
   * 30 Hz frames the client actually draws, which reads as a swarm of gnats rather than as
   * matter. "They are crazy."
   *
   * 0.15 puts glucose at D = 1.5: ~2.4 tiles/s of drift and a third of a tile between
   * frames. Still visibly in thermal motion (§11.7), still has to CROSS the cell to reach
   * an interior enzyme — so §17's penetration depth is intact, and in fact more legible,
   * because you can now follow an individual grain doing it.
   *
   * This is a legibility decision, not a derivation, and is recorded as one. What it must
   * not do is stop glucose reaching enzymes; the intro arc is re-measured against it.
   */
  glucose: 0.15,
  // Lactate drifts faster than glucose, as it does in the DIFFUSION table (16 against 10,
  // it being the smaller molecule) and for a gameplay reason that agrees with it: waste
  // has to travel FROM the enzymes TO the wall before a carrier can take it, so if it
  // barely moves the carriers starve and §12.3's rescue never lands.
  lactate: 0.25,
  /**
   * Residues barely move. §5c — they are OUTPUT SITTING IN A HOPPER, not molecules.
   *
   * The first bead model (§5a) failed because beads had no source: they were scattered
   * uniformly through the cytoplasm, five species at once, and "go and get gly" meant
   * searching a shaken box. Nothing about their speed was the problem, which is why
   * slowing them (§5a.8) fixed nothing.
   *
   * What changed is that a residue now COMES FROM SOMEWHERE — the transporter you built
   * and placed. It appears at that tile and stays there, piling up until you collect it.
   * A thing with a known source and a fixed location is findable by construction, and no
   * amount of drift would have made the sourceless version findable.
   *
   * ZERO, not merely slow. At 0.02 they still wandered ~9 tiles in two minutes, which was
   * enough to escape both the hopper's own count (so it overfilled, 11 against a cap of 8)
   * and the nanobot's pickup reach (so a collection trip left stragglers behind). A hopper
   * whose contents drift out of it is not a hopper. These are held at the port until
   * something takes them.
   */
  ...Object.fromEntries(AMINO_TYPES.map((t) => [t, 0])),
});

/**
 * Species carried as grains rather than as a field. Everything else stays continuum.
 *
 * ── The residues were here, and were removed. §5a.9 ──────────────────────────
 * Making amino acids into locatable objects failed as a mechanic, and the playtest note is
 * worth keeping verbatim because it names the failure precisely: *"it is impossible for a
 * player to reason about where concentrations of amino acids are… finding an amino acid is
 * an impossible task, or sometimes a magical one where they are just around and you don't
 * know why."*
 *
 * Both halves of that are damning, and the second is the worse one. A mechanic that
 * sometimes hands you what you need for reasons you cannot see is not a mechanic; it is
 * noise that occasionally rewards you. Slowing the beads (§5a.8) made them catchable but
 * did nothing about being findable, because the problem was never speed — it was that five
 * species of small drifting object in a crowded cytoplasm cannot be told apart or
 * predicted, however they are shaped.
 *
 * So residues go back to being a FIELD, and the fix is on the other side: §9.2 draws them
 * from the whole cell rather than from a radius around the bot. Gradients still exist and
 * still matter — outside, where §10A.3 steers by them — but *pickup* no longer depends on
 * where you are standing, which is what "abandon the concentration aspect for the purpose
 * of pickup" means.
 *
 * Glucose and lactate stay grains, because for them locality is the point: an enzyme
 * reaches for substrate, a carrier exports from the face it sits on, and §17's whole SA:V
 * wall is about glucose failing to reach the middle. Those are machine-handled and their
 * position carries real information.
 */
export const DISCRETE_IDS: readonly SpeciesId[] = Object.freeze([
  SPECIES_ID.glucose,
  SPECIES_ID.lactate,
]);

const DISCRETE_SET = new Set<SpeciesId>(DISCRETE_IDS);

/** Is this species represented as countable grains? */
export function isDiscrete(id: SpeciesId): boolean {
  return DISCRETE_SET.has(id);
}

/** What one grain of this species is worth, in the same units the field uses. */
/**
 * What one particle is worth. Always 1 — kept as a function so call sites read as
 * intent rather than as a bare literal, and so §5d's collapse is greppable.
 */
export function grainUnit(_id: SpeciesId): number {
  return PARTICLE;
}

export interface Grain {
  /**
   * Stable identity for the lifetime of the grain.
   *
   * This is the load-bearing difference from a dot. A dot is a pixel the renderer chose
   * this frame; a grain is the same object next frame, so it can be hovered, pointed at,
   * picked up, and watched being eaten. It also lets the client animate honestly: if an id
   * disappears, that grain was genuinely consumed.
   */
  id: number;
  species: SpeciesId;
  /** Position in grid tiles, continuous. */
  x: number;
  y: number;
  /** Quantity, in field units. Normally `grainUnit(species)`; a remainder can be less. */
  amount: number;
  /** True while the bot is carrying it, which suspends its walk. */
  held: boolean;
}

/**
 * The grains inside the cell.
 *
 * A flat array with a species index rather than a per-species map, because almost every
 * consumer wants "grains of species S near point P" and the counts are in the low
 * hundreds — small enough that a linear scan with an early species test beats maintaining
 * a spatial structure that has to be rebuilt every tick as everything moves.
 */
export class GrainStore {
  readonly grains: Grain[] = [];
  private nextId = 1;

  /** Deterministic PRNG — §3.7 requires the whole sim be replayable from a seed. */
  private seed: number;

  constructor(seed = 0x9e3779b9) {
    this.seed = seed >>> 0;
  }

  /** xorshift32. Deterministic, fast, and good enough for Brownian motion. */
  private rand(): number {
    let x = this.seed;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5;
    x >>>= 0;
    this.seed = x;
    return x / 4294967296;
  }

  /** Standard normal via Box–Muller's polar form, so the walk is genuinely Gaussian. */
  private normal(): number {
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.rand() * 2 - 1;
      v = this.rand() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  }

  add(species: SpeciesId, x: number, y: number, amount = grainUnit(species)): Grain {
    const g: Grain = { id: this.nextId++, species, x, y, amount, held: false };
    this.grains.push(g);
    return g;
  }

  /**
   * Mint however many whole grains `amount` is worth at a point, returning the remainder.
   *
   * Callers accumulate the remainder rather than rounding it away — a transporter
   * importing 0.3 of a grain's worth per tick must not import nothing forever, and must
   * not import a whole grain either. Conservation is the invariant that matters here and
   * it is the one that silently breaks if you round.
   */
  mint(species: SpeciesId, x: number, y: number, amount: number): number {
    const unit = grainUnit(species);
    let left = amount;
    while (left >= unit) {
      this.add(species, x, y, unit);
      left -= unit;
    }
    return left;
  }

  remove(g: Grain): void {
    const i = this.grains.indexOf(g);
    if (i >= 0) {
      this.grains[i] = this.grains[this.grains.length - 1]!;
      this.grains.pop();
    }
  }

  /** Total quantity of a species held as grains. The grain-side of "concentration". */
  total(species: SpeciesId): number {
    let sum = 0;
    for (const g of this.grains) if (g.species === species) sum += g.amount;
    return sum;
  }

  count(species: SpeciesId): number {
    let n = 0;
    for (const g of this.grains) if (g.species === species) n++;
    return n;
  }

  /** Quantity of a species within `r` of a point — the local concentration numerator. */
  totalNear(species: SpeciesId, x: number, y: number, r: number): number {
    const r2 = r * r;
    let sum = 0;
    for (const g of this.grains) {
      if (g.species !== species || g.held) continue;
      const dx = g.x - x;
      const dy = g.y - y;
      if (dx * dx + dy * dy <= r2) sum += g.amount;
    }
    return sum;
  }

  /** The nearest unheld grain of a species within `r`, or null. */
  nearest(species: SpeciesId, x: number, y: number, r: number): Grain | null {
    let best: Grain | null = null;
    let bestD = r * r;
    for (const g of this.grains) {
      if (g.species !== species || g.held) continue;
      const dx = g.x - x;
      const dy = g.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD) {
        bestD = d2;
        best = g;
      }
    }
    return best;
  }

  /**
   * Take `want` units of a species from grains within `r`, consuming whole grains and
   * splitting the last one if it overshoots. Returns how much was actually taken.
   *
   * Splitting rather than refusing matters: RESIDUE_UNIT is 0.25 and a grain is 1.0, so
   * every bond after the first takes a quarter of a grain. Without splitting, three
   * quarters of every residue grain would be unreachable.
   */
  take(species: SpeciesId, x: number, y: number, r: number, want: number): number {
    let got = 0;
    while (got < want - 1e-12) {
      const g = this.nearest(species, x, y, r);
      if (!g) break;
      const need = want - got;
      if (g.amount <= need + 1e-12) {
        got += g.amount;
        this.remove(g);
      } else {
        g.amount -= need;
        got += need;
      }
    }
    return got;
  }

  /**
   * Push held grains apart, away from the centre of mass of their close neighbours.
   *
   * §5b.5's hopper output is placed rather than diffused, so it needs some way not to sit
   * in a heap. Each grain looks at the others of its species within `radius`, takes their
   * centre of mass, and drifts along the vector pointing away from it.
   *
   * This is SELF-LIMITING, which is why it needs no leash: the repulsion only sees
   * neighbours inside `radius`, so once a pile has spread to about that spacing every
   * grain has nobody left to push against and the motion stops on its own. It settles
   * rather than dispersing.
   *
   * Only applies to grains that do not already random-walk. Adding a force to glucose or
   * lactate would corrupt their diffusion, and their `D` is load-bearing for §17.
   */
  settle(dt: number, radius: number, speed: number, inside: (x: number, y: number) => boolean): void {
    const r2 = radius * radius;
    // Positions are read before any are written, so the result does not depend on the
    // order of the array — §3.7 wants this replayable, and an in-place update would make
    // each grain react to some neighbours' new positions and some neighbours' old ones.
    const moves: Array<{ g: Grain; dx: number; dy: number }> = [];

    for (const g of this.grains) {
      if (g.held) continue;
      const name = speciesName(g.species);
      if ((GRAIN_DRIFT[name] ?? 1) > 0) continue; // it diffuses; leave it alone

      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const o of this.grains) {
        if (o === g || o.species !== g.species || o.held) continue;
        const dx = o.x - g.x;
        const dy = o.y - g.y;
        if (dx * dx + dy * dy > r2) continue;
        sx += o.x;
        sy += o.y;
        n++;
      }
      if (n === 0) continue;

      // Away from the neighbours' centre of mass.
      let vx = g.x - sx / n;
      let vy = g.y - sy / n;
      const mag = Math.hypot(vx, vy);
      if (mag < 1e-6) {
        // Exactly coincident: pick a deterministic direction from the id so a stack still
        // breaks up, rather than dividing by zero and staying put forever.
        const a = g.id * 2.399963;
        vx = Math.cos(a);
        vy = Math.sin(a);
      } else {
        vx /= mag;
        vy /= mag;
      }
      moves.push({ g, dx: vx * speed * dt, dy: vy * speed * dt });
    }

    for (const m of moves) {
      const nx = m.g.x + m.dx;
      const ny = m.g.y + m.dy;
      if (inside(nx, m.g.y)) m.g.x = nx;
      if (inside(m.g.x, ny)) m.g.y = ny;
    }
  }

  /**
   * Advance every grain's Brownian walk, and keep it inside the cell.
   *
   * `inside` is the containment test. A grain that steps out is REFLECTED back to where it
   * came from rather than clamped to the boundary — clamping piles grains onto the wall
   * and manufactures a concentration spike exactly where transport reads its gradient,
   * which is the discrete cousin of the absorbing-sink bug §17.2 cost a rebuild.
   */
  step(dt: number, inside: (x: number, y: number) => boolean): void {
    for (const g of this.grains) {
      if (g.held) continue;
      const name = speciesName(g.species);
      const d = (DIFFUSION[name] ?? 1) * (GRAIN_DRIFT[name] ?? 1);
      if (d <= 0) continue; // held in place — see GRAIN_DRIFT
      const sigma = Math.sqrt(2 * d * dt);
      const nx = g.x + this.normal() * sigma;
      const ny = g.y + this.normal() * sigma;
      // Axis-independent reflection, so a grain sliding along a wall keeps sliding
      // instead of being frozen by one blocked axis.
      if (inside(nx, g.y)) g.x = nx;
      if (inside(g.x, ny)) g.y = ny;
    }
  }
}
