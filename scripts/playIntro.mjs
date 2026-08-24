/**
 * Play the §12 intro against a LIVE server, over the real socket, AS THE NANOBOT.
 *
 * This is the end-to-end smoke test, and it exercises the thing that makes the game a
 * game rather than a physics demo: §9.2's construction pipeline. It drives the avatar to
 * the nucleus, takes a blueprint, walks the residues into a chain one 4-ATP bond at a
 * time, waits for the fold, and carries the folded protein to where it belongs.
 *
 *   npm run server        # in one terminal
 *   npm run play-intro
 */

import { WebSocket } from 'ws';

const URL = process.env.URL ?? 'ws://localhost:8787';

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';

let s = null;
let hello = null;
let frames = 0;

const send = (cmd) => ws.send(JSON.stringify({ t: 'command', cmd }));
const wait = (sec) => new Promise((r) => setTimeout(r, sec * 1000));

/** Wait until `pred(scalars)` holds, or give up. */
async function until(pred, label, timeoutSec = 40) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (s && pred(s)) return true;
    await wait(0.1);
  }
  console.log(`    !! timed out waiting for ${label}`);
  return false;
}

function line(label) {
  if (!s) return;
  console.log(
    `  ${label.padEnd(38)} ATP ${s.atp.toFixed(1).padStart(6)}   ` +
      `vol ${s.volume.toFixed(0).padStart(5)}   tension ${s.tension.toFixed(3)}`,
  );
}

let lastBleb = 0;

ws.on('message', (raw, isBinary) => {
  if (isBinary) { frames++; return; }
  const m = JSON.parse(String(raw));
  if (m.t === 'scalars') s = m;
  else if (m.t === 'hello') hello = m;
  else if (m.t === 'event' && m.kind === 'lysed') console.log('  !! LYSED');

  // The third act (§10.4). A player watching the tension meter climb past 0.8 reaches for
  // the bleb button; a script that never does is not playing the game it is testing. The
  // first run without this lysed mid-build — which is the correct punishment for ignoring
  // a warning the simulation had been showing for a minute.
  if (m.t === 'scalars' && !m.lysed && m.tension > 0.8 && Date.now() - lastBleb > 5000) {
    lastBleb = Date.now();
    console.log(`    tension ${m.tension.toFixed(2)} — BLEB (shed volume to survive)`);
    send({ op: 'bleb' });
  }
});

/** Walk the bot to a point and wait until it stops there. */
async function goTo(x, y, label) {
  send({ op: 'moveTo', x, y });
  await until((sc) => Math.hypot(sc.bot.x - x, sc.bot.y - y) < 1.5, `arrival at ${label}`);
}

/** Run the whole §9.2 pipeline for one gene, deploying at `deployAt` (or in place). */
async function buildProtein(geneId, deployAt) {
  console.log(`\n  building ${geneId}`);

  await goTo(s.nucleus.x, s.nucleus.y, 'the nucleus');
  send({ op: 'selectGene', gene: geneId });
  if (!(await until((sc) => sc.build.phase === 'assembling', 'blueprint'))) return false;
  console.log(`    blueprint taken: ${s.build.sequence.join('-')}  (${s.build.atpCost} ATP)`);

  // Assemble. If it blocks on a residue, walk toward the amino-acid face and try again —
  // which is exactly what a player does, and why the bot has a position at all.
  let nudges = 0;
  const done = await until(
    (sc) => {
      if (sc.build.phase !== 'assembling') return true;
      if (sc.build.blockedOn?.reason === 'atp' && nudges % 20 === 0) { nudges++; console.log('    blocked on ATP — waiting'); return false; }
      if (sc.build.blockedOn?.reason === 'residue' && nudges < 6) {
        nudges++;
        const ang = 0; // the amino-acid face
        send({
          op: 'moveTo',
          x: hello.worldWidth / 2 + Math.cos(ang) * (sc.radius - 3),
          y: hello.worldHeight / 2 + Math.sin(ang) * (sc.radius - 3),
        });
        console.log(`    blocked on ${sc.build.blockedOn.residue} — walking to the amino face`);
      }
      return false;
    },
    'assembly',
    90,
  );
  if (!done) return false;

  if (!(await until((sc) => sc.build.phase === 'carrying', 'fold'))) return false;
  console.log('    folded');

  if (deployAt) {
    await goTo(deployAt.walkX, deployAt.walkY, 'the deploy site');
    if (deployAt.tile === undefined) {
      // An enzyme is a free agent released into the soup — but WHERE still matters. The
      // first run of this script released it wherever the bot had last wandered to fetch
      // a residue, which was right beside the amino face and half a cell away from its
      // glucose supply. It starved, ATP never recovered, and the run died. That is §4.7's
      // lesson arriving unprompted, and the fix is the one the spec predicts: put the
      // consumer near its supply.
      send({ op: 'deploy' });
    } else {
      // Try the computed tile, then its immediate ring neighbours — discretising a circle
      // means the exact index can land a tile off, and the server is the authority on
      // which tiles are actually membrane.
      for (const off of [0, 1, -1, hello.worldWidth, -hello.worldWidth, 2, -2]) {
        send({ op: 'deploy', tile: deployAt.tile + off });
        await wait(0.35);
        if (s.build.phase === 'idle') break;
      }
    }
  } else {
    send({ op: 'deploy' });
  }
  const ok = await until((sc) => sc.build.phase === 'idle', 'deploy', 8);
  console.log(ok ? '    deployed' : '    deploy FAILED');
  return ok;
}

/**
 * A membrane tile on the given face, plus a spot just inside it for the bot to stand.
 *
 * Two details that matter and cost a debugging round: the bot is confined to the
 * cytoplasm, so it can never stand ON the membrane and has to work from just inside; and
 * tiles are classified by their CENTRE (tx + 0.5), so the tile index has to be derived
 * from the centre rather than by flooring a point on the ring.
 */
function membraneTarget(angle) {
  const cx = hello.worldWidth / 2;
  const cy = hello.worldHeight / 2;
  const centreX = cx + Math.cos(angle) * (hello.cellRadius - 0.5);
  const centreY = cy + Math.sin(angle) * (hello.cellRadius - 0.5);
  const tx = Math.round(centreX - 0.5);
  const ty = Math.round(centreY - 0.5);
  return {
    tile: ty * hello.worldWidth + tx,
    // Stand ~2.5 tiles inside, comfortably within the server's 3-tile seating reach.
    walkX: cx + Math.cos(angle) * (hello.cellRadius - 2.5),
    walkY: cy + Math.sin(angle) * (hello.cellRadius - 2.5),
  };
}

ws.on('open', async () => {
  await wait(0.6);
  console.log(`connected to ${URL} — world ${hello.worldWidth}x${hello.worldHeight}, protocol v${hello.protocolVersion}\n`);

  const ids = Object.entries(hello.species).filter(([, n]) =>
    ['glucose', 'atp', 'lactate', 'gly', 'leu', 'lys', 'ala', 'val'].includes(n),
  ).map(([id]) => Number(id));
  ws.send(JSON.stringify({
    t: 'subscribe',
    view: { x: 0, y: 0, w: hello.worldWidth, h: hello.worldHeight, lod: 1, species: ids },
  }));
  await wait(1);
  line('start');
  console.log(`  residue pool: ${Object.entries(s.residues).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`);

  console.log('\n§12.2 Act 1 — hand-build the glucose channel and seat it on the glucose face');
  const gluFace = membraneTarget(Math.PI);
  if (!(await buildProtein('glucoseChannel', gluFace))) { fail(); return; }
  await wait(8);
  line('glucose channel seated, +8s');
  console.log('    ^ ATP still falling: raw glucose is not energy yet.');

  console.log('\n§12.3 Act 2 — hand-build the glycolysis enzyme, and place it NEAR its supply');
  const nearGlucose = {
    walkX: hello.worldWidth / 2 + Math.cos(Math.PI) * (hello.cellRadius - 4),
    walkY: hello.worldHeight / 2 + Math.sin(Math.PI) * (hello.cellRadius - 4),
    tile: undefined, // an enzyme is released into the cytoplasm, not seated in the wall
  };
  if (!(await buildProtein('glycolysisEnzyme', nearGlucose))) { fail(); return; }
  await wait(45);
  line('enzyme running, +25s');
  console.log('    ^ the ATP curve turned around. Now the waste.');

  await wait(35);
  line('...+35s more');

  // WASTE FIRST. §12.3 lists the amino-acid transporter before the lactate carrier, which
  // reads sensibly but is the wrong order for the physics: from the moment the enzyme
  // runs, lactate accumulates at 7 units a second and tension climbs the whole time you
  // are building anything else. Doing the transporter first cost ~90 s of swelling and
  // the cell lysed mid-build. The carrier is urgent; the supply line is merely important.
  console.log('\n§12.3 — waste first: two lactate carriers, flanking the enzyme');
  const beforeVol = s.volume;
  const beforeTension = s.tension;
  // THREE, not two. Two hold the line; three actually drain it (132 → 47 over a minute in
  // the placement sweep). And the amino-acid transporter built next adds its own osmotic
  // load as it imports, so "just keeping up" is not enough to bring the cell back down.
  for (const a of [Math.PI - 0.5, Math.PI + 0.5, Math.PI - 1.0]) {
    const face = membraneTarget(a);
    if (!(await buildProtein('lactateCarrier', face))) { fail(); return; }
  }
  await wait(60);
  line('three carriers seated, +60s');

  console.log('\n§12.3 — now the supply line: the amino-acid transporter');
  const aminoFace = membraneTarget(0);
  if (!(await buildProtein('aminoTransporter', aminoFace))) { fail(); return; }
  await wait(20);
  line('amino transporter seated, +20s');
  console.log(`    residue pool: ${Object.entries(s.residues).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`);

  const lacNow = Object.keys(s.residues).length ? s.lysed : false;
  const deflated = s.tension < beforeTension || s.volume < beforeVol;
  console.log(
    `    ^ volume ${beforeVol.toFixed(0)} -> ${s.volume.toFixed(0)}, ` +
      `tension ${beforeTension.toFixed(3)} -> ${s.tension.toFixed(3)}`,
  );

  console.log(`\n${frames} binary field frames received. lysed=${s.lysed}`);
  console.log(`residue pool now: ${Object.entries(s.residues).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')}`);
  const ok = !s.lysed && deflated;
  console.log(ok ? '\nintro arc OK — every protein hand-assembled by the nanobot' : '\nintro arc FAILED');
  ws.close();
  process.exit(ok ? 0 : 1);
});

function fail() {
  console.log('\nintro arc FAILED');
  ws.close();
  process.exit(1);
}

ws.on('error', (e) => {
  console.error('connection failed:', e.message);
  console.error('is the server running?  npm run server');
  process.exit(1);
});
