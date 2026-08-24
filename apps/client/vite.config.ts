import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // Fail loudly rather than silently sliding to 5174. A second vite serving stale code
    // on the port you are actually looking at is indistinguishable from a broken change,
    // and it has already cost two debugging sessions.
    strictPort: true,
  },
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(11, 19)),
  },
});
