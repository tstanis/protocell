/**
 * §9.6 — asking the ribosomes for a protein.
 *
 * The queue is what turns a ribosome from a repair crew into a factory. Before it, a
 * ribosome could only put back what had already been there.
 */

import { describe, expect, it } from 'vitest';
import { World, MAX_ORDERS } from '../src/world.js';
import { Ribosome } from '../src/ribosome.js';
import { AMINO_TYPES } from '../src/species.js';
import { SIM_DT } from '../src/constants.js';

function supplied(w: World, seconds: number): void {
  for (let i = 0; i < seconds / SIM_DT; i++) {
    w.energy.add(1000);
    for (const t of AMINO_TYPES) if (w.inventory.get(t) < 40) w.inventory.add(t, 40);
    w.step();
  }
}

function withRibosomes(): World {
  const w = new World();
  for (const a of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
    w.ribosomes.push(
      new Ribosome(w.grid.idx(Math.round(w.cx + Math.cos(a) * 9), Math.round(w.cy + Math.sin(a) * 9))),
    );
  }
  return w;
}

describe('§9.6 — the ribosome queue', () => {
  it('a queued protein gets built and lands in pending', () => {
    const w = withRibosomes();
    expect(w.queueProtein('glycolysisEnzyme').ok).toBe(true);
    expect(w.orders.length).toBe(1);

    supplied(w, 30);
    expect(w.orders.length).toBe(0);
    expect(w.pendingProteins.length).toBe(1);
    expect(w.pendingProteins[0]!.gene).toBe('glycolysisEnzyme');
  });

  it('carries the residue choice, which is where §5a.10 went wrong before', () => {
    // The gene is type-selectable; losing the choice between queueing and building would
    // silently make every ordered transporter a glycine one.
    const w = withRibosomes();
    w.queueProtein('aminoTransporter', 'lys');
    expect(w.orders[0]!.residue).toBe('lys');

    supplied(w, 30);
    expect(w.pendingProteins[0]!.residue).toBe('lys');

    expect(w.takePending(0).ok).toBe(true);
    expect(w.build.residue).toBe('lys');
  });

  it('a finished order is CARRIED, so the player still chooses where it goes', () => {
    const w = withRibosomes();
    w.queueProtein('glucoseChannel');
    supplied(w, 30);
    expect(w.pendingProteins.length).toBe(1);

    expect(w.takePending(0).ok).toBe(true);
    // Exactly the state hand assembly ends in — which is why deploy needs no new path.
    expect(w.build.phase).toBe('carrying');
    expect(w.bot.carrying).not.toBeNull();
    expect(w.pendingProteins.length).toBe(0);
  });

  it('refuses to hand you something while your hands are full', () => {
    const w = withRibosomes();
    w.queueProtein('glucoseChannel');
    w.queueProtein('glycolysisEnzyme');
    supplied(w, 60);
    expect(w.pendingProteins.length).toBeGreaterThan(1);

    expect(w.takePending(0).ok).toBe(true);
    const second = w.takePending(0);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/finish or cancel/);
  });

  it('REPAIRS OUTRANK ORDERS — a queue must not starve maintenance', () => {
    // The design claim, asserted: a cell that spends its last residues on what you asked
    // for while a glucose channel rots is obeying, not automating.
    //
    // ONE ribosome, so it is actually forced to choose. With three, two of them take the
    // order quite correctly — that is spare capacity, which is exactly what a queue is for
    // — and with a one-second window the repair also finishes inside it and the ribosome
    // moves on. Neither is a priority failure, and a test that cannot tell the difference
    // is not testing priority.
    const w = new World();
    w.buildGlucoseChannel();
    const tile = [...w.transporters.keys()][0]!;
    w.transporters.delete(tile);
    w.vacancies.push({ tile, gene: 'glucoseChannel', species: 0 });

    // Sited relative to the vacancy rather than at a guessed bearing: the glucose face is
    // wherever §12.1's pocket is, and a ribosome placed at a hardcoded angle covered
    // nothing, which made the test fail for a reason that had nothing to do with priority.
    const tx = tile % w.grid.width;
    const ty = Math.floor(tile / w.grid.width);
    w.ribosomes.push(
      new Ribosome(w.grid.idx(Math.round(w.cx + (tx - w.cx) * 0.5), Math.round(w.cy + (ty - w.cy) * 0.5))),
    );
    expect(w.coveredByRibosome(tile)).toBe(true); // the choice is real

    w.queueProtein('ribosome');
    supplied(w, 0.05);

    const job = w.ribosomes[0]!.job;
    expect(job).not.toBeNull();
    expect(job!.source).toBe('repair');
    expect(w.orders.length).toBe(1); // the order is untouched, still waiting
  });

  it('the queue is bounded, and says so rather than silently dropping', () => {
    const w = withRibosomes();
    for (let i = 0; i < MAX_ORDERS; i++) expect(w.queueProtein('glucoseChannel').ok).toBe(true);
    const over = w.queueProtein('glucoseChannel');
    expect(over.ok).toBe(false);
    expect(over.reason).toMatch(/holds/);
    expect(w.orders.length).toBe(MAX_ORDERS);
  });

  it('cancels by index, and refuses a nonsense one', () => {
    const w = withRibosomes();
    w.queueProtein('glucoseChannel');
    w.queueProtein('glycolysisEnzyme');
    expect(w.cancelOrder(0)).toBe(true);
    expect(w.orders[0]!.gene).toBe('glycolysisEnzyme');
    expect(w.cancelOrder(9)).toBe(false);
    expect(w.cancelOrder(-1)).toBe(false);
  });

  it('refuses a gene that does not exist', () => {
    const w = withRibosomes();
    expect(w.queueProtein('notAGene' as never).ok).toBe(false);
    expect(w.orders.length).toBe(0);
  });

  it('survives a save/restore, including saves written before the queue existed', () => {
    const w = withRibosomes();
    w.queueProtein('aminoTransporter', 'val');
    const snap = w.snapshot();

    const b = new World();
    b.restore(snap);
    expect(b.orders[0]).toEqual({ gene: 'aminoTransporter', residue: 'val' });

    // The old on-disk shape was a bare gene id. Migrated rather than refused, because a
    // version bump would tell live players their cell cannot be loaded.
    const legacy = { ...snap, orders: ['glucoseChannel'], pendingProteins: ['ribosome'] };
    const c = new World();
    c.restore(legacy as never);
    expect(c.orders[0]).toEqual({ gene: 'glucoseChannel', residue: null });
    expect(c.pendingProteins[0]).toEqual({ gene: 'ribosome', residue: null });
  });
});
