# PROTOCELL

A factory/automation game built out of cell biology — the player is a nanobot assembling
a living organism from the inside out. The full design is in [SPEC.md](SPEC.md); this file
is just how to run it.

The architecture's one unusual commitment: **the simulation is a standalone server** and
renderers are separate client processes that subscribe to views over WebSocket (SPEC §3.7).
That makes the spec's first principle — "numbers are truth; visuals are costume" — a
process boundary rather than a code-review rule. It also means the sim keeps ticking with
nobody watching, which is the literal thesis of §2.3.

## Run it

```bash
npm install

npm run server     # sim server on ws://localhost:8787 — ticks with 0 clients attached
npm run client     # renderer on http://localhost:5173
```

> If the server exits immediately with `EADDRINUSE`, an earlier one is still holding 8787
> and the browser will keep talking to *that* — old code, and changes that appear not to
> work. Same for vite silently moving to 5174/5175. On Windows:
> `Get-NetTCPConnection -LocalPort 8787 -State Listen | %{ Stop-Process -Id $_.OwningProcess -Force }`

### Controls

| | |
|---|---|
| click | walk the nanobot there |
| **click a grain** | **pick up a glucose or lactate grain** (§5a) — optional; useful for carrying fuel to a starving enzyme, but no build requires it |
| **residue chips** (under the blueprints) | choose which amino acid the next **amino-acid transporter** will import (§5, §6.7) — one gate tile per type |
| click a transporter | **gate it open or shut** (§6.3) — the cell's only self-regulation |
| click a membrane tile while carrying | walk over and seat the transporter *or flagellum* there. Only the highlighted tiles are offered — about 18% of the ring is buried wall that can host nothing (§4.2a) |
| double-click while carrying an enzyme | release it here (or use the button) |
| hover anything | what it is, and what it is doing |
| wheel | smooth zoom, anchored at the cursor |
| drag | pan |
| **right-click** | **swim that way** (§10A) — flagella on the opposite face fire |
| **Auto-seek** | **the cell picks its own destination** (§10A.9): it sorts the residue and glucose counts and heads for whichever is lowest. Picking a species by hand takes the wheel back |
| **Chemotaxis** button | hand steering to the cell: it senses the glucose gradient and climbs it |
| **Reset cell** | start over from nothing. Destructive and not undoable, so it arms on the first click and fires on the second |
| **Stop swimming** | coast. Thrust ends instantly and costs nothing — a cell has no momentum |

There is no reduced-motion setting: it was built and then removed (§11.7), because damping
the ooze made a healthy cell read as a dying one — stillness is how this game says death,
and a comfort toggle cannot share that axis.

The HUD corner shows fps, dot count, zoom and a **build stamp** — if that stamp is not the
time you last started vite, you are looking at a stale server serving old code.

## You are the nanobot

There is no build menu. §1.2 makes the player's avatar a general-purpose molecular
assembler — *which is what a ribosome is* — so at the start **you are the only assembler
the cell has**, and every protein is hand-made:

1. **Click to move.** The nanobot walks. Where it stands is where it works.
2. **Reach the nucleus** and take a blueprint. It will refuse from anywhere else.
3. **Assemble the chain**, one residue at a time. Each bond spends **one** typed amino acid
   from your inventory and 4 ATP from the cytoplasm around the bot. Residues are plain
   counts (§5b) — `lys 14` means you can place fourteen more lysines — so building works
   anywhere and the supply question is *"have I got any lysine"*, never *"where is it"*.
   ATP is still drawn locally, so a flat patch of cytoplasm still stalls you where you stand.
4. **Watch it fold.** The shape is the function.
5. **Carry it where it goes.** A transporter must be seated in a membrane tile you choose;
   an enzyme is released into the cytoplasm wherever you drop it. Both choices matter.

### The materials loop (§5b)

Amino acids are an **inventory**, not chemistry. Counts in the HUD, mined from deposits.

- **See it.** A strip of counts, one per residue, in that residue's own shape. Always on
  screen; never a function of zoom, camera, or cell volume. A blueprint shows `have/need`
  per type and reddens on the one blocking you.
- **Find it.** Each residue has its **own deposit** on the map, named, with the amount left
  and a **harvest ring**. Inside the ring it says *"in range"* and a transporter for that
  type draws from it; outside, the ring is dashed and nothing happens. Glycine overlaps the
  cell at spawn, so the loop teaches itself without travelling.
- **Get it.** A residue transporter is an **inserter**: in range it pulls whole residues at
  a rate and the deposit counts down. One glycine channel takes you 24 → 38 in the first
  minute while its deposit drops to 65%.
- **Move on.** Deposits are finite. Once glycine is stripped, ala and leu are a short swim
  and val and lys are a real journey — which is what a flagellum is for.

That is the answer to "why build a flagellum": not energy — ATP sits at its ceiling
regardless — but **materials**. Glucose is everywhere; lysine is somewhere.

Then play the §12 intro in that idiom: **glucose channel** → ATP still falls (raw glucose
is not energy) → **glycolysis enzyme**, placed near its supply → the ATP curve turns
around → lactate accumulates and tension climbs → **lactate carriers** (you need two, and
placement beats count) → the cell recovers. Close the browser tab mid-run and reopen it;
the simulation will have carried on without you.

Then **leave.** The pocket you started in is finite and you are drawing it down; build a
**flagellum** the same way and the outside turns from a backdrop into terrain. Thrust is
paid out of the same ATP field your peptide bonds are — one flagellum costs about half an
enzyme's output — so every second spent swimming is a second not spent building. That
trade is the whole of §10A.

## Signing in with Google (optional)

Without `GOOGLE_CLIENT_ID` the server runs exactly as it always has: anonymous, one cell,
no sign-in. Configure it and each Google account gets its own cell instead.

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create
   an **OAuth 2.0 Client ID** of type *Web application*.
2. Add an **Authorized redirect URI**. It must match byte for byte, including the port:

   ```
   http://localhost:8787/auth/callback
   ```

3. Put the credentials in a **`.env` at the repo root**:

   ```bash
   cp .env.example .env      # then fill in the two Google values
   ```

   The server loads it automatically (node's built-in `process.loadEnvFile` — no dotenv
   dependency). `.env` is gitignored; `.env.example` is the committed template and is the
   only place the full list of variables is documented.

   Anything already set in the real environment wins over the file, so a deployed
   platform's own secrets are never overridden by a `.env` that happened to ship.

   You do **not** need the Google Cloud *project id* anywhere — the client id and secret
   are the only things this server uses.

| variable | meaning |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from the console. Absent ⇒ sign-in off |
| `SESSION_SECRET` | signs the session cookie. Generated if unset, which means **every restart signs everyone out**; required in production |
| `PUBLIC_ORIGIN` | this server's public origin, default `http://localhost:8787`. Must match the redirect URI |
| `APP_ORIGIN` | where to send the browser after sign-in, default `http://localhost:5173` |
| `ALLOWED_ORIGINS` | comma-separated browser origins allowed to call `/auth/*` with credentials |
| `MAX_LIVE_GAMES` | how many cells tick at once; defaults to one per 5.5% of a core |

The cell id is derived from the Google subject (`u:<sub>`) and a `?game=` parameter is
**ignored** for a signed-in player — honouring it would let anyone open anyone else's cell
by naming it.

Google will not accept a non-localhost `http://` redirect URI, so anything other than local
development needs HTTPS.

## Deploying to Cloud Run

Add the deploy settings to `.env` (`GCP_PROJECT`, `GCP_REGION`,
`CLOUD_RUN_SERVICE_ACCOUNT` — see `.env.example`), then:

```bash
npm run deploy -- --push-secrets   # first time: also copies secrets into Secret Manager
npm run deploy                     # subsequently
npm run deploy -- --dry-run        # print the gcloud command without running it
```

**Secrets are mounted from Secret Manager by reference and never passed as environment
variables.** An env var would land in the service's configuration in plaintext, readable by
anyone with Viewer on the project, and sit in your shell history and process list on the
way there. `--push-secrets` pipes the values from `.env` in over stdin, so they are never
command-line arguments either.

The script also handles the ordering problem that `PUBLIC_ORIGIN` must be the service's own
URL, which does not exist until the service has been deployed once: it deploys, reads the
URL back, and updates the origins to match. So a first deploy runs `gcloud` twice.

The equivalent by hand:

```bash
gcloud run deploy protocell   --source . --region us-central1 --allow-unauthenticated   --no-cpu-throttling --min-instances 1 --max-instances 1   --timeout 3600 --memory 2Gi --cpu 2   --service-account protocell-server@PROJECT.iam.gserviceaccount.com   --set-env-vars GCS_BUCKET=your-bucket   --set-secrets GOOGLE_CLIENT_ID=…,GOOGLE_CLIENT_SECRET=…,SESSION_SECRET=…
```

Four of those flags are load-bearing, and three of them are the difference between working
and *appearing* to work:

| flag | why it is not optional |
|---|---|
| `--no-cpu-throttling` | **The critical one.** Cloud Run defaults to giving a container CPU only while it is serving a request. §2.3's entire premise is that the cell keeps living while nobody is watching — under throttling it silently freezes the moment you close the tab, and you would only notice by the ATP not having moved |
| `--min-instances 1` | Scale-to-zero would discard every in-memory cell. They would reload from storage, but every player pays a cold start and loses up to `AUTOSAVE_S` |
| `--max-instances 1` | A cell lives in RAM in **one process**. A second instance cannot see it, so requests routed there open a *second copy* of the same cell from storage — and both would then write to the same object. This is the one that corrupts data rather than merely degrading it |
| `--timeout 3600` | Cloud Run caps a request — including a WebSocket — at 60 minutes. The client reconnects and resumes, so this sets how often that happens rather than whether it works |

Health check is at **`/_health`**, not `/healthz`: Cloud Run's frontend intercepts that
exact path and returns its own 404, so the request never reaches the container.

Because `max-instances 1` is a hard ceiling, **this deployment does not scale horizontally**.
That is a property of a stateful simulation, not an oversight: growing past one machine
means sharding players across processes by their Google subject, not adding replicas.

The container serves the built client from the same origin as the socket, so there is no
CORS to configure and the session cookie works with plain `SameSite=Lax`. Set
`PUBLIC_ORIGIN` and `APP_ORIGIN` to the service URL, and add
`https://SERVICE-URL/auth/callback` to the OAuth client's authorized redirect URIs.

Attach a service account with **Storage Object Admin on the bucket** and no key is needed:
the metadata server issues tokens directly, so there is no key material in the deployment
at all.

## Other commands

```bash
npm test           # exit code is the truth — never pipe it through grep/head, which
                   # replaces vitest's status with the pipe tail's (cost: a crashed
                   # worker looked green for several runs). Read the FILE count too.
                   # headless — no browser needed anywhere. Runs in TWO passes:
                   #   test:sim   the sim/protocol/client suites, in parallel
                   #   test:wire  the socket suite, alone on a quiet machine
                   # They cannot share a run: the wire tests drive a real server ticking
                   # at 120 Hz in real time, so CPU contention from the sim workers
                   # starves it and its wall-clock assertions time out.
npm run typecheck  # tsc --build across all workspaces
npm run sweep      # re-measure §17's SA:V sweep (~2 min)
npm run play-intro # play the whole §12 arc as the nanobot, against a running server
```

`play-intro` is the end-to-end proof: it connects over the real socket, walks the bot to
the nucleus, hand-assembles all six proteins bond by bond, and reports the arc.

## Layout

```
prototypes/          the nine original browser prototypes, untouched, as reference (§18)
packages/
  sim/               the truth layer. no DOM, no net, no I/O — tsconfig sets types: []
  protocol/          wire message types + binary field-frame codec (§15.3)
apps/
  server/            node + ws. owns the clock, holds all state
  client/            vite + canvas2d. renders, sends commands, holds no truth
scripts/sweep.ts     headless §17 re-measurement
```

`packages/sim` has no network or DOM dependency and its tsconfig sets `"types": []`, so
`process` and `fs` are not even in scope — the "no I/O" rule fails to typecheck rather than
relying on anyone remembering it.

## Where the interesting parts are

- [`packages/sim/src/constants.ts`](packages/sim/src/constants.ts) — the single config
  block §13 demands, every value carrying the derivation that produced it.
- [`packages/sim/src/ops/diffuse.ts`](packages/sim/src/ops/diffuse.ts) — the fixed-timestep
  diffusion and the CFL guard, written to make the prototypes' frame-rate-dependent
  penetration depth (§17.2) unrepeatable rather than merely fixed.
- [`packages/sim/src/transport.ts`](packages/sim/src/transport.ts) — the three transport
  tiers, with tests written so `cell_prototype.html`'s diode "channel" could not pass them.
- [`packages/sim/test/intro.test.ts`](packages/sim/test/intro.test.ts) — the whole §12 arc
  as an integration test. Every beat has to emerge from the coupled systems; nothing is
  triggered directly.
- [SPEC §16.2](SPEC.md) — what each prototype actually validates versus what it appears to.
- [SPEC §16.3](SPEC.md) — what building it changed, including the sweep falsifying §13.6.

## License

[MIT](LICENSE). Do what you like with it, including the design in
[SPEC.md](SPEC.md) — that document is the more useful half of this repository.
