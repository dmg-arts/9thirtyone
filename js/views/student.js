/**
 * Student side.
 *
 * Cadets sign in with the Google account their detachment already mails them
 * at. That sign-in is what makes a submission receipt mean something: without
 * it, "one submission per cadet" is only as good as the honesty of whoever
 * typed the name, and anyone could burn a classmate's single submission.
 *
 * On anonymity: signing in identifies the cadet well enough to write a
 * submission *receipt* and to stop a second attempt. The identity is then
 * dropped — an anonymous response record carries no name and no email, so
 * nothing links an answer to a person. Receipts live in a different folder from
 * responses, and are filed under the roster username rather than the email.
 */

import {
  el, icon, badge, field, select, notice, toast, spinner, emptyState,
  fmtDate, fmtRelative, pluralize, confirmDialog, nowIso, makeId,
  mount, remount } from '../util.js';
import {
  APP, SEMESTERS, AS_CLASSES, FORM_RULES, ROLES, countWords,
  schoolYears, currentSchoolYear, currentSemester,
} from '../config.js';
import { studentPrefs, settings, connection } from '../state.js';
import { db } from '../storage/index.js';
import { signOut, currentUser, currentIdToken } from '../auth.js';
import { submitViaProxy } from '../storage/proxy.js';
import {
  loadAssignments, loadForFilling, loadOwnAccount, invalidateStudentData, usingProxy,
} from '../data-source.js';
import { renderLogin } from './sign-in.js';
import { navigate } from '../router.js';
import { renderForm, collectAnswers, showMissing, cssEscape } from '../forms.js';

/* ------------------------------------------------------------------ *
 * Sign in
 * ------------------------------------------------------------------ */

/** Wraps a student view in the sign-in gate. */
function requireStudent(root, render) {
  const session = currentUser();
  if (session?.roles?.includes(ROLES.student)) return render(session);
  return renderLogin(root, ROLES.student, 'Cadet sign-in', render);
}

/* ------------------------------------------------------------------ *
 * List of available feedback
 * ------------------------------------------------------------------ */

export async function renderStudentList(root) {
  return requireStudent(root, (session) => drawList(root, session));
}

async function drawList(root, session) {
  const appSettings = settings.get();
  const prefs = studentPrefs.get();

  const state = {
    from: '',
    to: '',
    asClass: prefs.asClass || '',
    schoolYear: prefs.schoolYear || appSettings.defaultSchoolYear || currentSchoolYear(),
    semester: prefs.semester || appSettings.defaultSemester || currentSemester(),
    showClosed: appSettings.studentShowClosed,
  };

  const results = el('div', { class: 'stack' }, spinner('Loading feedback…'));

  remount(root,
    el('div', { class: 'page-head row row--between row--wrap' },
      el('div', {},
        el('h1', { class: 'page-title' }, 'Your feedback'),
        el('p', { class: 'page-sub' },
          `${session.name} · `, el('span', { class: 'mono' }, session.email || session.username))),
      el('button', {
        type: 'button', class: 'btn btn--sm',
        onclick: () => { signOut(); toast('Signed out.', 'ok'); navigate('/home'); },
      }, icon('lock'), 'Sign out')),
    filterCard(),
    results);

  let requests = [];
  const submitted = new Set();

  try {
    const data = await loadAssignments(session);
    requests = data.requests;
    for (const id of data.submitted) submitted.add(id);
  } catch (err) {
    remount(results, notice('danger', 'Could not load feedback', el('p', {}, err.message)));
    return;
  }

  draw();

  function filterCard() {
    const years = schoolYears();
    if (state.schoolYear && !years.includes(state.schoolYear)) years.unshift(state.schoolYear);

    return el('section', { class: 'card', style: { padding: 'var(--sp-4)' } },
      el('div', { class: 'filters' },
        field('School year', select(
          [{ value: '', label: 'All years' }, ...years.map((y) => ({ value: y, label: y }))],
          { value: state.schoolYear, onchange: (e) => { state.schoolYear = e.target.value; draw(); } })),
        field('Semester', select(
          [{ value: '', label: 'All semesters' }, ...SEMESTERS.map((s) => ({ value: s, label: s }))],
          { value: state.semester, onchange: (e) => { state.semester = e.target.value; draw(); } })),
        field('Class', select(
          [{ value: '', label: 'All classes' }, ...AS_CLASSES.map((c) => ({ value: c.code, label: c.label }))],
          { value: state.asClass, onchange: (e) => { state.asClass = e.target.value; draw(); } })),
        field('Due from', el('input', {
          class: 'input', type: 'date',
          onchange: (e) => { state.from = e.target.value; draw(); },
        })),
        field('Due to', el('input', {
          class: 'input', type: 'date',
          onchange: (e) => { state.to = e.target.value; draw(); },
        }))),
      el('label', { class: 'check', style: { marginTop: 'var(--sp-3)' } },
        el('input', {
          type: 'checkbox', checked: state.showClosed,
          onchange: (e) => { state.showClosed = e.target.checked; draw(); },
        }),
        el('span', { class: 'check__text' }, 'Include closed and already-completed feedback')));
  }

  /**
   * Feedback this cadet is eligible for, ignoring the date and term filters.
   * This is the set worth checking receipts against.
   */
  function candidateRequests() {
    const now = Date.now();
    return requests.filter((request) => {
      if (request.status === 'draft') return false;
      // A scheduled form stays hidden until its open date.
      if (request.opensAt && new Date(request.opensAt).getTime() > now) return false;
      // Targeted forms are only for the named cadets.
      if (request.assignedUsernames?.length) {
        return request.assignedUsernames.includes(session.username);
      }
      // Otherwise the AS level on the form has to match the cadet's own.
      if (request.asClass && session.asClass && request.asClass !== session.asClass) return false;
      return true;
    });
  }

  function visibleRequests() {
    const fromTime = state.from ? new Date(`${state.from}T00:00:00`).getTime() : null;
    const toTime = state.to ? new Date(`${state.to}T23:59:59`).getTime() : null;

    return candidateRequests().filter((request) => {
      if (!state.showClosed && request.status !== 'open') return false;
      if (!state.showClosed && submitted.has(request.id)) return false;
      if (state.schoolYear && request.schoolYear !== state.schoolYear) return false;
      if (state.semester && request.semester !== state.semester) return false;
      if (state.asClass && request.asClass && request.asClass !== state.asClass) return false;

      if (fromTime || toTime) {
        const due = request.dueAt ? new Date(request.dueAt).getTime() : null;
        if (due === null) return false;
        if (fromTime && due < fromTime) return false;
        if (toTime && due > toTime) return false;
      }
      return true;
    }).sort((a, b) => String(a.dueAt || '9999').localeCompare(String(b.dueAt || '9999')));
  }

  function draw() {
    studentPrefs.set({
      schoolYear: state.schoolYear, semester: state.semester, asClass: state.asClass,
    });
    const visible = visibleRequests();
    remount(results);

    if (!visible.length) {
      mount(results, emptyState({
        iconName: 'inbox',
        title: 'Nothing to fill out right now',
        message: requests.length
          ? 'No feedback matches these filters. Try a different term or class, or tick "include closed".'
          : 'Your instructors have not issued any feedback yet.',
      }));
      return;
    }

    mount(results, el('p', { class: 'muted' }, `${pluralize(visible.length, 'form')} available`));
    const list = el('div', { class: 'list' });
    for (const request of visible) mount(list, row(request));
    mount(results, list);
  }

  function row(request) {
    const done = submitted.has(request.id);
    const overdue = request.dueAt && new Date(request.dueAt) < new Date();
    return el('button', {
      type: 'button', class: 'list__item',
      onclick: () => navigate(`/student/fill/${request.id}`),
    },
      el('span', { class: 'list__main' },
        el('span', { class: 'list__title', style: { display: 'block' } },
          request.feedbackId
            ? [el('span', { class: 'mono faint' }, `${request.feedbackId} `), request.title]
            : request.title),
        el('span', { class: 'list__meta', style: { display: 'block' } },
          [request.asClass, request.semester, request.schoolYear].filter(Boolean).join(' · ')),
        el('span', { class: 'list__meta', style: { display: 'block' } },
          request.dueAt ? `Due ${fmtDate(request.dueAt)} (${fmtRelative(request.dueAt)})` : 'No due date')),
      el('span', { class: 'list__aside' },
        done ? badge('Submitted', 'ok', 'checkCircle')
          : request.status !== 'open' ? badge('Closed', 'neutral', 'lock')
            : overdue ? badge('Overdue', 'warn', 'clock')
              : badge('Open', 'ok', 'send'),
        icon('chevronRight', { cls: 'list__chev' })));
  }
}

/* ------------------------------------------------------------------ *
 * Fill one form out
 * ------------------------------------------------------------------ */

export async function renderStudentFill(root, { params }) {
  return requireStudent(root, (session) => drawFill(root, params, session));
}

async function drawFill(root, params, session) {
  const container = el('div', { class: 'stack' }, spinner('Loading form…'));
  remount(root, container);

  let request;
  let form;
  let alreadySubmitted = false;
  try {
    const loaded = await loadForFilling(session, params.id);
    request = loaded.request;
    if (!request) throw new Error('That feedback form no longer exists.');
    form = loaded.form;
    if (!form) throw new Error('The questions for this form are missing.');
    alreadySubmitted = loaded.submitted;
  } catch (err) {
    remount(container,
      notice('danger', 'Could not open this form', el('p', {}, err.message)), backLink());
    return;
  }

  const closedReason = whyClosed(request);
  if (closedReason) {
    remount(container,
      notice('warn', 'This feedback is not accepting responses', el('p', {}, closedReason)), backLink());
    return;
  }

  if (alreadySubmitted) {
    remount(container,
      notice('ok', 'You have already submitted this feedback',
        el('p', {}, 'Only one response per person is kept. Talk to your instructor if you '
          + 'need it reopened.')),
      backLink());
    return;
  }

  const formHost = el('div', {});
  mount(formHost, renderForm(form, { namespace: `req-${request.id}` }));
  wireWordLimits(formHost, form);

  const submitBtn = el('button', { type: 'button', class: 'btn btn--primary btn--lg', onclick: submit },
    icon('send'), 'Submit feedback');

  remount(container,
    backLink(),
    el('div', { class: 'page-head' },
      el('h1', { class: 'page-title' }, request.title),
      el('p', { class: 'page-sub' },
        request.feedbackId ? `${request.feedbackId} · ` : '',
        [request.asClass, request.semester, request.schoolYear].filter(Boolean).join(' · '))),

    request.instructions && el('section', { class: 'card' },
      el('div', { class: 'eyebrow' }, 'Instructions'),
      el('p', { style: { marginTop: 'var(--sp-2)', whiteSpace: 'pre-wrap' } }, request.instructions)),

    request.anonymous
      ? notice('info', 'Your answers are anonymous',
        el('p', {}, `You are signed in as ${session.email || session.username} so the app can check you off and stop a `
          + 'second submission. That record is kept in a separate list from your answers — nothing '
          + 'links what you write to who you are.'))
      : notice('warn', 'Your name is attached to this feedback',
        el('p', {}, `You are signed in as ${session.email || session.username}, and your name is stored with your `
          + 'answers so instructors can follow up.')),

    el('section', { class: 'card' }, formHost),
    el('div', { class: 'row row--end' }, submitBtn));

  async function submit() {
    submitBtn.disabled = true;
    remount(submitBtn, el('span', { class: 'spinner' }), 'Checking…');
    const restore = () => {
      submitBtn.disabled = false;
      remount(submitBtn, icon('send'), 'Submit feedback');
    };

    // Re-check at submission: a session could have been opened before an admin
    // deactivated the account, and the receipt is what enforces one response
    // per cadet.
    let account;
    try {
      account = await loadOwnAccount(session);
    } catch (err) {
      restore();
      toast(`Could not verify your account: ${err.message}`, 'danger', 8000);
      return undefined;
    }
    if (!account || account.active === false) {
      restore();
      toast('Your account is no longer active. Ask your cadre.', 'danger', 8000);
      return undefined;
    }
    // Re-read rather than trusting what the page loaded with: a cadet can sit
    // on an open form for an hour. In proxy mode the server holds the only
    // authoritative answer, under a lock, and will refuse a duplicate itself.
    if (!usingProxy() && await db.hasSubmitted(request.id, session.username)) {
      restore();
      toast('You have already submitted this feedback.', 'warn', 6000);
      return navigate('/student');
    }

    const { values, missing } = collectAnswers(form, formHost);
    showMissing(formHost, missing);
    const overLimit = findOverLimit(formHost, form);
    if (overLimit) {
      restore();
      toast(`"${overLimit.label}" is over the ${FORM_RULES.textWordLimit}-word limit.`, 'warn', 6000);
      return undefined;
    }
    if (missing.length) {
      restore();
      toast(`${pluralize(missing.length, 'question')} still needs an answer.`, 'warn');
      return undefined;
    }

    const confirmed = await confirmDialog('Submit this feedback?',
      'You cannot edit it afterwards, and you can only submit once.', { confirmLabel: 'Submit' });
    if (!confirmed) { restore(); return undefined; }

    // Where this goes depends on whether the detachment has deployed the
    // submission proxy. Through the proxy, the cadet needs no Drive access at
    // all; without it, they are writing into the folder themselves and can read
    // everything in it. Same submission either way, very different exposure.
    const proxyUrl = connection.get().proxyUrl;

    if (proxyUrl) {
      try {
        await submitViaProxy(proxyUrl, {
          idToken: currentIdToken(),
          requestId: request.id,
          formId: form.id,
          answers: values,
          schemaVersion: APP.schemaVersion,
        });
        // The proxy writes the receipt too, under the same lock that enforces
        // one submission per cadet — so there is nothing to write here.
        invalidateStudentData();
        return renderThanks(root, request, false);
      } catch (err) {
        restore();
        toast(`Could not submit: ${err.message}`, 'danger', 9000);
        return undefined;
      }
    }

    try {
      const saved = await db.saveResponse({
        id: makeId('res'),
        requestId: request.id,
        formId: form.id,
        feedbackId: request.feedbackId || null,
        schoolYear: request.schoolYear,
        semester: request.semester,
        asClass: request.asClass,
        anonymous: Boolean(request.anonymous),
        // On an anonymous form the respondent is deliberately dropped here; the
        // receipt below is the only record that this cadet took part.
        respondent: request.anonymous ? null
          : { username: account.username, name: account.name, asClass: account.asClass || '' },
        answers: values,
        submittedAt: nowIso(),
      });
      await db.addReceipt(request.id, session.username);
      invalidateStudentData();
      return renderThanks(root, request, saved.queued);
    } catch (err) {
      restore();
      toast(`Could not submit: ${err.message}`, 'danger', 8000);
      return undefined;
    }
  }
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function whyClosed(request) {
  if (request.status === 'draft') return 'It has not been issued yet.';
  if (request.status !== 'open') return `Its status is "${request.status}". Ask your instructor to reopen it.`;
  if (request.opensAt && new Date(request.opensAt) > new Date()) {
    return `It opens on ${fmtDate(request.opensAt)}.`;
  }
  if (request.dueAt && new Date(request.dueAt) < new Date()) {
    return `The deadline passed on ${fmtDate(request.dueAt)}. Ask your instructor to reopen it if you still need to submit.`;
  }
  return null;
}

/** Live word counter on every 250-word text block. */
function wireWordLimits(host, form) {
  for (const section of form.sections || []) {
    for (const item of section.items || []) {
      if (item.type !== 'text') continue;
      const scope = host.querySelector(`[data-qid="${cssEscape(item.id)}"]`);
      const textarea = scope?.querySelector('textarea');
      if (!textarea) continue;

      const limit = item.wordLimit || FORM_RULES.textWordLimit;
      const counter = el('div', { class: 'wordcount' });
      const update = () => {
        const used = countWords(textarea.value);
        counter.textContent = `${used} / ${limit} words`;
        counter.dataset.state = used > limit ? 'over' : used > limit * 0.9 ? 'near' : 'ok';
      };
      textarea.addEventListener('input', update);
      update();
      textarea.after(counter);
    }
  }
}

/** First text answer past its limit, or null. */
function findOverLimit(host, form) {
  for (const section of form.sections || []) {
    for (const item of section.items || []) {
      if (item.type !== 'text') continue;
      const scope = host.querySelector(`[data-qid="${cssEscape(item.id)}"]`);
      const textarea = scope?.querySelector('textarea');
      if (!textarea) continue;
      if (countWords(textarea.value) > (item.wordLimit || FORM_RULES.textWordLimit)) return item;
    }
  }
  return null;
}


function renderThanks(root, request, queued) {
  remount(root, el('div', { class: 'stack' },
    el('div', { class: 'empty' },
      icon(queued ? 'clock' : 'checkCircle', { cls: 'empty__icon' }),
      el('div', { class: 'empty__title' }, queued ? 'Saved — waiting for a connection' : 'Feedback submitted'),
      el('p', {}, queued
        ? 'You are offline, so your answers are saved on this device and will be sent automatically '
          + 'as soon as you are back online. You can close the app.'
        : `Thank you — your response to "${request.title}" was saved.`),
      el('div', { class: 'row', style: { justifyContent: 'center', marginTop: 'var(--sp-5)' } },
        el('button', { type: 'button', class: 'btn btn--primary', onclick: () => navigate('/student') },
          'Back to my feedback'),
        el('button', { type: 'button', class: 'btn', onclick: () => navigate('/home') }, 'Home')))));
}

function backLink() {
  return el('button', {
    type: 'button', class: 'btn btn--ghost btn--sm',
    onclick: () => navigate('/student'),
  }, icon('arrowLeft'), 'All my feedback');
}
