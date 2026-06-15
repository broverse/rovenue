// =============================================================
// Predictive LTV — Level 1 math (ClickHouse-free, unit-tested)
// =============================================================

export interface LtvRawRow {
  cohortMonth: string;
  store: string;
  productId: string;
  ageMonth: number;
  netUsd: number;
}

export interface LtvSizeRow {
  cohortMonth: string;
  store: string;
  productId: string;
  size: number;
}

export interface LtvSegmentResult {
  key: string;
  size: number;
  observedLtvUsd: string;
  predictedLtvUsd: string;
  warning: string | null;
}

export interface LtvPredictionData {
  horizonMonths: number;
  blendedPredictedLtvUsd: string;
  maturityCurve: Array<{ ageMonth: number; fraction: number }>;
  cohorts: Array<{
    cohortMonth: string;
    size: number;
    observedLtvUsd: string;
    predictedLtvUsd: string;
    maturity: number;
    isMature: boolean;
  }>;
  byStore: LtvSegmentResult[];
  byProduct: LtvSegmentResult[];
  warning: string | null;
}

function monthIndex(monthStart: string): number {
  const parts = monthStart.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  return y * 12 + (m - 1);
}

function cumAt(byAge: Map<number, number>, t: number): number {
  let acc = 0;
  for (let a = 0; a <= t; a++) acc += byAge.get(a) ?? 0;
  return acc;
}

function scaledPrediction(byAge: Map<number, number>, a: number, fa: number, n: number, isMature: boolean, H: number): number {
  const observed = cumAt(byAge, a) / (n || 1);
  if (isMature) return cumAt(byAge, H) / (n || 1);
  return fa > 0 ? observed / fa : observed;
}

export function computeLtvPrediction(
  rows: LtvRawRow[],
  sizes: LtvSizeRow[],
  horizonMonths: number,
  minMatureCohorts: number,
  asOfMonth: string,
): LtvPredictionData {
  const H = horizonMonths;
  const asOf = monthIndex(asOfMonth);

  const sizeByCohort = new Map<string, number>();
  const sizeStore = new Map<string, Map<string, number>>();
  const sizeProduct = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, key: string, cohort: string, n: number) => {
    const inner = m.get(key) ?? new Map<string, number>();
    inner.set(cohort, (inner.get(cohort) ?? 0) + n);
    m.set(key, inner);
  };
  for (const s of sizes) {
    sizeByCohort.set(s.cohortMonth, (sizeByCohort.get(s.cohortMonth) ?? 0) + s.size);
    add(sizeStore, s.store, s.cohortMonth, s.size);
    add(sizeProduct, s.productId, s.cohortMonth, s.size);
  }

  const revCohort = new Map<string, Map<number, number>>();
  const revStore = new Map<string, Map<string, Map<number, number>>>();
  const revProduct = new Map<string, Map<string, Map<number, number>>>();
  const bump = (m: Map<string, Map<number, number>>, cohort: string, age: number, v: number) => {
    const inner = m.get(cohort) ?? new Map<number, number>();
    inner.set(age, (inner.get(age) ?? 0) + v);
    m.set(cohort, inner);
  };
  const bumpSeg = (m: Map<string, Map<string, Map<number, number>>>, key: string, cohort: string, age: number, v: number) => {
    const inner = m.get(key) ?? new Map<string, Map<number, number>>();
    bump(inner, cohort, age, v);
    m.set(key, inner);
  };
  for (const r of rows) {
    if (r.ageMonth < 0 || r.ageMonth > H) continue;
    bump(revCohort, r.cohortMonth, r.ageMonth, r.netUsd);
    bumpSeg(revStore, r.store, r.cohortMonth, r.ageMonth, r.netUsd);
    bumpSeg(revProduct, r.productId, r.cohortMonth, r.ageMonth, r.netUsd);
  }

  const cohortsList = [...sizeByCohort.keys()].sort();
  const observedAge = (c: string): number => Math.max(0, asOf - monthIndex(c));

  const mature = cohortsList.filter((c) => observedAge(c) >= H && cumAt(revCohort.get(c) ?? new Map(), H) > 0);
  let f: number[];
  let warning: string | null = null;
  if (mature.length === 0) {
    f = Array.from({ length: H + 1 }, (_, t) => (t >= H ? 1 : 0));
    warning = `No cohort has reached the ${H}-month horizon yet; predictions equal observed and are highly uncertain.`;
  } else {
    const raw = Array.from({ length: H + 1 }, () => 0);
    let wsum = 0;
    for (const c of mature) {
      const size = sizeByCohort.get(c) ?? 0;
      const byAge = revCohort.get(c) ?? new Map();
      const denom = cumAt(byAge, H) / (size || 1);
      if (denom <= 0) continue;
      for (let t = 0; t <= H; t++) raw[t]! += size * ((cumAt(byAge, t) / (size || 1)) / denom);
      wsum += size;
    }
    f = raw.map((v) => (wsum > 0 ? v / wsum : 0));
    for (let t = 1; t <= H; t++) f[t] = Math.max(f[t]!, f[t - 1]!);
    f[H] = 1;
    if (mature.length < minMatureCohorts) {
      warning = `Only ${mature.length} cohort(s) have reached the ${H}-month horizon; predictions are low-confidence.`;
    }
  }

  const fix = (n: number) => n.toFixed(4);
  const cohorts = cohortsList.map((c) => {
    const size = sizeByCohort.get(c) ?? 0;
    const byAge = revCohort.get(c) ?? new Map();
    const a = Math.min(observedAge(c), H);
    const observed = cumAt(byAge, a) / (size || 1);
    const isMature = observedAge(c) >= H;
    const fa = f[a] ?? 0;
    const predicted = scaledPrediction(byAge, a, fa, size, isMature, H);
    return {
      cohortMonth: c,
      size,
      observedLtvUsd: fix(observed),
      predictedLtvUsd: fix(predicted),
      maturity: isMature ? 1 : fa,
      isMature,
    };
  });

  const totalSize = cohortsList.reduce((s, c) => s + (sizeByCohort.get(c) ?? 0), 0);
  const blended =
    totalSize > 0
      ? cohorts.reduce((s, c) => s + c.size * Number(c.predictedLtvUsd), 0) / totalSize
      : 0;

  const segment = (
    revMap: Map<string, Map<string, Map<number, number>>>,
    sizeMap: Map<string, Map<string, number>>,
  ): LtvSegmentResult[] =>
    [...sizeMap.entries()]
      .map(([key, perCohort]) => {
        let wPred = 0;
        let wObs = 0;
        let segSize = 0;
        for (const [c, n] of perCohort) {
          const byAge = revMap.get(key)?.get(c) ?? new Map<number, number>();
          const a = Math.min(observedAge(c), H);
          const observed = cumAt(byAge, a) / (n || 1);
          const isMature = observedAge(c) >= H;
          const fa = f[a] ?? 0;
          const predicted = scaledPrediction(byAge, a, fa, n, isMature, H);
          wPred += n * predicted;
          wObs += n * observed;
          segSize += n;
        }
        return {
          key,
          size: segSize,
          observedLtvUsd: fix(segSize > 0 ? wObs / segSize : 0),
          predictedLtvUsd: fix(segSize > 0 ? wPred / segSize : 0),
          warning: warning ?? (segSize < 20 ? "Thin segment — low confidence." : null),
        };
      })
      .sort((a, b) => b.size - a.size);

  return {
    horizonMonths: H,
    blendedPredictedLtvUsd: fix(blended),
    maturityCurve: f.map((fraction, ageMonth) => ({ ageMonth, fraction })),
    cohorts,
    byStore: segment(revStore, sizeStore),
    byProduct: segment(revProduct, sizeProduct),
    warning,
  };
}
