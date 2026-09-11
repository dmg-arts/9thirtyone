/**
 * Feedback grouped by the person it reflects on.
 *
 * The question here is not "how did the drill block go" but "how is this
 * instructor doing", and the app could once answer it only for a commander.
 * Three tiers now, because reviewing the instructors under you is an oversight
 * function and cadre have one:
 *
 *   - an **instructor** sees their own results, and anything they issued;
 *   - **cadre** see the instructors they oversee, and themselves;
 *   - a **commander** sees everyone, cadre included.
 *
 * The narrowing is done by `loadPeople`, which in proxy mode is the *server*
 * deciding what comes back rather than this screen filtering something wider it
 * was already sent. `js/people-scope.js` holds the rule and is honest about
 * where it stops being a boundary.
 *
 * THAT LENS DESERVES CARE, AND GETS IT
 *
 * Slicing feedback by person is the point and also the risk. Two things follow,
 * and both are enforced rather than advised:
 *
 *   - **The disclosure threshold applies to each person's total**, not only to
 *     each form. An instructor with two anonymous responses across two forms has
 *     two identifiable cadets, and showing "their average" would expose both as
 *     surely as showing the responses.
 *   - **A single form's results stay withheld** even when the person's total
 *     clears the threshold, because the per-form view is where a small cohort
 *     is identifiable.
 *
 * The numbers are also, deliberately, not a ranking. Response counts differ,
 * cohorts differ, and a mean of nine ordinal points is not a performance score.
 * The screen shows what was said and how many said it, and leaves the judgement
 * to the person qualified to make it.
 */

import {
  el, icon, badge, field, select, notice, spinner, emptyState, pluralize, fmtDate,
  mount, remount } from '../util.js';
import { PRIVACY, ROLE_LABELS, nearestAnchor, scaleValues } from '../config.js';
import { describe, histogram } from '../analysis/stats.js';
import { inSpaces } from '../panels.js';
import { loadPeople } from '../data-source.js';
import { subjectOf } from '../people-scope.js';
import { spaceShort, isRestricted } from '../spaces.js';
import { navigate } from '../router.js';

/** Ratings out of one response, ignoring text answers. */
function ratingsOf(response, form) {
  const items = (form?.sections || []).flatMap((s) => s.items || []);
  const scales = new Set(items.filter((i) => i.type === 'scale').map((i) => i.id));
  return Object.entries(response.answers || {})
    .filter(([id, value]) => scales.has(id) && Number.isFinite(value))
    .map(([, value]) => value);
}

/** Written answers out of one response. */
function textsOf(response, form) {
  const items = (form?.sections || []).flatMap((s) => s.items || []);
  const texts = new Set(items.filter((i) => i.type === 'text').map((i) => i.id));
  return Object.entries(response.answers || {})
    .filter(([id, value]) => texts.has(id) && typeof value === 'string' && value.trim())
    .map(([, value]) => value.trim());
}

/**
 * Gathers every request attributed to each member of staff.
 *
 * Attribution is `subject` where a request carries one, falling back to
 * `createdBy` for requests issued before the field existed. Anything with
 * neither is grouped as unattributed rather than silently dropped — a commander
 * should see that the data is incomplete, not a tidy picture missing rows.
 */
function groupByPerson(requests, responses, formsById, staffByUsername) {
  const groups = new Map();
  const byRequest = new Map();
  for (const response of responses) {
    if (!byRequest.has(response.requestId)) byRequest.set(response.requestId, []);
    byRequest.get(response.requestId).push(response);
  }

  for (const request of requests) {
    const key = subjectOf(request);
    if (!groups.has(key)) {
      groups.set(key, {
        username: key,
        person: key ? staffByUsername.get(key) || null : null,
        requests: [],
        responses: [],
        ratings: [],
        texts: 0,
      });
    }
    const group = groups.get(key);
    const rows = byRequest.get(request.id) || [];
    const form = formsById.get(request.formId);

    group.requests.push({ request, responses: rows, form });
    group.responses.push(...rows);
    for (const row of rows) {
      group.ratings.push(...ratingsOf(row, form));
      if (textsOf(row, form).length) group.texts++;
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.username) return 1;
    if (!b.username) return -1;
    return (a.person?.name || a.username).localeCompare(b.person?.name || b.username);
  });
}

export async function renderPeople(host, { spaces = null } = {}) {
  remount(host, spinner('Gathering feedback by person…'));

  let people;
  try {
    people = await loadPeople();
  } catch (err) {
    return remount(host, notice('danger', 'Could not load feedback', el('p', {}, err.message)));
  }

  // Already narrowed to who this account may see. What remains is the panel
  // scope, so a commander reviewing cadre material is not shown detachment
  // feedback in the same totals.
  const requests = spaces ? people.requests.filter(inSpaces(spaces)) : people.requests;
  const inScope = new Set(requests.map((r) => r.id));
  const responses = spaces
    ? people.responses.filter((r) => inScope.has(r.requestId))
    : people.responses;

  const formsById = new Map(people.forms.map((f) => [f.id, f]));
  // Anyone who could be the subject of feedback and this account may see.
  // Cadets are absent because this is feedback *about* instruction and theirs
  // is the input to it; who else appears is the tier's business, not this
  // screen's — see loadPeople.
  const staff = people.staff;
  const staffByUsername = new Map(staff.map((a) => [a.username, a]));
  const groups = groupByPerson(requests, responses, formsById, staffByUsername);

  // Staff with no feedback at all still belong on the list: "nobody has asked
  // for feedback about this instructor" is itself worth a commander knowing.
  for (const person of staff) {
    if (groups.some((g) => g.username === person.username)) continue;
    groups.push({ username: person.username, person, requests: [], responses: [], ratings: [], texts: 0 });
  }

  const state = { selected: null, schoolYear: '', semester: '' };
  const detail = el('div', {});
  const list = el('div', {});

  const visible = () => groups.filter((group) => {
    if (!state.schoolYear && !state.semester) return true;
    return group.requests.some(({ request }) =>
      (!state.schoolYear || request.schoolYear === state.schoolYear)
      && (!state.semester || request.semester === state.semester));
  });

  function drawList() {
    const rows = visible();
    if (!rows.length) {
      return remount(list, emptyState({
        iconName: 'users', title: 'Nobody to show',
        message: 'No instructors or cadre match this filter.',
      }));
    }

    const body = el('tbody');
    for (const group of rows) {
      const count = group.responses.length;
      const enough = count >= PRIVACY.minResponsesToShow;
      const summary = enough && group.ratings.length ? describe(group.ratings) : null;

      mount(body, el('tr', {
        style: { cursor: 'pointer' },
        onclick: () => { state.selected = group.username; draw(); },
      },
        el('td', {},
          el('div', { style: { fontWeight: '550' } },
            group.person?.name || (group.username ? group.username : 'Not attributed')),
          el('div', { class: 'faint' },
            group.username
              ? (group.person?.roles || []).map((r) => ROLE_LABELS[r] || r).join(', ')
              : 'Issued before this feature existed')),
        el('td', { class: 'num' }, String(group.requests.length)),
        el('td', { class: 'num' }, String(count)),
        el('td', {},
          summary
            ? el('span', {},
              el('strong', {}, nearestAnchor(summary.mean) || '—'),
              el('span', { class: 'faint' }, ` · ${summary.mean.toFixed(1)}`))
            : el('span', { class: 'faint' },
              count ? `Withheld — under ${PRIVACY.minResponsesToShow}` : 'No responses')),
        el('td', { class: 'num' },
          el('button', { type: 'button', class: 'btn btn--sm btn--ghost' }, icon('chevronRight')))));
    }

    remount(list, el('div', { class: 'table-wrap' },
      el('table', { class: 'table' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Person'),
          el('th', { class: 'num' }, 'Requests'),
          el('th', { class: 'num' }, 'Responses'),
          el('th', {}, 'Average'),
          el('th', {}, ''))),
        body)));
  }

  function drawDetail() {
    if (!state.selected) return remount(detail, el('span', {}));
    const group = groups.find((g) => g.username === state.selected);
    if (!group) return remount(detail, el('span', {}));

    const count = group.responses.length;
    const enough = count >= PRIVACY.minResponsesToShow;
    const summary = enough && group.ratings.length ? describe(group.ratings) : null;

    const header = el('div', { class: 'row row--between row--wrap' },
      el('div', {},
        el('h3', { class: 'section-title', style: { margin: '0' } },
          group.person?.name || group.username || 'Not attributed'),
        el('p', { class: 'muted', style: { margin: '0' } },
          `${pluralize(group.requests.length, 'feedback request')} · `
          + `${pluralize(count, 'response')}`)),
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: () => { state.selected = null; draw(); },
      }, icon('x'), 'Close'));

    if (!enough) {
      return remount(detail, el('section', { class: 'card stack' }, header,
        notice('warn', `Withheld — fewer than ${PRIVACY.minResponsesToShow} responses`,
          el('p', {}, count
            ? `Only ${pluralize(count, 'response')} ${count === 1 ? 'has' : 'have'} been `
              + 'submitted about this person. '
              + 'Showing an average, a distribution or the written answers would identify '
              + 'the people who wrote them, so none of it is shown.'
            : 'Nobody has submitted feedback about this person yet.'),
          el('p', { class: 'field__hint' },
            'This threshold applies to their total across every form, not to each form '
            + 'separately — two responses on two different forms is still two identifiable '
            + 'cadets.'))));
    }

    const counts = histogram(group.ratings, scaleValues());
    const busiest = Math.max(...counts.map((c) => c.count), 1);

    remount(detail, el('section', { class: 'card stack' }, header,

      el('div', { class: 'grid grid--3' },
        el('div', { class: 'stat' },
          el('div', { class: 'stat__label' }, 'Average'),
          el('div', { class: 'stat__value' }, nearestAnchor(summary.mean) || '—'),
          el('div', { class: 'stat__note' }, `${summary.mean.toFixed(2)} across ${
            pluralize(group.ratings.length, 'rating')}`)),
        el('div', { class: 'stat' },
          el('div', { class: 'stat__label' }, 'Responses'),
          el('div', { class: 'stat__value' }, String(count)),
          el('div', { class: 'stat__note' }, `${pluralize(group.texts, 'written answer')}`)),
        el('div', { class: 'stat' },
          el('div', { class: 'stat__label' }, 'Spread'),
          // Only shown once there is enough data for dispersion to mean
          // anything; describe() says when that is.
          el('div', { class: 'stat__value' },
            summary.reliable && summary.stdev != null ? summary.stdev.toFixed(2) : '—'),
          el('div', { class: 'stat__note' },
            summary.reliable ? 'Lower means more agreement' : 'Too few to judge'))),

      el('div', { class: 'stack-sm' },
        el('div', { class: 'eyebrow' }, 'How the ratings fell'),
        ...counts.map((bucket) => el('div', { class: 'bar-row' },
          el('span', { class: 'bar-row__label' }, nearestAnchor(bucket.value) || bucket.value),
          el('span', { class: 'bar-row__track' },
            el('span', {
              class: 'bar-row__fill',
              style: { width: `${(bucket.count / busiest) * 100}%` },
            })),
          el('span', { class: 'bar-row__val' }, `${bucket.count} · ${Math.round(bucket.share * 100)}%`)))),

      el('div', { class: 'stack-sm' },
        el('div', { class: 'eyebrow' }, 'Their feedback requests'),
        ...group.requests.map(({ request, responses: rows }) => {
          const perForm = rows.length >= PRIVACY.minResponsesToShow;
          return el('button', {
            type: 'button', class: 'list__item',
            onclick: () => navigate(`/instructor?tab=analysis&request=${request.id}`),
          },
            el('span', { class: 'list__main' },
              el('span', { class: 'list__title', style: { display: 'block' } },
                request.title || request.feedbackId,
                isRestricted(request.space)
                  ? [' ', badge(spaceShort(request.space), 'warn', 'lock')] : null),
              el('span', { class: 'list__meta', style: { display: 'block' } },
                [request.asClass, request.semester, request.schoolYear].filter(Boolean).join(' · '),
                request.createdAt ? ` · ${fmtDate(request.createdAt)}` : '')),
            el('span', { class: 'list__aside' },
              perForm
                ? badge(pluralize(rows.length, 'response'), 'neutral')
                : badge(rows.length ? 'Withheld' : 'No responses', 'warn')));
        })),

      el('p', { class: 'field__hint' },
        'An individual form stays withheld below the threshold even when this person\'s '
        + 'total clears it — a small cohort on one form is identifiable regardless of how '
        + 'much feedback they have elsewhere.')));
  }

  function draw() {
    drawList();
    drawDetail();
  }

  const years = [...new Set(requests.map((r) => r.schoolYear).filter(Boolean))].sort();
  const terms = [...new Set(requests.map((r) => r.semester).filter(Boolean))];

  remount(host,
    el('div', { class: 'page-head' },
      el('h2', { class: 'section-title', style: { margin: '0' } }, 'By instructor'),
      el('p', { class: 'page-sub' },
        'Feedback grouped by the person it reflects on. Nothing here is a ranking — '
        + 'response counts and cohorts differ, and an average of nine ordinal points is not '
        + 'a performance score.'),
      // Whose results these are, said plainly. An instructor seeing one row
      // should know it is their row and not the detachment's whole picture.
      people.tier && people.tier !== 'all'
        ? badge(people.tier === 'own' ? 'Your own results'
          : 'The instructors you oversee', 'neutral', 'users')
        : null),

    el('div', { class: 'filters' },
      field('School year', select(
        [{ value: '', label: 'All years' }, ...years.map((y) => ({ value: y, label: y }))],
        { onchange: (e) => { state.schoolYear = e.target.value; draw(); } })),
      field('Semester', select(
        [{ value: '', label: 'All semesters' }, ...terms.map((t) => ({ value: t, label: t }))],
        { onchange: (e) => { state.semester = e.target.value; draw(); } }))),

    list,
    detail);

  draw();
  return undefined;
}
