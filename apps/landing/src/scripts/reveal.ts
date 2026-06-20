/**
 * Landing-page animation engine. Drives:
 *  - scroll reveals ([data-reveal]) via IntersectionObserver, with stagger
 *  - bars that grow from 0 ([data-bar="w"|"h"]) on reveal
 *  - SVG lines that draw on ([data-draw]) on reveal
 *  - count-up numbers ([data-count]) on reveal
 *  - the cohort heatmap (built + staggered on reveal)
 *  - nav shadow on scroll
 * Everything degrades to "visible, no motion" when reduced motion is set.
 */
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- nav shadow on scroll ---
const nav = document.querySelector('.lp-nav');
if (nav) {
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

// --- count-up ---
function countUp(el: HTMLElement) {
  const to = parseFloat(el.dataset.countTo || '0');
  const dec = +(el.dataset.countDec || 0);
  const sep = el.dataset.countSep;
  const pre = el.dataset.countPrefix || '';
  const suf = el.dataset.countSuffix || '';
  const fmt = (n: number) => {
    let s = n.toFixed(dec);
    if (sep === '1') {
      const [i, d] = s.split('.');
      s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '');
    }
    return pre + s + suf;
  };
  if (reduce) {
    el.textContent = fmt(to);
    return;
  }
  const dur = 1200;
  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(to * e);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = fmt(to);
  };
  requestAnimationFrame(tick);
}

// --- svg draw-on ---
function drawPath(p: SVGPathElement) {
  p.classList.add('is-visible');
  if (!p.getTotalLength) return;
  const len = p.getTotalLength();
  p.style.strokeDasharray = String(len);
  p.style.strokeDashoffset = String(len);
  if (reduce) {
    p.style.strokeDashoffset = '0';
    return;
  }
  requestAnimationFrame(() => {
    p.style.transition = 'stroke-dashoffset 1.5s var(--ease-out-quart)';
    p.style.strokeDashoffset = '0';
  });
}

// --- cohort heatmap ---
function buildCohort(grid: HTMLElement) {
  if (grid.dataset.built) return;
  grid.dataset.built = '1';
  const accent =
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3B82F6';
  for (let i = 0; i < 35; i++) {
    const col = i % 7;
    const base = 1 - col * 0.13;
    const v = Math.max(0.06, Math.min(0.92, base + (Math.random() - 0.5) * 0.18));
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.style.background = `color-mix(in srgb, ${accent} ${Math.round(v * 100)}%, var(--content3))`;
    grid.appendChild(cell);
    if (!reduce) {
      const delay = col * 40 + Math.floor(i / 7) * 30;
      setTimeout(() => cell.classList.add('in'), 120 + delay);
    }
  }
}

function onReveal(el: Element) {
  el.querySelectorAll<HTMLElement>('[data-bar]').forEach((b) => b.classList.add('is-visible'));
  el.querySelectorAll<SVGPathElement>('[data-draw]').forEach((p) => drawPath(p));
  el.querySelectorAll<HTMLElement>('[data-count]').forEach((c) => countUp(c));
  el.querySelectorAll<HTMLElement>('.lp-cohort').forEach((g) => buildCohort(g));
}

// --- stagger delays within [data-stagger] groups ---
document.querySelectorAll<HTMLElement>('[data-stagger]').forEach((group) => {
  const step = +(group.dataset.stagger || 90);
  Array.from(group.querySelectorAll<HTMLElement>('[data-reveal]')).forEach((el, i) =>
    el.style.setProperty('--reveal-delay', i * step + 'ms'),
  );
});

// --- reveal observer ---
const reveals = [...document.querySelectorAll('[data-reveal]')];
if (reduce || !('IntersectionObserver' in window)) {
  reveals.forEach((el) => {
    el.classList.add('is-visible');
    onReveal(el);
  });
} else {
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          onReveal(e.target);
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
  );
  reveals.forEach((el) => io.observe(el));
}
