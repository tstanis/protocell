/**
 * Membrane transport. SPEC.md §6.
 *
 * A membrane tile is a GATE, not a tank (§4.2): it holds no solute pool, it mediates
 * flux between its inner and outer neighbours. If it were an ordinary diffusion tile it
 * would buffer solute with a lag and leak to both sides, dissolving the very gradients
 * that are the whole game.
 *
 * The three building tiers (§6.1–6.5) are a BUILDING-TIER DECISION, NOT A STRICT
 * UPGRADE — which tool is right depends on what else you have built, especially whether
 * circulation downstream keeps the far side clear.
 *
 * The one rule everything passive obeys (§6.1, called mandatory):
 *   net flux ∝ gradient, reaching ZERO at equilibrium and REVERSING past it.
 * A transporter that moves cargo at a constant rate regardless of concentration — even
 * uphill — is not passive. That is a pump, and the constant rate is what ATP buys.
 *
 * `cell_prototype.html` fails this: its "channel" gates on geometry with no gradient
 * term and clamps interior particles in, so it can never reflux. By §6.1's own test it
 * is a free pump (§16.2). The tests in test/transport.test.ts are written so that
 * implementation could not pass.
 */

import {
  K_CARRIER,
  P_BILAYER_DEFAULT,
  P_BILAYER_GAS,
  P_CHANNEL_GLUCOSE,
  VMAX_CARRIER_LACTATE,
} from './constants.js';
import { Grid, Role } from './grid.js';
import { SPECIES_ID, type SpeciesId } from './species.js';
import type { Perishable } from './denature.js';

export type TransporterKind = 'channel' | 'carrier' | 'pump';

export interface Transporter extends Perishable {
  kind: TransporterKind;
  species: SpeciesId;
  /**
   * §6.3 — a channel "can be gated open/closed". A shut transporter passes nothing but
   * the bare bilayer leak, which is what lets a player stop importing something they are
   * drowning in. Gating is a conformational change: free, instant, and reversible.
   */
  closed?: boolean;
  /** Channel: permeability. Carrier: the k in k*(c_in-c_out) below Vmax. */
  p: number;
  /** Carrier only — the hard ceiling (§6.4). Its fixed quantity is its CEILING, not its throughput. */
  vmax?: number;
  /** Pump only — fixed rate, and +1/-1 for outward/inward (§6.5). */
  rate?: number;
  direction?: 1 | -1;
  /** Pump only — ATP consumed per unit moved. */
  atpPerUnit?: number;
  /**
   * Signed flux actually delivered on the last step, in amount/second, positive = export.
   *
   * Recorded because §6.1's central lesson is invisible without it: "a passive transporter
   * looks SLOW near equilibrium and FAST with a steep gradient — because net flux literally
   * depends on the gradient, not because its intrinsic speed changed." A player who cannot
   * see the rate cannot learn that, and cannot tell a working channel from a stalled one.
   */
  lastFlux?: number;
}

/** §6.3. Cheap, gateable, very high throughput, uncapped, symmetric — and leaky. */
export function channel(species: SpeciesId, p = P_CHANNEL_GLUCOSE): Transporter {
  return { integrity: 1, kind: 'channel', species, p };
}

/**
 * §6.4. Slow and saturable, but with a superpower a channel physically cannot match:
 * because it BINDS its cargo it can move two things per cycle (symport/antiport) and
 * drag one uphill on another's gradient for free. Coupling is not modelled yet — see
 * the note at the bottom of this file.
 */
export function carrier(
  species: SpeciesId,
  vmax = VMAX_CARRIER_LACTATE,
  p = K_CARRIER,
): Transporter {
  return { integrity: 1, kind: 'carrier', species, p, vmax };
}

/** §6.5. Fixed rate across ANY gradient including uphill, and it costs ATP per cycle. */
export function pump(
  species: SpeciesId,
  rate: number,
  direction: 1 | -1,
  atpPerUnit: number,
): Transporter {
  return { integrity: 1, kind: 'pump', species, p: 0, rate, direction, atpPerUnit };
}

/**
 * Signed flux in amount-per-second, positive = inner → outer (export).
 *
 * Split out from `applyTransport` so the tests can assert the LAW directly — that it
 * hits exactly zero at equilibrium and changes sign past it — without needing a grid.
 */
export function fluxOf(t: Transporter, cIn: number, cOut: number, atpAvailable: boolean): number {
  const grad = cIn - cOut;

  switch (t.kind) {
    case 'channel':
      // Signed, uncapped, symmetric. Refluxes hard and fast the instant the gradient
      // reverses — it slams to equilibrium and twitches around it (§6.3). Correct tool
      // ONLY when circulation downstream guarantees the gradient stays steep.
      return t.p * grad;

    case 'carrier': {
      // Saturating. Below the ceiling, delivered flux still scales with gradient and
      // still dies at equilibrium — the ceiling is a ceiling, not a throughput (§6.4).
      // Piecewise-linear cap is the acceptable stand-in for Michaelis-Menten §6.4 allows.
      const vmax = t.vmax ?? VMAX_CARRIER_LACTATE;
      const raw = t.p * grad;
      if (grad > 0) return Math.min(vmax, raw);
      // Gentle reverse: a shuttle refluxes far more softly than an open pore, which is
      // most of why you would accept its lower ceiling.
      return Math.max(-vmax * 0.2, raw);
    }

    case 'pump': {
      // §6.5 / §2.3. This is the one that pays rent on staying un-equilibrated, every
      // tick, forever. Throttles when ATP is low — and when the grid browns out, pumps
      // stop, gradients slump, and the organism dies the way real cells die.
      if (!atpAvailable) return 0;
      const rate = t.rate ?? 0;
      const dir = t.direction ?? 1;
      return rate * dir;
    }
  }
}

/** Bare lipid bilayer permeability for a species with no transporter embedded (§6.2). */
export function bilayerP(species: SpeciesId): number {
  return species === SPECIES_ID.o2 || species === SPECIES_ID.co2
    ? P_BILAYER_GAS
    : P_BILAYER_DEFAULT;
}

/**
 * §3.3's clamp, the one the spec says "appears in the Fick and transport code".
 *
 * Equilibrium is equal CONCENTRATION, not equal amount (§7.1). Two tiles of volumes
 * vIn and vOut sharing a total T equilibrate at `aIn = T*vIn/(vIn+vOut)`, so the largest
 * transfer that does not CROSS equilibrium is the distance to that split. For equal
 * volumes this reduces to half the difference, as you would expect.
 *
 * Without this, a large P plus a large dt overshoots, oscillates, and explodes — and the
 * failure looks like a working simulation for a few seconds first.
 */
export function clampToEquilibrium(
  transfer: number,
  aIn: number,
  aOut: number,
  vIn = 1,
  vOut = 1,
): number {
  const total = aIn + aOut;
  const eqIn = (total * vIn) / (vIn + vOut);
  const maxMove = aIn - eqIn;
  if (maxMove >= 0) return Math.min(transfer, Math.max(0, maxMove));
  return Math.max(transfer, Math.min(0, maxMove));
}

export interface TransportResult {
  /** Total ATP consumed by pumps this step. */
  atpSpent: number;
}

/**
 * Apply every embedded transporter, plus bare-bilayer leak, across every membrane tile.
 *
 * Amounts move directly between the membrane tile's inner and outer FLUID neighbours —
 * the membrane itself never holds any of it (§4.2).
 */
export function applyTransport(
  grid: Grid,
  transporters: ReadonlyMap<number, Transporter>,
  species: readonly SpeciesId[],
  dt: number,
  atpAvailable: boolean,
  /**
   * Tile volume per compartment id (§7.1). Defaults to 1 everywhere, which is correct
   * only while every compartment is at rest volume — pass real values once the cell can
   * swell, or transport will keep using amounts as if they were concentrations and the
   * dilution coupling will silently do nothing.
   */
  tileVolume?: ReadonlyMap<number, number>,
): TransportResult {
  const { role, inward, outward, edgeArea, compartment } = grid;
  let atpSpent = 0;
  const volOf = (i: number): number => tileVolume?.get(compartment[i]!) ?? 1;

  for (let i = 0; i < grid.tileCount; i++) {
    if (role[i] !== Role.MEMBRANE) continue;
    const inI = inward[i]!;
    const outI = outward[i]!;
    if (inI < 0 || outI < 0) continue;

    const vIn = volOf(inI);
    const vOut = volOf(outI);
    const t = transporters.get(i);
    // §6.2's Fick has an area term, and a corner tile genuinely faces outward on more
    // than one edge. Without this, a wrinkled boundary would silently under-count its
    // own intake — and §17.5's "flatten/wrinkle to pack surface" escape would be
    // cosmetic rather than a real way to buy flux.
    const area = edgeArea[i] || 1;

    for (const s of species) {
      const aIn = grid.get(s, inI);
      const aOut = grid.get(s, outI);
      // §7.1: volume is the denominator of concentration. Transport is driven by
      // concentration difference, so a swollen compartment exports more slowly for no
      // other reason than that it diluted itself — which is the seed of §10.3's doom
      // spiral, and it falls out of this division rather than being scripted.
      const cIn = aIn / vIn;
      const cOut = aOut / vOut;

      let rate: number;
      if (t !== undefined && t.species === s && !t.closed) {
        rate = fluxOf(t, cIn, cOut, atpAvailable) * area;
      } else {
        // No transporter for this species: the bare bilayer. Near-zero for anything
        // polar, high for the gases (§6.2). "The tile is the wall; its outward-facing
        // edge is the valve" (§4.2) — with no valve fitted, it is just wall.
        rate = bilayerP(s) * (cIn - cOut) * area;
      }

      if (rate === 0) continue;

      let move = rate * dt;

      // A pump may legitimately push uphill, so it is exempt from the equilibrium clamp
      // — that exemption IS the thermodynamic distinction §6.6 wants the player to feel.
      // It still may not drive a tile negative.
      if (t !== undefined && t.kind === 'pump' && t.species === s) {
        move = move > 0 ? Math.min(move, aIn) : Math.max(move, -aOut);
        atpSpent += Math.abs(move) * (t.atpPerUnit ?? 0);
      } else {
        move = clampToEquilibrium(move, aIn, aOut, vIn, vOut);
      }

      // Record what this transporter actually delivered, so the renderer can show a rate
      // rather than leaving the player to infer it from a slowly changing HUD number.
      if (t !== undefined && t.species === s) t.lastFlux = move / dt;

      if (move === 0) continue;
      grid.add(s, inI, -move);
      grid.add(s, outI, move);
    }
  }

  return { atpSpent };
}

/*
 * Not yet implemented, deliberately, and recorded here so it is not mistaken for done:
 *
 * COUPLED TRANSPORT (§6.4) — the carrier's real superpower. Because it binds its cargo,
 * one cycle can move two species, using one gradient to drag another uphill for free
 * (secondary active transport): couple to the Na⁺ gradient to import glucose against its
 * own gradient with no ATP. The real lactate carrier (MCT) co-exports a proton with each
 * lactate, clearing waste and acid in one cycle — which is exactly where §10.5's deferred
 * pH layer plugs in.
 */

// ── Discrete transport (§5a) ─────────────────────────────────────────────────

/**
 * What `applyGrainTransport` needs from the interior. Kept as an interface so transport
 * does not import the grain store, and so the LAW below can be tested against a stub.
 */
export interface GrainSide {
  /**
   * Smoothed interior concentration near a membrane tile.
   *
   * Smoothed, not point-sampled, and this is the single most important consequence of
   * going discrete. With ~16 glucose grains spread over 896 interior tiles, the specific
   * 1×1 tile inside any given membrane tile is empty almost always — so a point sample
   * reads zero, sees a huge gradient, and imports without limit. A membrane patch
   * responds to the local BULK concentration, which is what this returns.
   */
  innerConc(species: SpeciesId, tile: number): number;
  /** Total of a species held as grains, for the equilibrium clamp. */
  innerTotal(species: SpeciesId): number;
  /** Remove up to `want` units from grains near a membrane tile. Returns what was taken. */
  takeNear(species: SpeciesId, tile: number, want: number): number;
  /**
   * Add `amount` units just inside a membrane tile, minting whole grains and carrying the
   * remainder forward. Fractional imports MUST accumulate rather than round: a channel
   * delivering 0.3 of a grain per tick has to produce a grain every fourth tick, not
   * either zero forever or one every tick.
   */
  giveNear(species: SpeciesId, tile: number, amount: number): void;
}

/**
 * Transport for species carried as grains.
 *
 * Deliberately a separate pass from `applyTransport` rather than a branch inside it: the
 * two representations differ in how quantity is *stored*, not in how flux is *computed*,
 * and both call the same `fluxOf`. Keeping the law in one function is what lets
 * test/transport.test.ts assert §6.1 once and have it bind for both.
 */
export function applyGrainTransport(
  grid: Grid,
  transporters: ReadonlyMap<number, Transporter>,
  species: readonly SpeciesId[],
  side: GrainSide,
  dt: number,
  atpAvailable: boolean,
  outerVolume: number,
): TransportResult {
  const { role, inward, outward, edgeArea } = grid;
  let atpSpent = 0;

  for (let i = 0; i < grid.tileCount; i++) {
    if (role[i] !== Role.MEMBRANE) continue;
    const outI = outward[i]!;
    if (inward[i]! < 0 || outI < 0) continue;

    const t = transporters.get(i);
    const area = edgeArea[i] || 1;

    for (const s of species) {
      const cIn = side.innerConc(s, i);
      const aOut = grid.get(s, outI);
      const cOut = aOut / outerVolume;

      let rate: number;
      if (t !== undefined && t.species === s && !t.closed) {
        rate = fluxOf(t, cIn, cOut, atpAvailable) * area;
      } else {
        rate = bilayerP(s) * (cIn - cOut) * area;
      }
      if (rate === 0) continue;

      let move = rate * dt; // positive = out of the cell
      if (t !== undefined && t.kind === 'pump' && t.species === s) {
        move = move > 0 ? Math.min(move, side.innerTotal(s)) : Math.max(move, -aOut);
        atpSpent += Math.abs(move) * (t.atpPerUnit ?? 0);
      } else {
        // The clamp needs amounts on both sides in the same units. The interior "amount"
        // is the whole grain population, because grains are not confined to one tile.
        move = clampToEquilibrium(move, side.innerTotal(s), aOut, 1, 1);
      }
      if (move === 0) continue;

      if (move > 0) {
        // Export: consume grains near this patch and hand the quantity to the bath.
        const took = side.takeNear(s, i, move);
        if (took <= 0) continue;
        grid.add(s, outI, took);
        if (t !== undefined && t.species === s) t.lastFlux = took / dt;
      } else {
        // Import: take from the bath, accumulate inside, mint grains as they add up.
        const want = Math.min(-move, aOut);
        if (want <= 0) continue;
        grid.add(s, outI, -want);
        side.giveNear(s, i, want);
        if (t !== undefined && t.species === s) t.lastFlux = -want / dt;
      }
    }
  }

  return { atpSpent };
}
