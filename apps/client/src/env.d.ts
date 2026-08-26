/**
 * Injected by vite (see vite.config.ts) so the HUD can prove which build is running.
 * A stale dev server serving old code looks exactly like a broken change until you can
 * see the stamp.
 */
declare const __BUILD__: string;

/**
 * Vite's build-time env. `VITE_SIM_URL` points the client at a deployed simulation
 * server; without it the client resolves the socket from the page's own origin (§15.6).
 */
interface ImportMetaEnv {
  readonly VITE_SIM_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
