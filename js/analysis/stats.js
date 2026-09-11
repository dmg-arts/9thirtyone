/**
 * Quantitative analysis for rated questions.
 *
 * Everything here operates on the 1–9 numbers behind the words a cadet chose.
 * Two constraints shape the choices:
 *
 *   1. **Small n.** A flight is six people, not six hundred. Methods that need
 *      a large sample are worse than useless here, because they produce a
 *      confident-looking number from noise. Every routine below states the
 *      minimum it needs and returns null rather than guessing.
 *
 *   2. **Ordinal data.** A 1–9 rating scale is ordered, but the gap between
 *      Detrimental and Alarming is not provably the same as the gap between
 *      Favorable and Major. Means are still the most legible summary and cadre
 *      expect them, so they are reported — alongside median and a proper
 *      ordinal agreement measure, which does not assume equal spacing.
 */

import { mean, median, stdev, round } from '../util.js';

/** Below this many responses, dispersion and shape are not worth reporting. */
const MIN_FOR_SHAPE = 5;
/** Below this, outlier detection produces nonsense — every point is extreme. */
export const MIN_FOR_OUTLIERS = 6;

/* ------------------------------------------------------------------ *
 * Descriptive
 * ------------------------------------------------------------------ */

/** Quantile by linear interpolation, the definition most tools agree on. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const rest = pos - lower;
  const next = sorted[lower + 1] ?? sorted[lower];
  return sorted[lower] + rest * (next - sorted[lower]);
}

export function mode(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  const top = Math.max(...counts.values());
  // A tie means there is no single mode; report every joint winner in order.
  const winners = [...counts.entries()].filter(([, n]) => n === top).map(([v]) => v).sort((a, b) => a - b);
  return { values: winners, count: top, tied: winners.length > 1 };
}

export function describe(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);

  return {
    n: nums.length,
    mean: round(mean(nums), 2),
    median: round(median(nums), 2),
    mode: mode(nums),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    range: sorted[sorted.length - 1] - sorted[0],
    q1: round(q1, 2),
    q3: round(q3, 2),
    iqr: round(q3 - q1, 2),
    stdev: nums.length > 1 ? round(stdev(nums), 2) : null,
    // Dispersion is only meaningful once there is enough of it to disperse.
    reliable: nums.length >= MIN_FOR_SHAPE,
  };
}

/** Counts per scale point, including the points nobody chose. */
export function histogram(values, points) {
  const counts = new Map(points.map((p) => [p, 0]));
  for (const v of values) {
    if (counts.has(v)) counts.set(v, counts.get(v) + 1);
  }
  const total = values.length || 1;
  return points.map((p) => ({
    value: p,
    count: counts.get(p),
    share: counts.get(p) / total,
  }));
}

/* ------------------------------------------------------------------ *
 * Agreement
 * ------------------------------------------------------------------ */

/**
 * Ordinal consensus (Tastle & Wierman). 1 means everyone chose the same point,
 * 0 means the group is split evenly between the two extremes.
 *
 * Chosen over standard deviation because it is defined for ordinal scales and
 * because it answers the question cadre actually ask — "do they agree?" — on a
 * bounded 0–1 scale that reads the same regardless of how many points the
 * scale has.
 */
export function consensus(values, min, max) {
  const nums = values.filter(Number.isFinite);
  if (nums.length < 2) return null;
  const width = max - min;
  if (width <= 0) return 1;

  const mu = mean(nums);
  const counts = new Map();
  for (const v of nums) counts.set(v, (counts.get(v) || 0) + 1);

  let sum = 0;
  for (const [value, count] of counts) {
    const p = count / nums.length;
    const term = 1 - Math.abs(value - mu) / width;
    // term is 0 only when a value sits a full scale-width from the mean, which
    // cannot happen unless every other value is at the opposite end.
    sum += p * Math.log2(Math.max(term, Number.EPSILON));
  }
  return round(Math.max(0, Math.min(1, 1 + sum)), 3);
}

/** Plain-language reading of a consensus score. */
export function describeConsensus(score) {
  if (score == null) return null;
  if (score >= 0.85) return { label: 'Strong agreement', tone: 'ok' };
  if (score >= 0.7) return { label: 'General agreement', tone: 'ok' };
  if (score >= 0.5) return { label: 'Mixed views', tone: 'warn' };
  return { label: 'Sharply divided', tone: 'danger' };
}

/* ------------------------------------------------------------------ *
 * Clustering
 * ------------------------------------------------------------------ */

/**
 * Looks for two distinct groups of opinion in one question.
 *
 * A mean of 5 can mean everyone shrugged, or that half the flight thought it
 * was outstanding and half thought it was harmful — the same number, opposite
 * situations, and only the second needs acting on. This runs 1-D k-means with
 * k=2 and reports a split only when it is real: both groups substantial, and
 * the gap between them wide enough not to be an artefact of rounding.
 *
 * @returns {null|{split: boolean, groups: Array, separation: number}}
 */
export function findClusters(values, { min, max } = {}) {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length < MIN_FOR_SHAPE) return null;
  if (nums[0] === nums[nums.length - 1]) {
    return { split: false, groups: [{ centre: nums[0], size: nums.length, values: nums }], separation: 0 };
  }

  // Seed at the extremes; with one dimension and two clusters this converges
  // in a handful of passes and has no random component, so the same data always
  // gives the same answer.
  let low = nums[0];
  let high = nums[nums.length - 1];
  let groups = [[], []];

  for (let pass = 0; pass < 25; pass++) {
    groups = [[], []];
    for (const v of nums) {
      groups[Math.abs(v - low) <= Math.abs(v - high) ? 0 : 1].push(v);
    }
    if (!groups[0].length || !groups[1].length) break;
    const nextLow = mean(groups[0]);
    const nextHigh = mean(groups[1]);
    if (nextLow === low && nextHigh === high) break;
    low = nextLow;
    high = nextHigh;
  }

  if (!groups[0].length || !groups[1].length) {
    return { split: false, groups: [{ centre: mean(nums), size: nums.length, values: nums }], separation: 0 };
  }

  const width = (max ?? nums[nums.length - 1]) - (min ?? nums[0]) || 1;
  const separation = Math.abs(high - low) / width;
  const smaller = Math.min(groups[0].length, groups[1].length);

  return {
    split: separation >= 0.3 && smaller >= Math.max(2, Math.round(nums.length * 0.2)),
    separation: round(separation, 3),
    groups: [
      { centre: round(low, 2), size: groups[0].length, values: groups[0] },
      { centre: round(high, 2), size: groups[1].length, values: groups[1] },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Outliers
 * ------------------------------------------------------------------ */

/**
 * Flags individual ratings that sit far from the rest, by modified z-score.
 *
 * Uses the median and the median absolute deviation rather than mean and
 * standard deviation, because with six responses a single extreme rating drags
 * the mean toward itself and hides the very thing being looked for. 3.5 is the
 * conventional Iglewicz–Hoaglin cut-off.
 *
 * When MAD is zero — everyone but one person chose the same value — that lone
 * dissenter is the outlier by definition, so it is reported directly.
 */
export function findOutliers(values) {
  const nums = values.filter(Number.isFinite);
  if (nums.length < MIN_FOR_OUTLIERS) {
    return { supported: false, reason: `Needs at least ${MIN_FOR_OUTLIERS} responses`, outliers: [] };
  }

  const med = median(nums);
  const deviations = nums.map((v) => Math.abs(v - med));
  const mad = median(deviations);

  const outliers = [];
  if (mad === 0) {
    for (const [index, v] of nums.entries()) {
      if (v !== med) outliers.push({ index, value: v, score: Infinity, distance: Math.abs(v - med) });
    }
  } else {
    for (const [index, v] of nums.entries()) {
      const score = (0.6745 * (v - med)) / mad;
      if (Math.abs(score) > 3.5) {
        outliers.push({ index, value: v, score: round(score, 2), distance: Math.abs(v - med) });
      }
    }
  }

  return { supported: true, median: med, mad: round(mad, 2), outliers };
}

/**
 * Finds respondents who rate consistently differently from everyone else.
 *
 * More useful than a single odd answer: one person marking every question two
 * points below the group is a pattern worth knowing about — it may be a genuine
 * dissenting experience, or one person who rates harshly. Either way the
 * instructor should see it rather than have it averaged away.
 *
 * @param {Array<{id: string, answers: object}>} responses
 * @param {Array<{id: string}>} scaleItems
 */
export function findRespondentOutliers(responses, scaleItems) {
  if (responses.length < MIN_FOR_OUTLIERS) {
    return { supported: false, reason: `Needs at least ${MIN_FOR_OUTLIERS} responses`, respondents: [] };
  }

  // Per-question medians, so a respondent is compared with the group on each
  // question rather than against a single overall average.
  const medians = new Map();
  for (const item of scaleItems) {
    const values = responses.map((r) => r.answers?.[item.id]).filter(Number.isFinite);
    if (values.length) medians.set(item.id, median(values));
  }
  if (!medians.size) return { supported: false, reason: 'No rated questions', respondents: [] };

  const rows = responses.map((response) => {
    const diffs = [];
    for (const [itemId, med] of medians) {
      const value = response.answers?.[itemId];
      if (Number.isFinite(value)) diffs.push(value - med);
    }
    return {
      response,
      answered: diffs.length,
      // Signed mean deviation: direction matters. Consistently harsh and
      // consistently generous are different findings.
      drift: diffs.length ? round(mean(diffs), 2) : null,
      spread: diffs.length > 1 ? round(stdev(diffs), 2) : null,
    };
  }).filter((row) => row.drift !== null);

  const drifts = rows.map((r) => r.drift);
  const med = median(drifts);
  const mad = median(drifts.map((d) => Math.abs(d - med)));

  const respondents = rows
    .map((row) => ({
      ...row,
      score: mad === 0 ? (row.drift === med ? 0 : Infinity)
        : round((0.6745 * (row.drift - med)) / mad, 2),
    }))
    .filter((row) => Math.abs(row.score) > 3.5)
    .sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));

  return { supported: true, respondents, groupDrift: round(med, 2) };
}

/* ------------------------------------------------------------------ *
 * Segments
 * ------------------------------------------------------------------ */

/**
 * Compares a measure across cohorts — AS level, term, form. Segments below
 * `minSize` are pooled into "Too few to report" rather than shown, so a
 * one-person segment cannot be read as a group finding.
 */
export function compareSegments(rows, keyFn, valueFn, { minSize = 3 } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row) || 'Unspecified';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...valueFn(row));
  }

  const segments = [];
  let suppressed = 0;
  for (const [label, values] of groups) {
    const nums = values.filter(Number.isFinite);
    if (!nums.length) continue;
    if (nums.length < minSize) { suppressed++; continue; }
    segments.push({
      label,
      n: nums.length,
      mean: round(mean(nums), 2),
      median: round(median(nums), 2),
      stdev: nums.length > 1 ? round(stdev(nums), 2) : null,
    });
  }

  segments.sort((a, b) => b.mean - a.mean);
  const means = segments.map((s) => s.mean);
  return {
    segments,
    suppressed,
    spread: means.length > 1 ? round(Math.max(...means) - Math.min(...means), 2) : null,
  };
}
