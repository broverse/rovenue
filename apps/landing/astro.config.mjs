// @ts-check
import { defineConfig } from 'astro/config';

// Static marketing site for Rovenue. `output: 'static'` is Astro's default —
// the whole site is prerendered to plain HTML/CSS/JS at build time.
export default defineConfig({
  site: 'https://rovenue.app',
});
