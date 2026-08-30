/**
 * Deploy to Cloud Run using the settings already in `.env`.
 *
 *   npm run deploy                 deploy
 *   npm run deploy -- --dry-run    print the command without running it
 *   npm run deploy -- --push-secrets   copy secrets from .env into Secret Manager first
 *
 * ── Secrets never reach the command line ────────────────────────────────────
 * `--set-env-vars GOOGLE_CLIENT_SECRET=…` would work and is the wrong thing twice over:
 * the value lands in the service's configuration in plaintext, readable by anyone with
 * Viewer on the project, and it sits in this machine's process list and shell history on
 * the way there. So secrets are mounted from **Secret Manager** by reference, and the only
 * values this script ever puts on a command line are non-secret ones — the bucket, the
 * origins, the region.
 *
 * `--push-secrets` is the one exception, and it pipes values in over stdin rather than
 * passing them as arguments.
 *
 * ── The two-phase origin problem, handled ───────────────────────────────────
 * `PUBLIC_ORIGIN` must be the service's own URL, which does not exist until the service
 * has been deployed once. So: deploy, read the URL back, and update the origins if they
 * changed. That is why a first deploy runs gcloud twice and a subsequent one usually does
 * not.
 */

import { spawn } from 'node:child_process';

try {
  process.loadEnvFile('.env');
} catch {
  console.error('No .env found. Copy .env.example to .env first.');
  process.exit(1);
}

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const pushSecrets = argv.includes('--push-secrets');

const env = (k: string, fallback = ''): string => process.env[k] ?? fallback;

const PROJECT = env('GCP_PROJECT');
const REGION = env('GCP_REGION', 'us-central1');
const SERVICE = env('CLOUD_RUN_SERVICE', 'protocell');
const SA = env('CLOUD_RUN_SERVICE_ACCOUNT');
const BUCKET = env('GCS_BUCKET');

const missing = Object.entries({ GCP_PROJECT: PROJECT, GCS_BUCKET: BUCKET }).filter(([, v]) => !v);
if (missing.length) {
  console.error(`Missing in .env: ${missing.map(([k]) => k).join(', ')}`);
  console.error('See .env.example for what each one is.');
  process.exit(1);
}

/** Secrets, by the name they take in Secret Manager. */
const SECRETS: Record<string, string> = {
  GOOGLE_CLIENT_ID: env('SECRET_GOOGLE_CLIENT_ID', 'protocell-google-client-id'),
  GOOGLE_CLIENT_SECRET: env('SECRET_GOOGLE_CLIENT_SECRET', 'protocell-google-client-secret'),
  SESSION_SECRET: env('SECRET_SESSION_SECRET', 'protocell-session-secret'),
};

// gcloud ships as a .cmd on Windows, which cannot be spawned without a shell.
const GCLOUD = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud';

function run(args: string[], opts: { stdin?: string; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    // `--quiet` takes the default answer to every prompt instead of asking.
    const full = ['--quiet', ...args];
    if (!opts.quiet) console.log(`  $ gcloud ${full.join(' ')}`);
    const p = spawn(GCLOUD, full, {
      shell: process.platform === 'win32',
      // A quiet call swallows stderr too. `serviceUrl()` is EXPECTED to fail before the
      // first deploy — the service does not exist yet — and letting gcloud print its
      // "API not enabled / not found" wall makes a perfectly good first deploy look like
      // it has already gone wrong.
      // stdin is NEVER inherited. gcloud prompts on plenty of ordinary paths -- "enable
      // this API and retry?", "create an Artifact Registry repository?" -- and a prompt
      // written to an inherited stdin that nobody is typing into hangs the deploy with no
      // output at all. Measured the hard way: the first run of this script sat forever.
      // `--quiet` below answers those prompts with their defaults; this makes sure that
      // even an unanticipated one cannot block.
      stdio: [
        opts.stdin === undefined ? 'ignore' : 'pipe',
        'pipe',
        opts.quiet ? 'pipe' : 'inherit',
      ],
    });
    if (opts.quiet) p.stderr?.resume();
    let out = '';
    p.stdout.on('data', (d: Buffer) => {
      out += String(d);
      if (!opts.quiet) process.stdout.write(d);
    });
    if (opts.stdin !== undefined) {
      p.stdin.write(opts.stdin);
      p.stdin.end();
    }
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`gcloud exited ${code}`))));
  });
}

async function serviceUrl(): Promise<string | null> {
  try {
    const url = await run(
      ['run', 'services', 'describe', SERVICE, '--region', REGION, '--project', PROJECT,
       '--format', 'value(status.url)'],
      { quiet: true },
    );
    return url || null;
  } catch {
    return null; // not deployed yet
  }
}

async function ensureSecrets(): Promise<void> {
  for (const [envName, secretName] of Object.entries(SECRETS)) {
    const value = process.env[envName];
    if (!value) {
      console.error(`  ! ${envName} is not in .env — cannot push it`);
      continue;
    }
    const exists = await run(
      ['secrets', 'describe', secretName, '--project', PROJECT, '--format', 'value(name)'],
      { quiet: true },
    ).then(() => true).catch(() => false);

    if (!exists) {
      await run(['secrets', 'create', secretName, '--project', PROJECT, '--replication-policy', 'automatic'],
        { quiet: true });
      console.log(`  created secret ${secretName}`);
    }
    // Over stdin, so the value is never an argument.
    await run(['secrets', 'versions', 'add', secretName, '--project', PROJECT, '--data-file', '-'],
      { stdin: value, quiet: true });
    console.log(`  ${secretName} <- ${envName} (new version)`);
  }
}

async function main(): Promise<void> {
  console.log(`project  ${PROJECT}`);
  console.log(`service  ${SERVICE} (${REGION})`);
  console.log(`bucket   gs://${BUCKET}`);
  console.log(`identity ${SA || '(default compute service account)'}`);
  console.log('');

  if (pushSecrets) {
    console.log('pushing secrets from .env into Secret Manager:');
    if (!dryRun) await ensureSecrets();
    console.log('');
  }

  const known = await serviceUrl();
  const origin = env('PUBLIC_ORIGIN') || known || '';

  const envVars = [`GCS_BUCKET=${BUCKET}`, 'NODE_ENV=production'];
  if (origin && !origin.includes('localhost')) {
    envVars.push(`PUBLIC_ORIGIN=${origin}`, `APP_ORIGIN=${origin}`, `ALLOWED_ORIGINS=${origin}`);
  }
  const secretRefs = Object.entries(SECRETS).map(([k, v]) => `${k}=${v}:latest`);

  const args = [
    'run', 'deploy', SERVICE,
    '--source', '.',
    '--project', PROJECT,
    '--region', REGION,
    '--allow-unauthenticated',
    // See the README: these four are the difference between working and appearing to.
    '--no-cpu-throttling',
    '--min-instances', '1',
    '--max-instances', '1',
    '--timeout', '3600',
    '--memory', env('CLOUD_RUN_MEMORY', '2Gi'),
    '--cpu', env('CLOUD_RUN_CPU', '2'),
    '--set-env-vars', envVars.join(','),
    '--set-secrets', secretRefs.join(','),
  ];
  if (SA) args.push('--service-account', SA);

  if (dryRun) {
    console.log('dry run — would execute:');
    console.log(`  gcloud ${args.join(' ')}`);
    return;
  }

  await run(args);

  // Phase two: on a first deploy the URL did not exist when we set the origins above.
  const url = await serviceUrl();
  if (url && url !== origin) {
    console.log('');
    console.log(`service URL is ${url} — setting origins to match`);
    await run([
      'run', 'services', 'update', SERVICE, '--project', PROJECT, '--region', REGION,
      '--update-env-vars', `PUBLIC_ORIGIN=${url},APP_ORIGIN=${url},ALLOWED_ORIGINS=${url}`,
    ]);
  }

  console.log('');
  console.log(`deployed: ${url ?? '(url unknown)'}`);
  console.log('');
  console.log('One manual step remains — add this to the OAuth client\'s');
  console.log('Authorized redirect URIs, exactly:');
  console.log(`  ${url}/auth/callback`);
}

main().catch((e: unknown) => {
  console.error('');
  console.error(`deploy failed: ${(e as Error).message}`);
  process.exit(1);
});
