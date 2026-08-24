/**
 * The patchy outside. SPEC.md §10A.2.
 *
 * "Once the cell can move, the outside stops being uniform: glucose-rich pockets, toxic
 * zones, warm currents, regions other cells have already stripped bare. This creates a
 * reason to EXPLORE (find richer food), a reason to FLEE (leave a depleting or hostile
 * patch), and spatial stakes for the outside."
 *
 * Patches live in WORLD coordinates, not grid coordinates — the grid is a window that
 * travels with the cell (see motility.ts), so the medium the cell is looking at changes as
 * it swims. That is what turns the extracellular field from a backdrop into terrain.
 *
 * ── Depletion is the load-bearing part ──────────────────────────────────────
 * A patch that never runs out makes motility pointless: park on the richest pocket and
 * never move again. Foraging only exists because staying still is a losing strategy, so
 * patches are drawn down by the cell that eats them and recover only slowly. "Regions
 * other cells have already stripped bare" is the same mechanic with a different agent.
 */

import { SPECIES_ID, type SpeciesId } from './species.js';
import { REPAIR_AT } from './denature.js';

/** The residue types that have their own deposit on the map. */
type AminoDepositType = 'gly' | 'leu' | 'lys' | 'ala' | 'val';

export interface Patch {
  /** Centre in world tiles. */
  x: number;
  y: number;
  /** Gaussian sigma in tiles. */
  radius: number;
  species: SpeciesId;
  /** Peak concentration when full. */
  peak: number;
  /** 0..1. Scales the peak; falls as the cell forages here. */
  richness: number;
  /**
   * How much this deposit holds in total, in field units. Depletion is `taken / reserve`.
   *
   * A single global depletion rate cannot work across species whose quantities differ by
   * two orders of magnitude. Glucose is imported at ~3.5 units/s and a pocket should last
   * minutes; a residue is imported at ~0.1 units/s and its deposit should be a finite haul
   * of a dozen units. Tuned as one constant, either glucose pockets evaporate or residue
   * deposits are inexhaustible — and it was the latter, which is why a deposit could hand
   * over 200 units and barely dim.
   *
   * A reserve says the honest thing instead: this deposit contains THIS MUCH, and taking
   * it empties it. It is also the number a player can be shown.
   */
  reserve: number;
  /**
   * How far out a transporter can still draw from this deposit, in tiles from its centre.
   *
   * An explicit range, because the previous version used the gaussian tail as the test
   * ("reach > 0.02") and that is both invisible and effectively arbitrary — at sigma 11 a
   * deposit 39 tiles away scored 0.002, so a channel aimed at a deposit the player could
   * SEE did nothing at all, with no indication why. A radius can be drawn as a ring, and
   * "am I inside it" is then a question the picture answers.
   */
  harvestRadius: number;
  /**
   * How fast this deposit replenishes, in PARTICLES PER SECOND.
   *
   * Per patch and in absolute units, for exactly the reason `reserve` is (see above): one
   * global rate cannot serve quantities two orders of magnitude apart. The old
   * `PATCH_REGROWTH` was a flat 0.00004 of RICHNESS per second, which is reserve-relative
   * — so it scaled with the wrong thing entirely. Measured, it gave the 1300-particle
   * glucose pocket 0.052/s and a 40-particle glycine deposit 0.0016/s, against a cell
   * consuming glycine at 0.194/s. **Residue deposits regrew at under one percent of the
   * rate they were consumed**, so every deposit on the map was a one-shot pickup and the
   * world was a fuel tank with about six minutes in it.
   *
   * Regrowth is now authored against DEMAND, which is what it has to keep up with, and
   * demand has nothing to do with how big the pocket is.
   */
  regrowth: number;
  /**
   * A patch the cell should avoid rather than seek (§10A.2's "toxic zones"). Kept as data
   * rather than a separate type because the sensing loop is identical — chemotaxis just
   * subtracts it, which is exactly how a real cell handles a repellent.
   */
  hostile?: boolean;
}

/**
 * ── The residue economy, sized against the thing that consumes it ───────────
 *
 * §9.4's denaturation is what makes residues a recurring cost rather than a one-time
 * shopping list, so the deposits have to be sized against IT. They never were: the
 * reserves below were picked as "roughly twice the starting stock", which is an
 * inventory-shaped number in a world that had since acquired a metabolism for structure.
 *
 * Measured on the standing build-out §14 describes — 3 channels, 3 enzymes, 2 carriers,
 * 5 transporters, a flagellum, 3 ribosomes = 17 proteins, 181 residues — against §9.4's
 * mean working life of 240 s x 1.05 mean frailty = 252 s:
 *
 *     gly 0.194/s   leu 0.139/s   lys 0.155/s   ala 0.131/s   val 0.099/s
 *     TOTAL 0.718 residues/s, or 43 a minute, forever
 *
 * The five deposits between them held 168 particles. **The entire map contained less
 * amino acid than one build-out costs**, and regrowth was two orders of magnitude below
 * consumption, so the world held 5.8 minutes of maintenance and then the cell died of
 * something the player could do nothing about. "Impossible to keep up with the
 * denaturing" was not a difficulty complaint, it was arithmetic.
 *
 * ── The two numbers, and what fixes each failure ────────────────────────────
 * REGROWTH decides whether the world is sustainable at all; RESERVE decides only how
 * long you can ignore a deposit. They were conflated, and only the second one existed.
 *
 *   regrowth_i = 1.4 x demand_i     so the standing set is comfortably sustainable if you
 *                                   work the circuit, and outgrowing the land takes a real
 *                                   expansion rather than one extra protein. The 1.4 is
 *                                   headroom for what a player cannot realise: travel
 *                                   time, a hopper that stalls while you are elsewhere,
 *                                   and the fact that a deposit at full richness regrows
 *                                   nothing at all.
 *
 *   reserve_i  = regrowth_i x 600   ten minutes of its own regrowth, which is one foraging
 *                                   circuit of the five deposits. So a deposit refills to
 *                                   full in exactly the time it takes you to go round and
 *                                   come back, and arriving early means arriving at a
 *                                   pocket that is not ready yet.
 *
 * That second identity is the useful one: it ties deposit size to circuit time, so the
 * map's pacing follows from how far apart the deposits are rather than from a tuned
 * number. §10A.2's "reason to leave a depleting patch" survives intact — you still strip
 * a pocket and move on. What changes is that moving on is now a rotation rather than a
 * one-way march to an empty map.
 */
interface ResidueEconomy { demand: number; regrowth: number; reserve: number }
const REGROWTH_HEADROOM = 1.4;
/** Seconds to tour all five deposits and return — the circuit a reserve is sized to. */
const CIRCUIT = 600;
/**
 * §9.5's ribosomes replace a protein when it falls to REPAIR_AT rather than when it dies,
 * so a protein lives `1 - REPAIR_AT` of its nominal span and demand rises by the inverse.
 *
 * Derived rather than folded into the measured figures below, because the two are
 * independent: the measurements are what §9.4's decay costs, and this is what §9.5's
 * policy costs on top. Pre-emptive repair is a 33% standing increase in the cell's
 * material budget, which is a real price for never running degraded machinery, and it
 * should be visible as a term rather than buried in a re-measured constant.
 */
const PREEMPTION = 1 / (1 - REPAIR_AT);
function economy(measuredDemand: number): ResidueEconomy {
  const demand = measuredDemand * PREEMPTION;
  const regrowth = demand * REGROWTH_HEADROOM;
  return { demand, regrowth, reserve: Math.round(regrowth * CIRCUIT) };
}
/**
 * Measured replacement demand per residue, from the standing build-out above, running
 * proteins all the way to zero. `economy` scales for §9.5's earlier replacement.
 */
export const RESIDUE_ECONOMY = {
  gly: economy(0.194),
  leu: economy(0.139),
  lys: economy(0.155),
  ala: economy(0.131),
  val: economy(0.099),
} as const;

/**
 * Glucose regrowth, in particles/s. Reproduces the OLD flat-rate behaviour exactly
 * (0.00004 of richness per second x each pocket's reserve), because the glucose run-down
 * was measured and tuned — richness 0.74 at 2 min, 0.48 at 4 min, empty by 8 — and this
 * change is about residues. Written out as absolute rates so the two economies are
 * comparable on the page rather than hidden behind one shared constant.
 */
const GLUCOSE_REGROWTH = 0.00004;
/**
 * Measured run-down of the home pocket under a full economy (channel + 3 enzymes +
 * carrier), sitting still: richness 0.74 at 2 min, 0.48 at 4 min, 0.22 at 6 min, empty by
 * 8 min. The pocket visibly empties over a play session rather than over ten minutes of
 * nothing happening.
 *
 * WHAT THIS DOES NOT DO, recorded because it was measured and is easy to assume otherwise:
 * it does not starve the cell. ATP sits at its 448 ceiling throughout, because upkeep is
 * 1.8/s while three enzymes gross ~21/s — the cell is over-provisioned more than tenfold,
 * so supply must fall below ~8%% before ATP moves at all. Depletion makes the pocket
 * visibly empty; it does not by itself make leaving necessary. That needs an ATP sink
 * large enough to matter (§14: growth, division, a bigger body) and does not exist yet.
 */
export const PATCH_DEPLETION = 0.0012;

export class PatchField {
  readonly patches: Patch[] = [];

  /** Concentration of one species at a world point, summed over patches. */
  sample(worldX: number, worldY: number, species: SpeciesId): number {
    let sum = 0;
    for (const p of this.patches) {
      if (p.species !== species) continue;
      const dx = worldX - p.x;
      const dy = worldY - p.y;
      const d2 = dx * dx + dy * dy;
      const r2 = p.radius * p.radius;
      if (d2 > r2 * 9) continue; // beyond 3 sigma contributes nothing visible
      sum += p.peak * p.richness * Math.exp(-d2 / (2 * r2));
    }
    return sum;
  }

  /**
   * The strongest peak any patch of this species has, for normalising a gradient.
   *
   * Sensing has to compare like with like. A residue deposit peaks around 0.07 (scaled to
   * the cell's interior) while the hostile lactate zone peaks at 2.0, so subtracting one
   * from the other let the repellent outweigh the attractant roughly FORTY TO ONE — the
   * cell could not approach lysine at all, it fled. Absolute concentrations of different
   * species are not comparable quantities; fractions of their own maxima are.
   */
  peakOf(species: SpeciesId): number {
    let peak = 0;
    for (const p of this.patches) {
      if (p.species === species && !p.hostile && p.peak > peak) peak = p.peak;
    }
    return peak || 1;
  }

  /** The strongest peak among hostile patches, for the same normalisation. */
  hostilePeak(): number {
    let peak = 0;
    for (const p of this.patches) if (p.hostile && p.peak > peak) peak = p.peak;
    return peak || 1;
  }

  /** Total hostile concentration at a point — what chemotaxis steers away from. */
  hostileAt(worldX: number, worldY: number): number {
    let sum = 0;
    for (const p of this.patches) {
      if (!p.hostile) continue;
      const dx = worldX - p.x;
      const dy = worldY - p.y;
      const d2 = dx * dx + dy * dy;
      const r2 = p.radius * p.radius;
      if (d2 > r2 * 9) continue;
      sum += p.peak * p.richness * Math.exp(-d2 / (2 * r2));
    }
    return sum;
  }

  /**
   * Draw down whatever the cell just took, and let everything else creep back.
   *
   * Depletion is attributed by proximity: the patch nearest the cell loses the most,
   * which is both physically sensible and the thing that makes "this pocket is running
   * out, move on" legible rather than an invisible global counter ticking down.
   */
  step(dt: number, cellX: number, cellY: number, importedBySpecies: Map<SpeciesId, number>): void {
    for (const [species, amount] of importedBySpecies) {
      if (amount <= 0) continue;

      // Attribute the draw-down by CONTRIBUTION SHARE, not by nearest-within-a-radius.
      //
      // The radius rule broke the moment the pockets got smaller: with sigma 13 and the
      // cell 40 tiles out, it sat at 3.08 sigma — just outside the old radius*3 window — so it ate
      // from the patch and depleted nothing at all, forever. Richness sat at 1.000 through
      // twelve simulated minutes of hard consumption.
      //
      // Sharing by contribution is both robust and more honest: you draw down whatever you
      // are actually drinking from, in proportion to how much of what reaches you came
      // from each pocket. Sitting between two patches drains both, and drifting toward one
      // shifts the load onto it without any special case.
      let totalShare = 0;
      const shares: Array<{ p: Patch; share: number }> = [];
      for (const p of this.patches) {
        if (p.species !== species || p.hostile) continue;
        const dx = p.x - cellX;
        const dy = p.y - cellY;
        const r2 = p.radius * p.radius;
        const share = p.peak * p.richness * Math.exp(-(dx * dx + dy * dy) / (2 * r2));
        if (share <= 1e-9) continue;
        shares.push({ p, share });
        totalShare += share;
      }
      if (totalShare <= 0) continue;

      for (const { p, share } of shares) {
        // Draw down by the FRACTION OF ITS OWN RESERVE taken, so a deposit empties when
        // its contents have been removed rather than after some globally tuned duration.
        // `amount` is what was imported THIS STEP and is already a per-step quantity —
        // multiplying by dt again would make depletion scale with dt squared.
        p.richness = Math.max(0, p.richness - (amount * (share / totalShare)) / p.reserve);
      }
    }
    // Regrowth is authored in PARTICLES per second, so converting to richness divides by
    // this patch's own reserve. That is the whole fix: the old form added a flat richness
    // increment, which silently made a big pocket regrow fast and a small one regrow at a
    // rate no player could ever observe.
    for (const p of this.patches) {
      if (p.richness >= 1 || p.regrowth <= 0) continue;
      p.richness = Math.min(1, p.richness + (p.regrowth / p.reserve) * dt);
    }
  }

  /**
   * The starting neighbourhood: the two pockets §12.1 already describes, plus reasons to
   * leave them. Deterministic — §3.7 makes the whole simulation replayable from a seed,
   * and terrain that differed per run would break that.
   */
  static intro(cx: number, cy: number): PatchField {
    const f = new PatchField();

    // §12.1's opening pockets, reproducing EXACTLY the profile the intro was tuned
    // against: peak 1.0 with sigma 18, centred 40 tiles out (the old hard-coded seeding
    // used `radius + 22`). Getting this wrong is not cosmetic — a first attempt put them
    // at 24 tiles with sigma 14, which raised the concentration at the membrane from 0.47
    // to 0.91. Import nearly doubled, glucose accumulated faster than it could be spent,
    // and the cell lysed partway through an arc it had always survived.
    //
    // Motility must not change what §12 feels like for a player who has not built a
    // flagellum, and "the environment is now terrain" is exactly the kind of change that
    // quietly re-tunes everything downstream of it.
    const HOME = 40;
    const HOME_SIGMA = 13;
    const HOME_PEAK = 2.0;
    f.patches.push({
      x: cx - HOME, y: cy, radius: HOME_SIGMA,
      species: SPECIES_ID.glucose, peak: HOME_PEAK, richness: 1,
      // The opening pocket, deliberately deep: 5200 units is 1300 glucose grains, roughly
      // forty minutes of a single channel drawing flat out. §12's arc should never be lost
      // to the ground running out from under it — scarcity is what the FAR deposits are
      // for (§5a.11), and the near one is meant to be the safe place you learn in.
      reserve: 1300, harvestRadius: 40, regrowth: 1300 * GLUCOSE_REGROWTH,
    });

    // ── The residue deposits, each somewhere of its own ────────────────────────
    //
    // THE BUG THIS FIXES. All five used to sit at exactly (cx + 40, cy) with identical
    // radius and peak — one undifferentiated amino blob. So there was no such place as
    // "where the glycine is", and "go and get gly" was not merely hard, it was
    // structurally impossible: every residue was in the same spot, so no journey could
    // ever be about one of them. §5's typed residues had a typed BILL and an untyped MAP.
    //
    // Each residue now has its own location, its own distance, and its own direction. That
    // is what makes a shortage a destination — and it is also the answer to §10A.6, which
    // could not find a reason to move while looking at the energy economy. The reason to
    // travel is not ATP (the pool sits at its ceiling regardless); it is MATERIALS. Glucose
    // is everywhere. Lysine is somewhere. That is the ore-patch structure this game's
    // lineage runs on, and it wants specific places on a map.
    //
    // Ordered so scarcity and distance agree: the residues §12.3 squeezes you on are the
    // ones you have to travel for. gly and ala are common and close; lys is the scarcest
    // and the farthest, and the protein that fixes a lysine shortage costs lysine.
    // Peak is a CONCENTRATION and has to be scaled against the cell's interior, not against
    // the glucose pockets. The interior runs a residue at roughly 0.007 (a ~6-unit stock
    // over ~900 of volume), so a peak of 3.0 was a gradient of four hundred to one: a
    // single transporter aimed at it delivered 200 units in a minute, thirty times the
    // entire starting stock, and the deposit barely dimmed. 0.08 is an order of magnitude
    // above the interior — a strong, obvious gradient — without being a firehose.
    //
    // ── HOW MUCH each holds is no longer authored here ─────────────────────
    // Reserve and regrowth both come from RESIDUE_ECONOMY, derived from measured
    // replacement demand. Only WHERE a deposit is and how obvious it looks are placement
    // decisions; how much is in it is arithmetic against §9.4, and writing it by hand is
    // what produced a map holding six minutes of amino acid.
    const DEPOSITS: Array<{
      t: AminoDepositType; x: number; y: number; r: number; peak: number;
    }> = [
      // ── PLACED AGAINST THE VIEWPORT, not just against the fiction ───────────
      //
      // The previous layout ordered these purely by scarcity — 60 to 132 tiles out — and
      // every single one landed OUTSIDE THE VISIBLE WINDOW. The view is the 96x96 grid
      // centred on the cell, so the player can see about +/- 48 tiles; a deposit at 60 is
      // permanently off the edge. "Where are the deposits, I can't see them" was exactly
      // right, and no amount of labelling them helps when they are not on screen.
      //
      // So the ring is now built from the viewport outwards:
      //   ~30-44 tiles  visible at the default zoom. These teach the mechanic: you can
      //                 see a named deposit, aim a transporter at it, and watch it drain.
      //   ~70-85 tiles  off the edge until you move or zoom out. These are the journey,
      //                 and they are the scarce residues, so §12.3's squeeze is what
      //                 sends you.
      //
      // The rule worth keeping: a destination the player cannot see is not a destination,
      // it is a rumour. Place things relative to what is on screen, then check.
      { t: 'gly', x: cx + 26, y: cy - 14, r: 11, peak: 0.09 }, // touches the cell: harvestable from spawn
      { t: 'ala', x: cx + 24, y: cy + 44, r: 11, peak: 0.08 }, // visible; a short swim
      { t: 'leu', x: cx - 45, y: cy + 20, r: 11, peak: 0.08 }, // visible; a short swim
      { t: 'val', x: cx + 70, y: cy - 40, r: 12, peak: 0.07 }, // a trip
      { t: 'lys', x: cx - 88, y: cy - 20, r: 12, peak: 0.07 }, // the journey — clear of the toxic zone
    ];
    for (const d of DEPOSITS) {
      const e = RESIDUE_ECONOMY[d.t];
      f.patches.push({
        x: d.x, y: d.y, radius: d.r, species: SPECIES_ID[d.t], peak: d.peak, richness: 1,
        reserve: e.reserve,
        regrowth: e.regrowth,
        harvestRadius: Math.round(d.r * 2.2),
      });
    }

    // Further out: a richer glucose field worth crossing to, which is the whole argument
    // for building a flagellum. It has to be BETTER than home or exploration is a tax.
    f.patches.push({ x: cx + 4, y: cy - 95, radius: 22, species: SPECIES_ID.glucose, peak: 2.4, richness: 1, reserve: 1950, harvestRadius: 48, regrowth: 1950 * GLUCOSE_REGROWTH });
    f.patches.push({ x: cx - 110, y: cy + 40, radius: 20, species: SPECIES_ID.glucose, peak: 1.9, richness: 1, reserve: 1500, harvestRadius: 44, regrowth: 1500 * GLUCOSE_REGROWTH });

    // And something to avoid, so the sensing loop has a sign as well as a direction.
    // Nothing harvests it, so it neither depletes nor regrows.
    f.patches.push({
      x: cx - 40, y: cy - 62, radius: 16,
      species: SPECIES_ID.lactate, peak: 2.0, richness: 1, hostile: true, reserve: 1e9,
      harvestRadius: 36, regrowth: 0,
    });
    return f;
  }
}
