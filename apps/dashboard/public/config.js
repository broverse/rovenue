// Dev placeholder. Vite serves this file at /config.js during `pnpm dev` so
// the tag in index.html gets a 200 instead of a console error.
//
// It is NOT what a container serves: deploy/caddy/Caddyfile.dashboard
// intercepts /config.js and responds from the ROVENUE_* environment. With
// every key absent here, lib/runtime-config.ts falls through to the VITE_*
// build values, which is exactly the dev behaviour.
window.__ROVENUE_CONFIG__ = {};
