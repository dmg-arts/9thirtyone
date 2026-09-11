/**
 * Feedback Response and Analysis.
 *
 * Filters completed feedback by date range, class/event, AS level, and feedback
 * id, then shows who has responded, what they said, and the roll-up statistics.
 *
 * The deeper analysis (trends across terms, per-instructor baselines, outlier
 * flagging) is deliberately not here yet — this page establishes the filtering
 * and the response surface those will read from.
 */

import {
  el, icon, field, select, badge, notice, emptyState, spinner, toast,
  download, toCsv, fmtDate, fmtDateTime, pluralize, mean, median, stdev, round,
  modal, fromDateInput, groupBy,
  mount, remount } from '../util.js';
import { AS_CLASSES, SEMESTERS, PRIVACY, ROLES, schoolYears, nearestAnchor } from '../config.js';
import {
  loadCatalog, loadAllResponses, loadResponsesFor, loadStudents,
  deleteResponse as removeResponse, writeAudit,
} from '../data-source.js';
import { inSpaces } from '../panels.js';
import { renderForm, formItems } from '../forms.js';
import { navigate } from '../router.js';
import { hasRole } from '../auth.js';
import { AUDIT } from '../audit.js';
import {
  describe, histogram, consensus, describeConsensus, findClusters,
  findOutliers, findRespondentOutliers, compareSegments, MIN_FOR_OUTLIERS,
} from '../analysis/stats.js';
import { summariseSentiment, wordFrequencies, phraseFrequencies, screenAll, highlight } from '../analysis/text.js';
import { renderWordCloud, renderTermTable } from '../analysis/wordcloud.js';

/**
 * The anchor set the responses in scope were answered on. Forms record their
 * own wording, so a range that mixes scales falls back to the first one found
 * rather than describing a score in words it was never rated with.
 */
function anchorsInScope(rows, formsById) {
  for (const response of rows) {
    const form = formsById?.get(response.formId);
    for (const item of formItems(form || {})) {
      if (item.type === 'scale' && item.anchors) return item.anchors;
    }
  }
  return undefined;
}

export async function renderAnalysis(host, { spaces = null } = {}) {
  remount(host, spinner('Gathering feedback…'));

  let requests;
  let responses;
  let forms;
  let students;
  try {
    const [catalog, allResponses, roster] = await Promise.all([
      loadCatalog(), loadAllResponses(), loadStudents(),
    ]);
    ({ requests, forms } = catalog);
    responses = allResponses;
    students = roster;
    // Analysis is scoped to the panel it was opened from. Mixing a cadre-only
    // form into the detachment averages would leak its existence through the
    // numbers even though the responses themselves stayed hidden.
    if (spaces) {
      requests = requests.filter(inSpaces(spaces));
      const inScope = new Set(requests.map((r) => r.id));
      responses = responses.filter((r) => inScope.has(r.requestId));
    }
  } catch (err) {
    remount(host, notice('danger', 'Could not load feedback', el('p', {}, err.message)));
    return;
  }

  const formsById = new Map(forms.map((f) => [f.id, f]));
  const requestsById = new Map(requests.map((r) => [r.id, r]));

  const state = {
    from: '', to: '', asClass: '', schoolYear: '', semester: '', feedbackId: '', search: '',
  };

  const results = el('div', { class: 'stack-lg' });
  const years = schoolYears();

  remount(host, 
    el('div', { class: 'row row--between row--wrap', style: { marginBottom: 'var(--sp-4)' } },
      el('h2', { class: 'section-title', style: { margin: '0' } }, 'Feedback Response and Analysis'),
      el('div', { class: 'row row--wrap' },
        el('button', { type: 'button', class: 'btn btn--sm', onclick: exportRows }, icon('download'), 'Export CSV'),
        el('button', { type: 'button', class: 'btn btn--sm', onclick: () => window.print() }, icon('external'), 'Print'))),

    el('div', { class: 'card', style: { padding: 'var(--sp-4)', marginBottom: 'var(--sp-5)' } },
      el('div', { class: 'filters' },
        field('From', el('input', {
          class: 'input', type: 'date',
          onchange: (e) => { state.from = e.target.value; draw(); },
        }), { hint: 'Submission date' }),
        field('To', el('input', {
          class: 'input', type: 'date',
          onchange: (e) => { state.to = e.target.value; draw(); },
        })),
        field('AS level', select(
          [{ value: '', label: 'All levels' }, ...AS_CLASSES.map((c) => ({ value: c.code, label: c.code }))],
          { onchange: (e) => { state.asClass = e.target.value; draw(); } })),
        field('School year', select(
          [{ value: '', label: 'All years' }, ...years.map((y) => ({ value: y, label: y }))],
          { onchange: (e) => { state.schoolYear = e.target.value; draw(); } })),
        field('Semester', select(
          [{ value: '', label: 'All' }, ...SEMESTERS.map((s) => ({ value: s, label: s }))],
          { onchange: (e) => { state.semester = e.target.value; draw(); } })),
        field('Feedback ID', select(
          [{ value: '', label: 'All feedback' },
            ...requests.filter((r) => r.feedbackId)
              .map((r) => ({ value: r.feedbackId, label: `${r.feedbackId} — ${r.title}` }))],
          { onchange: (e) => { state.feedbackId = e.target.value; draw(); } })),
        field('Class / event', el('input', {
          class: 'input', type: 'search', placeholder: 'Name contains…',
          oninput: (e) => { state.search = e.target.value; draw(); },
        }))),
      el('div', { class: 'row row--end', style: { marginTop: 'var(--sp-3)' } },
        el('button', {
          type: 'button', class: 'btn btn--sm btn--ghost',
          onclick: () => { navigate('/instructor?tab=analysis'); },
        }, icon('refresh'), 'Reset filters'))),

    results);

  function matchingRequests() {
    return requests.filter((request) => {
      if (state.feedbackId && request.feedbackId !== state.feedbackId) return false;
      if (state.asClass && request.asClass !== state.asClass) return false;
      if (state.schoolYear && request.schoolYear !== state.schoolYear) return false;
      if (state.semester && request.semester !== state.semester) return false;
      if (state.search && !`${request.title} ${request.eventName || ''}`.toLowerCase()
        .includes(state.search.toLowerCase())) return false;
      return true;
    });
  }

  function filtered() {
    const allowed = new Set(matchingRequests().map((r) => r.id));
    const fromTime = state.from ? new Date(fromDateInput(state.from)).getTime() : null;
    const toTime = state.to ? new Date(fromDateInput(state.to, true)).getTime() : null;

    return responses.filter((response) => {
      if (!allowed.has(response.requestId)) return false;
      const at = new Date(response.submittedAt).getTime();
      if (fromTime && at < fromTime) return false;
      if (toTime && at > toTime) return false;
      return true;
    });
  }

  /**
   * Splits the filtered responses into what may be shown and what must not.
   *
   * The threshold is applied *per form*, not to the total, because that is the
   * unit an author can be identified within — receipts are per form. Pooling a
   * thin form into a larger total would not protect it either, since the
   * feedback-ID filter can isolate it again in one click.
   */
  function partition(rows) {
    const countByRequest = new Map();
    for (const response of rows) {
      countByRequest.set(response.requestId, (countByRequest.get(response.requestId) || 0) + 1);
    }

    const withheld = [];
    const blocked = new Set();
    for (const [requestId, count] of countByRequest) {
      const request = requestsById.get(requestId);
      // Attributed feedback carries names already; withholding buys nothing.
      if (!request?.anonymous) continue;
      if (count >= PRIVACY.minResponsesToShow) continue;
      blocked.add(requestId);
      withheld.push({ request, count });
    }

    return {
      visible: rows.filter((r) => !blocked.has(r.requestId)),
      withheld: withheld.sort((a, b) => b.count - a.count),
    };
  }

  function draw() {
    const all = filtered();
    const inScope = matchingRequests();
    const { visible, withheld } = partition(all);
    remount(results);

    if (!requests.length) {
      mount(results, emptyState({
        iconName: 'chart',
        title: 'No feedback has been created yet',
        message: 'Use Create Feedback to issue your first form.',
        action: el('button', { type: 'button', class: 'btn btn--primary', onclick: () => navigate('/instructor/create/new') },
          icon('plus'), 'Create feedback'),
      }));
      return;
    }

    if (withheld.length) mount(results, withheldNotice(withheld));

    mount(results, summary(visible));

    // The safety screen runs on everything in scope, including forms whose
    // results are withheld — see safetyPanel() for why.
    mount(results, safetyPanel(all, withheld));

    if (!visible.length) {
      mount(results, emptyState({
        iconName: withheld.length ? 'lock' : 'filter',
        title: withheld.length ? 'Nothing can be shown yet' : 'No responses in this range',
        message: withheld.length
          ? `Anonymous feedback stays hidden until ${PRIVACY.minResponsesToShow} people have responded.`
          : 'Widen the filters, or check the completion table below.',
      }));
    } else {
      mount(results, quantitativePanel(visible));
      mount(results, textPanel(visible));
      mount(results, responseList(visible));
    }
    mount(results, completion(inScope));
  }

  /** Names what is being held back and exactly what would release it. */
  function withheldNotice(withheld) {
    const rows = el('div', { class: 'stack-sm' });
    for (const { request, count } of withheld) {
      const needed = PRIVACY.minResponsesToShow - count;
      mount(rows, el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('div', { style: { fontWeight: '550' } },
            request.feedbackId ? `${request.feedbackId} — ${request.title}` : request.title),
          el('div', { class: 'muted' },
            `${pluralize(count, 'response')} so far · ${needed} more ${needed === 1 ? 'releases' : 'release'} the results`)),
        badge('Withheld', 'warn', 'lock')));
    }

    return notice('warn', `Results withheld for ${pluralize(withheld.length, 'form')}`,
      el('p', {}, 'With this few responses, a single answer can be traced back to its author by '
        + 'elimination against the completion list. These forms are excluded from the statistics, '
        + 'comments and individual responses below — the counts stay visible so you can still chase '
        + 'the people who owe feedback.'),
      el('div', { style: { marginTop: 'var(--sp-3)' } }, rows));
  }

  /* ---------------- panels ---------------- */

  function summary(rows) {
    const scopeAnchors = anchorsInScope(rows, formsById);
    // Count the forms actually represented here, not everything the filters
    // matched — withheld forms contribute nothing to these numbers, so
    // including them in the caption would overstate what is being shown.
    const formsShown = new Set(rows.map((r) => r.requestId)).size;
    const values = rows.flatMap((r) => Object.values(r.answers || {}).filter((v) => typeof v === 'number'));
    const stat = (label, value, note) => el('div', { class: 'stat' },
      el('div', { class: 'stat__label' }, label),
      el('div', { class: 'stat__value' }, value),
      note && el('div', { class: 'stat__note' }, note));

    return el('section', {},
      el('h3', { class: 'section-title' }, 'Overview'),
      el('div', { class: 'grid grid--3' },
        stat('Responses', String(rows.length), `across ${pluralize(formsShown, 'form')}`),
        stat('Mean score', values.length ? String(round(mean(values), 2)) : '—',
          values.length ? `closest to "${nearestAnchor(mean(values), scopeAnchors)}"` : 'all rated questions'),
        stat('Median', values.length ? String(round(median(values), 2)) : '—',
          values.length ? `closest to "${nearestAnchor(median(values), scopeAnchors)}"` : ''),
        stat('Spread', values.length > 1 ? `±${round(stdev(values), 2)}` : '—', 'standard deviation')));
  }

  /* ---------------- quantitative ---------------- */

  /** Every rated question in scope, with its values and its scale. */
  function ratedQuestions(rows) {
    const buckets = new Map();
    for (const response of rows) {
      const form = formsById.get(response.formId);
      if (!form) continue;
      for (const item of formItems(form)) {
        if (item.type !== 'scale') continue;
        const value = response.answers?.[item.id];
        if (!Number.isFinite(value)) continue;
        const key = `${form.id}::${item.id}`;
        if (!buckets.has(key)) buckets.set(key, { item, form, values: [], rows: [] });
        buckets.get(key).values.push(value);
        buckets.get(key).rows.push(response);
      }
    }
    return [...buckets.values()];
  }

  function quantitativePanel(rows) {
    const questions = ratedQuestions(rows);
    const section = el('section', {},
      el('h3', { class: 'section-title' }, 'Ratings'));

    if (!questions.length) {
      mount(section, el('p', { class: 'muted' }, 'No rated questions in this range.'));
      return section;
    }

    // Compact overview first: with several rated questions the detailed cards
    // are a lot of scrolling, and the common need is to scan them all at once.
    mount(section, overviewBars(questions));
    for (const q of questions) mount(section, questionCard(q));
    mount(section, segmentCard(rows));
    mount(section, raterCard(rows, questions));
    return section;
  }

  /** Every rated question as one bar each, for scanning. */
  function overviewBars(questions) {
    const bars = el('div', { class: 'bars' });
    for (const { item, values } of questions) {
      const max = Number(item.max ?? 9);
      const avg = mean(values);
      const word = nearestAnchor(avg, item.anchors);
      mount(bars, el('div', { class: 'bar-row' },
        el('div', { class: 'bar-row__label', title: item.label }, item.label),
        el('div', { class: 'bar-row__track' },
          el('div', { class: 'bar-row__fill', style: { width: `${(avg / max) * 100}%` } })),
        el('div', { class: 'bar-row__val' },
          word ? `${round(avg, 2)} · ${word}` : `${round(avg, 2)} / ${max}`)));
    }
    return el('div', { class: 'card stack' },
      el('div', { class: 'eyebrow' }, 'All rated questions'), bars);
  }

  /** One rated question: summary, distribution, agreement, split, outliers. */
  function questionCard({ item, form, values }) {
    const min = Number(item.min ?? 1);
    const max = Number(item.max ?? 9);
    const points = item.anchors
      ? Object.keys(item.anchors).map(Number).sort((a, b) => a - b)
      : Array.from({ length: max - min + 1 }, (_, i) => min + i);

    const stats = describe(values);
    const agreement = consensus(values, min, max);
    const reading = describeConsensus(agreement);
    const clusters = findClusters(values, { min, max });
    const outliers = findOutliers(values);
    const word = nearestAnchor(stats.mean, item.anchors);

    const card = el('div', { class: 'card stack', style: { marginBottom: 'var(--sp-4)' } },
      el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('div', { style: { fontWeight: '620' } }, item.label),
          el('div', { class: 'muted' }, form.name)),
        el('div', { class: 'row row--wrap' },
          reading && badge(reading.label, reading.tone),
          badge(`n = ${stats.n}`, 'neutral'))),

      // Headline numbers.
      el('div', { class: 'grid grid--3' },
        statTile('Mean', String(stats.mean), word ? `reads as "${word}"` : ''),
        statTile('Median', String(stats.median),
          stats.mode ? `most common: ${stats.mode.values.map((v) => item.anchors?.[v] || v).join(', ')}` : ''),
        statTile('Range', `${stats.min}–${stats.max}`, `spread of ${stats.range}`),
        statTile('Std dev', stats.stdev == null ? '—' : String(stats.stdev),
          stats.reliable ? '' : 'too few to be meaningful')),

      distributionChart(histogram(values, points), item.anchors, max));

    if (agreement != null) {
      mount(card, el('div', {},
        el('div', { class: 'eyebrow' }, 'Agreement'),
        el('div', { class: 'row row--wrap' },
          el('div', { class: 'meter', style: { flex: '1', minWidth: '10rem' } },
            el('div', { class: 'meter__fill', style: { width: `${agreement * 100}%` } })),
          el('span', { class: 'mono muted' }, agreement.toFixed(2))),
        el('div', { class: 'field__hint' },
          '1.00 means everyone chose the same rating; 0.00 means the group is split between the extremes.')));
    }

    if (clusters?.split) {
      const [lowGroup, highGroup] = clusters.groups;
      mount(card, notice('warn', 'Opinion is split, not merely average',
        el('p', {}, `Two distinct groups: ${pluralize(lowGroup.size, 'response')} around `
          + `${describePoint(lowGroup.centre, item.anchors)}, and ${pluralize(highGroup.size, 'response')} around `
          + `${describePoint(highGroup.centre, item.anchors)}. The mean of ${stats.mean} sits between them and `
          + 'describes nobody — read both groups rather than the average.')));
    }

    if (!outliers.supported) {
      mount(card, el('p', { class: 'field__hint' },
        `Outlier detection needs at least ${MIN_FOR_OUTLIERS} responses — currently ${stats.n}.`));
    } else if (outliers.outliers.length) {
      mount(card, notice('info', `${pluralize(outliers.outliers.length, 'unusual rating')}`,
        el('p', {}, 'Sitting far from the rest of the group: '
          + outliers.outliers.map((o) => describePoint(o.value, item.anchors)).join(', ')
          + `. The group's median is ${describePoint(outliers.median, item.anchors)}.`),
        el('p', { class: 'field__hint', style: { marginTop: 'var(--sp-2)' } },
          'Unusual is not wrong — a lone dissenting view is often the one worth reading.')));
    }

    return card;
  }

  function describePoint(value, anchors) {
    const word = anchors ? nearestAnchor(value, anchors) : null;
    return word ? `${word} (${round(value, 1)})` : String(round(value, 1));
  }

  function statTile(label, value, note) {
    return el('div', { class: 'stat' },
      el('div', { class: 'stat__label' }, label),
      el('div', { class: 'stat__value' }, value),
      note && el('div', { class: 'stat__note' }, note));
  }

  /** Histogram across the scale, so shape is visible rather than inferred. */
  function distributionChart(bins, anchors, max) {
    const peak = Math.max(...bins.map((b) => b.count), 1);
    const chart = el('div', { class: 'hist' });
    for (const bin of bins) {
      mount(chart, el('div', { class: 'hist__col', title: `${bin.count} response(s)` },
        el('div', { class: 'hist__bar-wrap' },
          el('div', {
            class: `hist__bar${bin.count ? '' : ' hist__bar--empty'}`,
            style: { height: `${(bin.count / peak) * 100}%` },
          }, bin.count ? el('span', { class: 'hist__count' }, String(bin.count)) : null)),
        el('div', { class: 'hist__label' }, anchors?.[bin.value] || String(bin.value))));
    }
    void max;
    return el('div', {},
      el('div', { class: 'eyebrow', style: { marginBottom: 'var(--sp-2)' } }, 'Distribution'),
      chart);
  }

  /** Means compared across cohorts. */
  function segmentCard(rows) {
    const valuesOf = (r) => Object.values(r.answers || {}).filter((v) => typeof v === 'number');
    const dimensions = [
      { id: 'asClass', label: 'AS level', key: (r) => r.asClass },
      { id: 'semester', label: 'Term', key: (r) => [r.schoolYear, r.semester].filter(Boolean).join(' ') },
      { id: 'form', label: 'Form', key: (r) => requestsById.get(r.requestId)?.title },
    ];

    const host = el('div', {});
    const paint = (dimension) => {
      const { segments, suppressed, spread } = compareSegments(rows, dimension.key, valuesOf,
        { minSize: PRIVACY.minResponsesToShow });
      remount(host);
      if (!segments.length) {
        mount(host, el('p', { class: 'muted' },
          `No cohort has ${PRIVACY.minResponsesToShow} or more ratings yet.`));
        return;
      }
      const body = el('tbody');
      for (const seg of segments) {
        mount(body, el('tr', {},
          el('td', {}, seg.label),
          el('td', { class: 'num' }, String(seg.n)),
          el('td', { class: 'num' }, String(seg.mean)),
          el('td', { class: 'num' }, String(seg.median)),
          el('td', { class: 'num' }, seg.stdev == null ? '—' : String(seg.stdev))));
      }
      mount(host,
        el('div', { class: 'table-wrap' },
          el('table', { class: 'table' },
            el('thead', {}, el('tr', {},
              el('th', {}, dimension.label), el('th', { class: 'num' }, 'Ratings'),
              el('th', { class: 'num' }, 'Mean'), el('th', { class: 'num' }, 'Median'),
              el('th', { class: 'num' }, 'Std dev'))),
            body)),
        spread != null && spread >= 1
          ? notice('info', 'Cohorts differ',
            el('p', {}, `${spread} points between the highest and lowest ${dimension.label.toLowerCase()}.`))
          : null,
        suppressed
          ? el('p', { class: 'field__hint' },
            `${suppressed} cohort(s) hidden — fewer than ${PRIVACY.minResponsesToShow} ratings.`)
          : null);
    };

    const card = el('div', { class: 'card stack' },
      el('div', { class: 'row row--between row--wrap' },
        el('div', { class: 'eyebrow' }, 'Breakdown by cohort'),
        select(dimensions.map((d) => ({ value: d.id, label: d.label })), {
          onchange: (e) => paint(dimensions.find((d) => d.id === e.target.value)),
          cls: 'select',
        })),
      host);
    paint(dimensions[0]);
    return card;
  }

  /** Respondents who rate consistently away from the group. */
  function raterCard(rows, questions) {
    const items = [...new Map(questions.map((q) => [q.item.id, q.item])).values()];
    const result = findRespondentOutliers(rows, items);

    const card = el('div', { class: 'card stack', style: { marginTop: 'var(--sp-4)' } },
      el('div', { class: 'eyebrow' }, 'Consistently different raters'));

    if (!result.supported) {
      mount(card, el('p', { class: 'field__hint' }, `${result.reason} — currently ${rows.length}.`));
      return card;
    }
    if (!result.respondents.length) {
      mount(card, el('p', { class: 'muted' }, 'Nobody rated consistently apart from the group.'));
      return card;
    }

    for (const row of result.respondents) {
      const direction = row.drift > 0 ? 'above' : 'below';
      mount(card, el('div', { class: 'row row--between row--wrap' },
        el('div', {},
          el('div', { style: { fontWeight: '550' } },
            row.response.anonymous ? 'An anonymous respondent'
              : (row.response.respondent?.name || 'Unnamed')),
          el('div', { class: 'muted' },
            `Rated ${Math.abs(row.drift)} points ${direction} the group median across `
            + `${pluralize(row.answered, 'question')}`)),
        badge(row.drift > 0 ? 'More positive' : 'More critical',
          row.drift > 0 ? 'ok' : 'warn')));
    }
    mount(card, el('p', { class: 'field__hint' },
      'One person rating consistently apart may be a genuine dissenting experience or simply a '
      + 'harsher scale. Read their written answers before drawing a conclusion.'));
    return card;
  }

  /* ---------------- written feedback ---------------- */

  /** Every text answer in scope, with where it came from. */
  function textEntries(rows) {
    const entries = [];
    for (const response of rows) {
      const form = formsById.get(response.formId);
      if (!form) continue;
      for (const item of formItems(form)) {
        if (item.type !== 'text') continue;
        const text = response.answers?.[item.id];
        if (!text || !String(text).trim()) continue;
        entries.push({
          id: `${response.id}:${item.id}`,
          text: String(text),
          question: item.label,
          request: requestsById.get(response.requestId)?.title || '—',
          when: response.submittedAt,
          response,
        });
      }
    }
    return entries;
  }

  function textPanel(rows) {
    const entries = textEntries(rows);
    const section = el('section', {},
      el('h3', { class: 'section-title' }, `Written feedback (${entries.length})`));

    if (!entries.length) {
      mount(section, el('p', { class: 'muted' }, 'No written answers in this range.'));
      return section;
    }

    const host = el('div', {});
    const views = [
      { id: 'sentiment', label: 'Sentiment', render: () => sentimentView(entries) },
      { id: 'cloud', label: 'Word cloud', render: () => cloudView(entries) },
      { id: 'read', label: 'Read all', render: () => readView(entries) },
    ];

    const tabs = el('div', { class: 'tabs', role: 'tablist' });
    const show = (view) => {
      for (const btn of tabs.querySelectorAll('.tab')) {
        btn.setAttribute('aria-selected', String(btn.dataset.view === view.id));
      }
      remount(host, view.render());
    };
    for (const view of views) {
      mount(tabs, el('button', {
        type: 'button', class: 'tab', role: 'tab', dataset: { view: view.id },
        'aria-selected': String(view.id === 'sentiment'),
        onclick: () => show(view),
      }, view.label));
    }

    mount(section, tabs, host);
    show(views[0]);
    return section;
  }

  function sentimentView(entries) {
    const summary = summariseSentiment(entries.map((e) => e.text));
    const wrap = el('div', { class: 'stack' });

    if (summary.average == null) {
      mount(wrap,
        notice('info', 'No sentiment could be read',
          el('p', {}, 'None of the written answers contain words in the sentiment lexicon. '
            + 'The answers themselves are below — read them directly.')),
        el('div', { class: 'stack-sm' }, ...entries.map((entry) => el('div', { class: 'quote' },
          el('div', { class: 'eyebrow', style: { marginBottom: 'var(--sp-2)' } }, entry.question),
          entry.text,
          el('footer', {}, `${fmtDate(entry.when)} · ${entry.request}`)))));
      return wrap;
    }

    const total = summary.buckets.positive + summary.buckets.neutral + summary.buckets.negative;
    mount(wrap,
      el('div', { class: 'grid grid--3' },
        statTile('Overall', summary.label, `score ${summary.average} on a -5 to +5 scale`),
        statTile('Positive', String(summary.buckets.positive), pct(summary.buckets.positive, total)),
        statTile('Neutral or mixed', String(summary.buckets.neutral), pct(summary.buckets.neutral, total)),
        statTile('Negative', String(summary.buckets.negative), pct(summary.buckets.negative, total))),

      notice('info', 'How to read this',
        el('p', {}, 'Sentiment here is a lexicon count, not comprehension. It cannot read sarcasm, '
          + 'context or a cadet quoting someone else, and it runs on this device precisely so the '
          + 'feedback never leaves your Drive. Use it to decide what to read first — never as a '
          + 'substitute for reading.')));

    if (summary.unreadable) {
      mount(wrap, el('p', { class: 'field__hint' },
        `${summary.unreadable} answer(s) contained no recognised sentiment words and are not counted above.`));
    }

    // Every answer appears. Scored ones come first, most negative at the top —
    // those are what an instructor should read first — and answers the lexicon
    // could not read follow rather than vanishing, because an answer with no
    // recognised sentiment word is still feedback somebody wrote.
    const ranked = summary.scored
      .map((row, i) => ({ ...row, entry: entries[i] }))
      .sort((a, b) => {
        if (Boolean(a.hits.length) !== Boolean(b.hits.length)) return a.hits.length ? -1 : 1;
        return a.score - b.score;
      });

    const list = el('div', { class: 'stack-sm' });
    for (const row of ranked) {
      mount(list, el('div', { class: 'quote' },
        el('div', { class: 'row row--between row--wrap', style: { marginBottom: 'var(--sp-2)' } },
          el('span', { class: 'eyebrow' }, row.entry.question),
          row.hits.length
            ? badge(`${row.label} · ${row.score}`, row.tone)
            : badge('Not scored', 'neutral')),
        row.entry.text,
        el('footer', {}, `${fmtDate(row.entry.when)} · ${row.entry.request}`)));
    }
    mount(wrap,
      el('div', { class: 'eyebrow' }, `All ${pluralize(ranked.length, 'answer')}, most negative first`),
      list);
    return wrap;
  }

  function pct(part, total) {
    return total ? `${Math.round((part / total) * 100)}% of scored answers` : '';
  }

  function cloudView(entries) {
    const texts = entries.map((e) => e.text);
    const terms = wordFrequencies(texts, { limit: 60 });
    const phrases = phraseFrequencies(texts, { limit: 12 });
    const wrap = el('div', { class: 'stack' });

    if (!terms.length) {
      mount(wrap, el('p', { class: 'muted' }, 'Not enough distinct words to build a cloud.'));
      return wrap;
    }

    const matches = el('div', {});
    const showMatches = (term) => {
      const re = new RegExp(`\\b${term.stem}`, 'i');
      const hits = entries.filter((e) => re.test(e.text));
      remount(matches,
        el('div', { class: 'eyebrow' }, `"${term.term}" — ${pluralize(hits.length, 'response')}`),
        el('div', { class: 'stack-sm' }, ...hits.map((e) => el('div', { class: 'quote' },
          el('div', { html: highlight(e.text, [{ matched: term.term }]) }),
          el('footer', {}, `${e.question} · ${fmtDate(e.when)}`)))));
    };

    const cloud = renderWordCloud(terms, { onSelect: showMatches });
    mount(wrap,
      el('div', { class: 'card' }, cloud),
      el('p', { class: 'field__hint' },
        'Sized by how many people used the word, not how often it appears, so one long answer '
        + 'cannot dominate. Select a word to read the answers containing it.'),
      phrases.length ? el('div', {},
        el('div', { class: 'eyebrow', style: { marginBottom: 'var(--sp-2)' } }, 'Common pairs'),
        el('div', { class: 'row row--wrap' },
          ...phrases.map((p) => el('span', { class: 'chip' }, p.phrase,
            el('span', { class: 'mono faint' }, String(p.count)))))) : null,
      el('div', {},
        el('div', { class: 'eyebrow', style: { marginBottom: 'var(--sp-2)' } }, 'Ranked terms'),
        renderTermTable(terms, { onSelect: showMatches })),
      matches);
    return wrap;
  }

  function readView(entries) {
    const list = el('div', { class: 'stack' });
    for (const [question, group] of groupBy(entries, (e) => e.question)) {
      const card = el('div', { class: 'card stack-sm' }, el('div', { class: 'eyebrow' }, question));
      for (const entry of group) {
        mount(card, el('blockquote', { class: 'quote' }, entry.text,
          el('footer', {}, `${fmtDate(entry.when)} · ${entry.request}`)));
      }
      mount(list, card);
    }
    return list;
  }

  /* ---------------- safety screening ---------------- */

  /**
   * Screens every written answer in scope for language that needs a person to
   * read it now.
   *
   * This runs across *all* responses, including forms whose results are
   * withheld for anonymity. A disclosure of hazing or a cadet in crisis cannot
   * wait for a third response to arrive, and suppressing it silently would be
   * the worse failure. The privacy cost is real and is stated rather than
   * hidden: on a withheld form the content stays behind a deliberate click that
   * says plainly it may identify the author.
   */
  function safetyPanel(rows, withheld) {
    const blocked = new Set(withheld.map((w) => w.request.id));
    const entries = textEntries(rows);
    const result = screenAll(entries);

    if (!result.flaggedEntries) {
      return el('section', {},
        el('div', { class: 'notice notice--ok' },
          icon('checkCircle'),
          el('div', {},
            el('strong', { class: 'notice__title' }, 'Safety screen: nothing flagged'),
            el('p', {}, `${pluralize(result.scanned, 'written answer')} checked against the `
              + 'hazing, harassment, discrimination, violence, self-harm, substance and integrity '
              + 'word lists. A clear screen is not proof that nothing was reported — it only means '
              + 'no listed phrase appeared.'))));
    }

    const section = el('section', {},
      el('h3', { class: 'section-title' }, 'Safety screen'),
      notice('danger', `${pluralize(result.flaggedEntries, 'answer')} flagged for review`,
        el('p', {}, 'These contain language matching the safety and security word lists. '
          + 'A match is a prompt to read the response, not a finding — the list cannot tell '
          + '"we discussed hazing prevention" from "I was hazed". Read each one and follow your '
          + 'detachment\'s reporting procedures.')));

    for (const category of result.categories) {
      const card = el('div', { class: 'card stack', style: { marginTop: 'var(--sp-4)' } },
        el('div', { class: 'row row--between row--wrap' },
          el('div', {},
            el('div', { style: { fontWeight: '620' } }, category.label),
            el('div', { class: 'muted' }, category.note)),
          badge(category.severity === 'critical' ? 'Critical' : 'Elevated',
            category.severity === 'critical' ? 'danger' : 'warn', 'alert')));

      for (const entry of category.entries) {
        const isWithheld = blocked.has(entry.response.requestId);
        const body = el('div', {});

        if (isWithheld) {
          // Alert without exposing: the instructor learns a flagged answer
          // exists and chooses, knowingly, whether to read it.
          mount(body,
            notice('warn', 'This form\'s results are withheld for anonymity',
              el('p', {}, `Only ${pluralize(
                rows.filter((r) => r.requestId === entry.response.requestId).length, 'response')} `
                + 'has been submitted, so opening this may identify who wrote it.'),
              el('div', { style: { marginTop: 'var(--sp-3)' } },
                el('button', {
                  type: 'button', class: 'btn btn--sm btn--danger',
                  onclick: (e) => {
                    e.currentTarget.closest('.notice').remove();
                    mount(body, flaggedQuote(entry));
                  },
                }, icon('eye'), 'Show anyway — this may identify the author'))));
        } else {
          mount(body, flaggedQuote(entry));
        }
        mount(card, body);
      }
      mount(section, card);
    }

    mount(section, el('p', { class: 'field__hint' },
      'The word lists live in js/analysis/lexicon.js and are meant to be edited — add the terms '
      + 'your detachment actually uses.'));
    return section;
  }

  function flaggedQuote(entry) {
    return el('div', { class: 'quote quote--flagged' },
      el('div', { class: 'row row--wrap', style: { marginBottom: 'var(--sp-2)' } },
        el('span', { class: 'eyebrow' }, entry.question),
        ...entry.matches.slice(0, 4).map((m) => badge(m.matched, 'danger'))),
      el('div', { html: highlight(entry.text, entry.matches) }),
      el('footer', {}, `${fmtDate(entry.when)} · ${entry.request}`));
  }

  function responseList(rows) {
    const list = el('div', { class: 'list' });
    for (const response of [...rows].sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))) {
      const request = requestsById.get(response.requestId);
      mount(list, el('button', {
        type: 'button', class: 'list__item',
        onclick: () => openResponse(response, request),
      },
        el('span', { class: 'list__main' },
          el('span', { class: 'list__title', style: { display: 'block' } },
            request?.title || 'Deleted form'),
          el('span', { class: 'list__meta', style: { display: 'block' } },
            request?.feedbackId ? `${request.feedbackId} · ` : '',
            response.anonymous ? 'Anonymous' : (response.respondent?.name || 'Unnamed'),
            ' · ', fmtDateTime(response.submittedAt))),
        icon('chevronRight', { cls: 'list__chev' })));
    }
    return el('section', {},
      el('h3', { class: 'section-title' }, `Individual responses (${rows.length})`), list);
  }

  /** Who has and has not submitted — from receipts, never from the answers. */
  function completion(inScope) {
    const section = el('section', {},
      el('h3', { class: 'section-title' }, 'Completion'),
      el('p', { class: 'muted' },
        'Built from submission receipts, which are stored separately from the answers — '
        + 'so this works even for anonymous feedback.'));

    const host2 = el('div', {}, spinner('Checking receipts…'));
    mount(section, host2);

    (async () => {
      const cards = el('div', { class: 'stack' });
      for (const request of inScope.slice(0, 25)) {
        const { receipts } = await loadResponsesFor(request.id);
        const submitted = new Set(receipts.map((r) => r.username));
        const targeted = request.assignedUsernames?.length
          ? students.filter((s) => request.assignedUsernames.includes(s.username))
          : students.filter((s) => !request.asClass || !s.asClass || s.asClass === request.asClass);
        const outstanding = targeted.filter((s) => !submitted.has(s.username));
        // With nobody on the roster matching this form there is no denominator,
        // so completion is unknown rather than 0% — reporting a red zero next to
        // "8 submitted" would be three contradictory statements at once.
        const known = targeted.length > 0;
        const pct = known ? Math.round((submitted.size / targeted.length) * 100) : null;

        const held = request.anonymous && submitted.size > 0
          && submitted.size < PRIVACY.minResponsesToShow;

        mount(cards, el('div', { class: 'card stack-sm' },
          el('div', { class: 'row row--between row--wrap' },
            el('div', {},
              el('div', { style: { fontWeight: '570' } },
                request.feedbackId ? `${request.feedbackId} — ${request.title}` : request.title),
              el('div', { class: 'muted' }, known
                ? `${submitted.size} of ${targeted.length} submitted`
                : `${pluralize(submitted.size, 'response')} received`)),
            el('div', { class: 'row row--wrap' },
              held && badge('Results withheld', 'warn', 'lock'),
              known
                ? badge(`${pct}%`, pct >= 80 ? 'ok' : pct >= 40 ? 'warn' : 'danger',
                  pct >= 80 ? 'checkCircle' : 'clock')
                : badge('No roster match', 'neutral', 'users'))),
          known
            ? el('div', { class: 'meter' }, el('div', { class: 'meter__fill', style: { width: `${pct}%` } }))
            : null,
          !known
            ? el('div', { class: 'muted' },
              request.asClass
                ? `No active cadet accounts at ${request.asClass}, so completion cannot be measured.`
                : 'No active cadet accounts, so completion cannot be measured.')
            : outstanding.length
              ? el('details', {},
                el('summary', { class: 'muted' }, `${pluralize(outstanding.length, 'student')} outstanding`),
                el('div', { class: 'row row--wrap', style: { marginTop: 'var(--sp-2)' } },
                  ...outstanding.map((s) => el('span', { class: 'chip' }, s.name,
                    el('span', { class: 'mono faint' }, s.username)))))
              : el('div', { class: 'muted' }, 'Everyone targeted has responded.')));
      }
      remount(host2, cards.childNodes.length ? cards
        : el('p', { class: 'muted' }, 'No forms match these filters.'));
    })();

    return section;
  }

  async function openResponse(response, request) {
    const form = formsById.get(response.formId);
    const choice = await modal({
      title: request?.title || 'Response',
      body: el('div', { class: 'stack' },
        el('div', { class: 'row row--wrap' },
          request?.feedbackId && badge(request.feedbackId, 'info'),
          badge(response.anonymous ? 'Anonymous' : (response.respondent?.name || 'Unnamed'),
            response.anonymous ? 'neutral' : 'info', response.anonymous ? 'eye' : 'users'),
          badge(fmtDateTime(response.submittedAt), 'neutral', 'clock')),
        form
          ? renderForm(form, { values: response.answers, readonly: true, namespace: `v-${response.id}` })
          : notice('warn', 'Form definition missing',
            el('pre', { class: 'tree' }, JSON.stringify(response.answers, null, 2)))),
      actions: [
        { label: 'Delete', value: 'delete', variant: 'danger' },
        { label: 'Close', value: 'close', autofocus: true },
      ],
    });
    if (choice !== 'delete') return;
    await deleteResponse(response, request);
  }

  /**
   * Deleting a response is the one action that can destroy a safety
   * disclosure, so a flagged response is treated differently: an instructor
   * cannot remove it at all, and an admin must give a reason that is recorded.
   *
   * This is a client-side app, so someone determined could bypass the screen
   * through the console. What this guarantees is that deleting a disclosure
   * takes a deliberate act rather than an idle click, and that the ordinary
   * path always leaves a record.
   */
  async function deleteResponse(response, request) {
    const flagged = screenAll(
      textEntries([response]).map((e) => ({ ...e })),
    );

    if (flagged.flaggedEntries) {
      const categories = flagged.categories.map((c) => c.label).join(', ');

      if (!hasRole(ROLES.admin)) {
        await modal({
          title: 'This response cannot be deleted',
          body: el('div', { class: 'stack' },
            notice('danger', 'It contains language flagged by the safety screen',
              el('p', {}, `Flagged for: ${categories}.`),
              el('p', {}, 'Feedback that may report hazing, harassment, discrimination or a '
                + 'cadet in crisis cannot be removed from the Instructor Panel. If it needs to '
                + 'go, a database administrator can remove it and the deletion will be recorded '
                + 'against their name.')),
            el('p', { class: 'field__hint' },
              'If you are the subject of this feedback, refer it rather than handling it yourself.')),
          actions: [{ label: 'Close', value: true, autofocus: true }],
        });
        return;
      }

      const reason = el('textarea', {
        class: 'textarea', rows: '3',
        placeholder: 'e.g. Duplicate submission, referred to the commander on 14 Aug.',
      });
      const proceed = await modal({
        title: 'Delete flagged feedback',
        body: el('div', { class: 'stack' },
          notice('danger', 'This response was flagged by the safety screen',
            el('p', {}, `Flagged for: ${categories}. Deleting it destroys a possible report.`)),
          field('Why is it being deleted?', reason, {
            required: true,
            hint: 'Recorded in the audit trail against your account, permanently.',
          })),
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Delete and record', value: 'go', variant: 'danger' },
        ],
      });
      if (proceed !== 'go') return;
      if (!reason.value.trim()) {
        toast('A reason is required to delete flagged feedback.', 'warn', 6000);
        return;
      }

      await removeResponse(response.requestId, response.id, reason.value.trim());
      await writeAudit({
        action: AUDIT.responseDeleted,
        summary: `Deleted FLAGGED feedback from "${request?.title || response.requestId}"`,
        target: request?.feedbackId || response.requestId,
        reason: reason.value.trim(),
        detail: { categories: flagged.categories.map((c) => c.categoryId), responseId: response.id },
      });
      toast('Deleted, and recorded in the audit trail.', 'ok', 6000);
      navigate('/instructor?tab=analysis');
      return;
    }

    // A reason is required for every deletion now, not only flagged ones: the
    // server enforces it, and an unexplained gap in the record is the thing the
    // audit trail exists to prevent.
    const why = el('textarea', {
      class: 'textarea', rows: '3',
      placeholder: 'e.g. Duplicate submission from the same cadet.',
    });
    const go = await modal({
      title: 'Delete this response?',
      body: el('div', { class: 'stack' },
        el('p', {}, 'This cannot be undone.'),
        field('Why is it being deleted?', why, {
          required: true,
          hint: 'Recorded in the audit trail against your account.',
        })),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Delete and record', value: 'go', variant: 'danger' },
      ],
    });
    if (go !== 'go') return;
    if (why.value.trim().length < 4) {
      toast('A reason is required to delete feedback.', 'warn', 6000);
      return;
    }
    await removeResponse(response.requestId, response.id, why.value.trim());
    await writeAudit({
      action: AUDIT.responseDeleted,
      summary: `Deleted a response to "${request?.title || response.requestId}"`,
      target: request?.feedbackId || response.requestId,
      reason: why.value.trim(),
      detail: { responseId: response.id },
    });
    toast('Response deleted.', 'ok');
    navigate('/instructor?tab=analysis');
  }

  function exportRows() {
    // Export is a disclosure too — it obeys the same threshold, otherwise it
    // would simply be the way around it.
    const { visible: rows, withheld } = partition(filtered());
    if (withheld.length) {
      toast(`${pluralize(withheld.length, 'form')} withheld from the export — too few responses.`,
        'warn', 6000);
    }
    if (!rows.length) return toast('Nothing to export.', 'warn');
    const questionIds = new Set();
    rows.forEach((r) => Object.keys(r.answers || {}).forEach((k) => questionIds.add(k)));

    const itemFor = (id) => {
      for (const form of forms) {
        const item = formItems(form).find((q) => q.id === id);
        if (item) return item;
      }
      return null;
    };
    const labelFor = (id) => itemFor(id)?.label || id;

    download(`feedback-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, [
      { key: 'feedbackId', label: 'Feedback ID', get: (r) => requestsById.get(r.requestId)?.feedbackId || '' },
      { key: 'event', label: 'Class / event', get: (r) => requestsById.get(r.requestId)?.title || '' },
      { key: 'asClass', label: 'AS level', get: (r) => r.asClass || '' },
      { key: 'submittedAt', label: 'Submitted', get: (r) => r.submittedAt },
      { key: 'who', label: 'Respondent', get: (r) => (r.anonymous ? 'anonymous' : r.respondent?.name || '') },
      // Both columns: the number for a spreadsheet, the word for a human.
      ...[...questionIds].flatMap((id) => {
        const item = itemFor(id);
        const base = {
          key: id, label: labelFor(id),
          get: (r) => (Array.isArray(r.answers?.[id]) ? r.answers[id].join('; ') : r.answers?.[id] ?? ''),
        };
        if (item?.type !== 'scale' || !item.anchors) return [base];
        return [base, {
          key: `${id}__word`, label: `${labelFor(id)} (rating)`,
          get: (r) => {
            const v = r.answers?.[id];
            return v == null ? '' : (item.anchors[v] ?? item.anchors[String(v)] ?? '');
          },
        }];
      }),
    ]), 'text/csv');
    return toast('CSV exported.', 'ok');
  }

  draw();
}
