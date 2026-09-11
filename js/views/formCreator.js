/**
 * Form creator — builds one standardized feedback form and issues it.
 *
 * The specification is deliberately narrow, which is what makes the results
 * comparable across a detachment:
 *   - Class / Event name and AS level identify what the feedback is about.
 *   - Students are targeted explicitly: everyone, or a chosen subset (min 1).
 *   - Questions are either a 250-word text block or a word rating scale.
 *   - Minimum three questions, no maximum.
 *
 * Saving produces two linked records: a form (the questions) and a request
 * (who it goes to, when, and its feedback id). Keeping them separate means
 * reports can aggregate across every issue of the same form later.
 */

import {
  el, icon, field, select, notice, toast, spinner, confirmDialog, badge,
  makeId, nowIso, fromDateInput, toDateInput, pluralize, emptyState, fmtDateTime,
  mount, remount } from '../util.js';
import {
  AS_CLASSES, SEMESTERS, FORM_RULES, SCALE_ANCHORS, PRIVACY, makeFeedbackId, scaleValues,
  currentSchoolYear, currentSemester, schoolYears, SPACES, ROLES } from '../config.js';
import {
  saveForm, saveRequest, deleteRequest, loadForms, loadRequests, getRequest, getForm,
  writeAudit, loadRoster,
} from '../data-source.js';
import { spaceChoicesFor, spaceHint } from '../spaces.js';
import { panelFor } from '../panels.js';
import { listStudents, currentUser } from '../auth.js';
import { requirePanel } from './instructor.js';
import { record, AUDIT } from '../audit.js';
import { navigate } from '../router.js';
import { renderForm } from '../forms.js';
import { modal } from '../util.js';

/** Working copy, so a half-built form survives a preview without saving. */
let draft = null;

/** Templates and previously issued forms, offered under "Start from". */
let reusable = [];

async function loadReusable() {
  const forms = await loadForms();
  return forms.sort((a, b) => {
    // Templates first, then the most recently touched forms.
    if (Boolean(a.isTemplate) !== Boolean(b.isTemplate)) return a.isTemplate ? -1 : 1;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
}

function resetFormDraft() {
  draft = null;
}

export async function renderFormCreator(root, { params = {}, query = null } = {}) {
  // Which panel the creator was opened from. It decides the back link and the
  // area a new form defaults into, so creating feedback from the Cadre Panel
  // files it as cadre material without anyone having to remember to set it.
  const panel = panelFor(query?.get('panel'));

  // Deep-linkable route, so it carries its own gate — reaching it directly
  // must not skip the sign-in the panel shell enforces. The gate is the panel's
  // own: opening a cadre form by URL asks for cadre, not merely instructor.
  return requirePanel(root, panel, () => drawCreator(root, params, panel));
}

async function drawCreator(root, params, panel) {
  remount(root, spinner('Loading…'));

  const editingId = params.id && params.id !== 'new' ? params.id : null;
  let students = [];
  let staff = [];
  let existingRequest = null;

  try {
    students = await listStudents();
    staff = await loadStaff();
    reusable = await loadReusable();
    if (editingId) {
      existingRequest = await getRequest(editingId);
      if (!existingRequest) throw new Error('That feedback request no longer exists.');
    }
  } catch (err) {
    remount(root, notice('danger', 'Could not open the form creator', el('p', {}, err.message)));
    return;
  }

  if (!draft || draft.requestId !== editingId) {
    draft = await buildDraft(editingId, existingRequest);
  }

  draw();

  /* ---------------- draft ---------------- */

  async function buildDraft(requestId, request) {
    if (request) {
      const form = await getForm(request.formId);
      return {
        requestId,
        formId: request.formId,
        // The revisions this editing session started from. A save states them,
        // so a change made by someone else in the meantime is caught instead of
        // being quietly overwritten.
        requestRev: Number(request.rev) || 0,
        formRev: Number(form?.rev) || 0,
        feedbackId: request.feedbackId || '',
        eventName: request.eventName || request.title || '',
        asClass: request.asClass || '',
        space: request.space || SPACES.shared,
        subject: request.subject || request.createdBy || '',
        schoolYear: request.schoolYear || currentSchoolYear(),
        semester: request.semester || currentSemester(),
        dueAt: request.dueAt || null,
        opensAt: request.opensAt || null,
        instructions: request.instructions || '',
        anonymous: request.anonymous !== false,
        audience: request.assignedUsernames?.length ? 'some' : 'all',
        assignedUsernames: request.assignedUsernames || [],
        questions: flattenQuestions(form),
      };
    }
    const requests = await loadRequests();
    return {
      requestId: null,
      formId: null,
      requestRev: undefined,   // new record: nothing to conflict with
      formRev: undefined,
      feedbackId: makeFeedbackId(requests.map((r) => r.feedbackId)),
      eventName: '',
      asClass: '',
      space: panel.defaultSpace,
      subject: '',
      schoolYear: currentSchoolYear(),
      semester: currentSemester(),
      dueAt: null,
      opensAt: null,
      instructions: '',
      anonymous: true,
      audience: 'all',
      assignedUsernames: [],
      questions: [newQuestion('scale'), newQuestion('scale'), newQuestion('text')],
    };
  }

  /* ---------------- render ---------------- */

  function draw() {
    remount(root);

    mount(root, 
      el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm',
        onclick: () => navigate(`${panel.path}?tab=requests`),
      }, icon('arrowLeft'), panel.title),

      el('div', { class: 'page-head row row--between row--wrap' },
        el('div', {},
          el('h1', { class: 'page-title' }, editingId ? 'Edit feedback form' : 'Create feedback'),
          el('p', { class: 'page-sub' }, 'Feedback ID ', el('code', { class: 'mono' }, draft.feedbackId))),
        badge(`${draft.questions.length} / min ${FORM_RULES.minQuestions}`,
          draft.questions.length >= FORM_RULES.minQuestions ? 'ok' : 'warn',
          draft.questions.length >= FORM_RULES.minQuestions ? 'checkCircle' : 'alert')),

      editingId ? null : startFromCard(),
      aboutCard(),
      audienceCard(),
      questionsCard(),
      actionsRow(),
    );
  }

  /**
   * Reuse, which is what makes the standardized form actually standard.
   *
   * Retyping the questions each term guarantees they drift — one instructor
   * writes "The brief was clear", the next writes "Briefings were clear", and
   * the term-over-term comparison silently stops meaning anything. Starting
   * from a saved template or a previous form keeps the wording identical.
   */
  function startFromCard() {
    const templates = reusable.filter((f) => f.isTemplate);
    const recentForms = reusable.filter((f) => !f.isTemplate).slice(0, 12);
    if (!templates.length && !recentForms.length) return null;

    const options = [{ value: '', label: 'Start from blank questions' }];
    for (const t of templates) options.push({ value: t.id, label: `Template — ${t.name}` });
    for (const f of recentForms) options.push({ value: f.id, label: `Previous — ${f.name}` });

    const picker = select(options, {
      onchange: async (e) => {
        if (!e.target.value) return;
        const source = reusable.find((f) => f.id === e.target.value);
        if (!source) return;
        if (draft.questions.some((q) => q.label.trim())
            && !(await confirmDialog('Replace the questions you have written?',
              `The questions below will be replaced with the ${source.isTemplate ? 'template' : 'form'} "${source.name}".`,
              { confirmLabel: 'Replace' }))) {
          e.target.value = '';
          return;
        }
        // Fresh ids: copying a question, not linking to the original.
        draft.questions = flattenQuestions(source).map((q) => ({ ...q, id: makeId('q') }));
        if (!draft.eventName.trim() && !source.isTemplate) draft.eventName = source.name;
        toast(`Loaded ${pluralize(draft.questions.length, 'question')} from "${source.name}".`, 'ok');
        draw();
      },
    });

    return el('section', { class: 'card stack' },
      el('h2', { class: 'section-title' }, 'Start from'),
      field('Reuse an existing set of questions', picker, {
        hint: 'Asking the same questions every term is what makes the results comparable. '
          + 'The copy is independent — editing it will not touch the original.',
      }));
  }

  function aboutCard() {
    const years = schoolYears();
    if (draft.schoolYear && !years.includes(draft.schoolYear)) years.unshift(draft.schoolYear);

    return el('section', { class: 'card stack' },
      el('h2', { class: 'section-title' }, 'What the feedback is about'),
      field('Class / event name',
        el('input', {
          class: 'input', type: 'text', value: draft.eventName,
          placeholder: 'e.g. AS200 Leadership Lab — Drill Block 3',
          oninput: (e) => { draft.eventName = e.target.value; },
        }),
        { required: true, hint: 'What cadets will see at the top of their list.' }),

      spacePicker(draft),
      subjectPicker(draft, staff),

      el('div', { class: 'filters' },
        field('AS level',
          select([{ value: '', label: 'All levels' }, ...AS_CLASSES.map((c) => ({ value: c.code, label: c.label }))],
            { value: draft.asClass, onchange: (e) => { draft.asClass = e.target.value; } }),
          { hint: 'Also filters who sees it.' }),
        field('School year',
          select(years.map((y) => ({ value: y, label: y })),
            { value: draft.schoolYear, onchange: (e) => { draft.schoolYear = e.target.value; } })),
        field('Semester',
          select(SEMESTERS.map((s) => ({ value: s, label: s })),
            { value: draft.semester, onchange: (e) => { draft.semester = e.target.value; } }))),

      el('div', { class: 'filters' },
        field('Opens', el('input', {
          class: 'input', type: 'date', value: toDateInput(draft.opensAt),
          onchange: (e) => { draft.opensAt = fromDateInput(e.target.value); },
        }), { hint: 'Hidden from cadets until this date.' }),
        field('Due', el('input', {
          class: 'input', type: 'date', value: toDateInput(draft.dueAt),
          onchange: (e) => { draft.dueAt = fromDateInput(e.target.value, true); },
        }), { hint: 'Submissions close at the end of this day.' })),

      field('Instructions', el('textarea', {
        class: 'textarea', rows: '2', placeholder: 'Optional. Shown above the questions.',
        oninput: (e) => { draft.instructions = e.target.value; },
        value: draft.instructions,
      })),

      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', checked: draft.anonymous,
          onchange: (e) => { draft.anonymous = e.target.checked; draw(); },
        }),
        el('span', {},
          el('span', { class: 'check__text' }, 'Keep responses anonymous'),
          el('span', { class: 'check__desc', style: { display: 'block' } },
            'Cadets are signed in, so the app can check them off and stop a second submission — '
            + 'but their name is written to a separate receipt file, never beside their answers.'))));
  }

  function audienceCard() {
    const card = el('section', { class: 'card stack' },
      el('h2', { class: 'section-title' }, 'Who receives it'));

    const picker = el('div', {});

    const choice = (value, title, desc) => {
      const input = el('input', {
        type: 'radio', name: 'audience', value, checked: draft.audience === value,
        onchange: () => { draft.audience = value; drawPicker(); },
      });
      return el('label', { class: 'choice' }, input,
        el('span', { class: 'choice__mark', 'aria-hidden': 'true' }),
        el('div', {}, el('div', { class: 'choice__title' }, title),
          el('div', { class: 'choice__desc' }, desc)));
    };

    // Kept out of `picker` so ticking a student can refresh the warning without
    // rebuilding the list and losing the search box's state.
    const warningHost = el('div', {});

    function drawPicker() {
      remount(picker);
      if (draft.audience === 'all') {
        mount(picker, notice('info', null,
          el('p', {}, draft.asClass
            ? `Everyone on the roster at ${draft.asClass} — ${pluralize(eligible().length, 'student')}.`
            : `Everyone on the roster — ${pluralize(eligible().length, 'student')}.`)));
      } else {
        mount(picker, studentPicker());
      }
      refreshWarning();
    }

    /**
     * An anonymous form sent to fewer people than the disclosure threshold can
     * never show its results — better to say so now than after collecting them.
     */
    function refreshWarning() {
      remount(warningHost);
      if (!draft.anonymous) return;
      const size = draft.audience === 'some' ? draft.assignedUsernames.length : eligible().length;
      if (!size || size >= PRIVACY.minResponsesToShow) return;
      mount(warningHost, notice('warn', 'This form will never show results',
        el('p', {}, `It is anonymous and goes to ${pluralize(size, 'student')}, but anonymous `
          + `results stay hidden until ${PRIVACY.minResponsesToShow} people have responded — `
          + 'otherwise a single answer can be traced back by elimination. Add more cadets, or '
          + 'turn off anonymity so the feedback is attributed and visible.')));
    }

    mount(card,
      el('div', { class: 'choice-list' },
        choice('all', 'Everyone at this AS level', 'Any cadet matching the AS level above.'),
        choice('some', 'Selected cadets', 'Choose individually. At least one is required.')),
      picker,
      warningHost);

    drawPicker();
    return card;
  }

  function eligible() {
    return students.filter((s) => !draft.asClass || !s.asClass || s.asClass === draft.asClass);
  }

  function studentPicker() {
    const wrap = el('div', { class: 'stack-sm' });
    const list = el('div', { class: 'picker' });
    const countLabel = el('span', { class: 'muted' });

    const search = el('input', {
      class: 'input', type: 'search', placeholder: 'Filter by name or username…',
      oninput: () => paint(),
    });

    function paint() {
      const term = search.value.trim().toLowerCase();
      const rows = eligible().filter((s) =>
        !term || s.name.toLowerCase().includes(term) || s.username.includes(term));
      remount(list, );

      if (!rows.length) {
        mount(list, el('p', { class: 'muted', style: { padding: 'var(--sp-3)' } },
          students.length ? 'No cadets match.' : 'No cadet accounts yet — create them in Database Administration.'));
      }

      for (const student of rows) {
        const checked = draft.assignedUsernames.includes(student.username);
        mount(list, el('label', { class: 'picker__row' },
          el('input', {
            type: 'checkbox', checked,
            onchange: (e) => {
              draft.assignedUsernames = e.target.checked
                ? [...new Set([...draft.assignedUsernames, student.username])]
                : draft.assignedUsernames.filter((u) => u !== student.username);
              countLabel.textContent = `${draft.assignedUsernames.length} selected`;
              refreshWarning();
            },
          }),
          el('span', {},
            el('span', { style: { fontWeight: '550' } }, student.name),
            el('span', { class: 'mono faint', style: { marginLeft: '.5rem' } }, student.username)),
          el('span', { class: 'spacer' }),
          student.asClass && el('span', { class: 'chip' }, student.asClass)));
      }
      countLabel.textContent = `${draft.assignedUsernames.length} selected`;
    }

    mount(wrap, 
      el('div', { class: 'row row--wrap' },
        search,
        el('button', {
          type: 'button', class: 'btn btn--sm',
          onclick: () => { draft.assignedUsernames = eligible().map((s) => s.username); paint(); },
        }, 'Select all'),
        el('button', {
          type: 'button', class: 'btn btn--sm',
          onclick: () => { draft.assignedUsernames = []; paint(); },
        }, 'Clear')),
      countLabel,
      list);
    paint();
    return wrap;
  }

  function questionsCard() {
    const card = el('section', { class: 'card stack' },
      el('div', { class: 'row row--between row--wrap' },
        el('h2', { class: 'section-title', style: { margin: '0' } }, 'Questions'),
        el('div', { class: 'row row--wrap' },
          el('button', {
            type: 'button', class: 'btn btn--sm',
            onclick: () => { draft.questions.push(newQuestion('scale')); draw(); },
          }, icon('plus'), 'Rating question'),
          el('button', {
            type: 'button', class: 'btn btn--sm',
            onclick: () => { draft.questions.push(newQuestion('text')); draw(); },
          }, icon('plus'), 'Written answer'))));

    if (!draft.questions.length) {
      mount(card, emptyState({
        iconName: 'clipboard',
        title: 'No questions yet',
        message: `Add at least ${FORM_RULES.minQuestions}.`,
      }));
      return card;
    }

    draft.questions.forEach((question, i) => mount(card, questionRow(question, i)));

    if (draft.questions.length < FORM_RULES.minQuestions) {
      mount(card, notice('warn', 'Below the minimum',
        el('p', {}, `A feedback form needs at least ${FORM_RULES.minQuestions} questions. `
          + `Add ${FORM_RULES.minQuestions - draft.questions.length} more.`)));
    }
    return card;
  }

  function questionRow(question, index) {
    const move = (delta) => {
      const target = index + delta;
      if (target < 0 || target >= draft.questions.length) return;
      const copy = [...draft.questions];
      [copy[index], copy[target]] = [copy[target], copy[index]];
      draft.questions = copy;
      draw();
    };

    const typeLabel = question.type === 'scale'
      ? `Rating · ${scaleValues(SCALE_ANCHORS).length} points`
      : `Text · ${FORM_RULES.textWordLimit} words`;

    return el('div', { class: 'qrow' },
      el('div', { class: 'row row--between row--wrap' },
        el('div', { class: 'row' },
          el('span', { class: 'qrow__num mono' }, String(index + 1)),
          badge(typeLabel, question.type === 'scale' ? 'info' : 'neutral',
            question.type === 'scale' ? 'chart' : 'edit')),
        el('div', { class: 'row' },
          el('button', {
            type: 'button', class: 'btn btn--sm btn--ghost', title: 'Move up',
            disabled: index === 0, onclick: () => move(-1),
          }, '↑'),
          el('button', {
            type: 'button', class: 'btn btn--sm btn--ghost', title: 'Move down',
            disabled: index === draft.questions.length - 1, onclick: () => move(1),
          }, '↓'),
          el('button', {
            type: 'button', class: 'btn btn--sm btn--ghost', title: 'Remove',
            onclick: () => { draft.questions.splice(index, 1); draw(); },
          }, icon('trash')))),

      field('Question', el('input', {
        class: 'input', type: 'text', value: question.label,
        placeholder: question.type === 'scale'
          ? 'e.g. The instruction was clear and well paced'
          : 'e.g. What should change about this event next time?',
        oninput: (e) => { question.label = e.target.value; },
      }), { required: true }),

      question.type === 'scale' ? scalePreview() : null,

      el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', checked: question.required !== false,
          onchange: (e) => { question.required = e.target.checked; },
        }),
        el('span', { class: 'check__text' }, 'Required')));
  }

  /** Shows the exact words a cadet will see, in order. */
  function scalePreview() {
    const row = el('div', { class: 'scale-preview' });
    for (const n of scaleValues(SCALE_ANCHORS)) {
      mount(row, el('span', { class: 'scale-preview__opt' },
        el('span', {}, SCALE_ANCHORS[n]),
        el('span', { class: 'mono faint' }, String(n))));
    }
    return el('div', {},
      el('div', { class: 'field__label' }, 'What cadets will see'),
      row,
      el('div', { class: 'field__hint' },
        'Cadets choose a word. The number is stored for analysis and is never shown to them.'));
  }

  function actionsRow() {
    return el('div', { class: 'row row--wrap row--end', style: { marginTop: 'var(--sp-5)' } },
      editingId && el('button', {
        type: 'button', class: 'btn btn--danger',
        onclick: async () => {
          if (!(await confirmDialog('Delete this feedback request?',
            'Its responses are deleted with it. This cannot be undone.',
            { confirmLabel: 'Delete', danger: true }))) return;
          await deleteRequest(editingId);
          await writeAudit({
            action: AUDIT.requestDeleted,
            summary: `Deleted "${draft.eventName || editingId}" and its responses`,
            target: draft.feedbackId || editingId,
          });
          resetFormDraft();
          toast('Deleted.', 'ok');
          navigate(`${panel.path}?tab=requests`);
        },
      }, icon('trash'), 'Delete'),
      el('span', { class: 'spacer' }),
      el('button', { type: 'button', class: 'btn', onclick: saveAsTemplate },
        icon('clipboard'), 'Save as template'),
      el('button', { type: 'button', class: 'btn', onclick: preview }, icon('eye'), 'Preview'),
      el('button', { type: 'button', class: 'btn', onclick: () => save('draft') }, 'Save draft'),
      el('button', { type: 'button', class: 'btn btn--primary', onclick: () => save('open') },
        icon('send'), 'Issue to cadets'));
  }

  /** Stores just the questions, for reuse next term. */
  async function saveAsTemplate() {
    if (draft.questions.length < FORM_RULES.minQuestions) {
      return toast(`A template needs at least ${FORM_RULES.minQuestions} questions.`, 'warn', 5000);
    }
    const blank = draft.questions.findIndex((q) => !q.label.trim());
    if (blank >= 0) return toast(`Question ${blank + 1} has no text.`, 'warn', 5000);

    const nameInput = el('input', {
      class: 'input', type: 'text', value: draft.eventName.trim(),
      placeholder: 'e.g. Standard AS200 block feedback',
    });
    const go = await modal({
      title: 'Save as a reusable template',
      body: el('div', {},
        field('Template name', nameInput, {
          required: true,
          hint: 'Name it for the kind of event, not this one — it will be offered every time '
            + 'someone creates feedback.',
        })),
      actions: [{ label: 'Cancel', value: null }, { label: 'Save template', value: 'go', variant: 'primary' }],
    });
    if (go !== 'go' || !nameInput.value.trim()) return undefined;

    try {
      const record = toFormRecord();
      await saveForm({
        ...record,
        id: makeId('form'),
        name: nameInput.value.trim(),
        isTemplate: true,
        space: draft.space || SPACES.shared,
      });
      reusable = await loadReusable();
      toast('Template saved. It will appear under "Start from".', 'ok', 5000);
      return draw();
    } catch (err) {
      return toast(`Could not save the template: ${err.message}`, 'danger', 8000);
    }
  }

  function preview() {
    const problem = validate();
    if (problem) return toast(problem, 'warn', 5000);
    return modal({
      title: draft.eventName || 'Preview',
      body: el('div', {}, renderForm(toFormRecord(), { namespace: 'preview' })),
      actions: [{ label: 'Close', value: true, autofocus: true }],
    });
  }

  function validate() {
    if (!draft.eventName.trim()) return 'Give the form a class or event name.';
    if (draft.questions.length < FORM_RULES.minQuestions) {
      return `A feedback form needs at least ${FORM_RULES.minQuestions} questions.`;
    }
    const blank = draft.questions.findIndex((q) => !q.label.trim());
    if (blank >= 0) return `Question ${blank + 1} has no text.`;
    if (draft.audience === 'some' && !draft.assignedUsernames.length) {
      return 'Select at least one cadet, or switch to everyone.';
    }
    return null;
  }

  function toFormRecord() {
    return {
      id: draft.formId || makeId('form'),
      name: draft.eventName.trim() || 'Untitled feedback',
      description: draft.instructions.trim(),
      feedbackId: draft.feedbackId,
      standardized: true,
      // The questions live in the same area as the request that asks them.
      // They have to: the wording of a restricted question is the sensitive
      // part, more so than the answers it collects.
      space: draft.space || SPACES.shared,
      sections: [{
        title: draft.eventName.trim() || 'Feedback',
        items: draft.questions.map((q) => (q.type === 'scale'
          ? {
            id: q.id, type: 'scale', label: q.label.trim(), required: q.required !== false,
            min: FORM_RULES.scaleMin, max: FORM_RULES.scaleMax,
            // Copied in, not referenced: if the detachment later changes the
            // wording, forms already issued keep the words cadets answered on.
            anchors: { ...SCALE_ANCHORS },
          }
          : {
            id: q.id, type: 'text', label: q.label.trim(), required: q.required !== false,
            rows: 4, wordLimit: FORM_RULES.textWordLimit,
          })),
      }],
    };
  }

  async function save(status) {
    const problem = validate();
    if (problem) return toast(problem, 'warn', 5000);

    try {
      const form = await saveForm(toFormRecord(), { expectRev: draft.formRev });
      draft.formRev = form.rev;
      const request = await saveRequest({
        id: draft.requestId || makeId('req'),
        feedbackId: draft.feedbackId,
        title: draft.eventName.trim(),
        eventName: draft.eventName.trim(),
        formId: form.id,
        asClass: draft.asClass,
        schoolYear: draft.schoolYear,
        semester: draft.semester,
        opensAt: draft.opensAt,
        dueAt: draft.dueAt,
        instructions: draft.instructions.trim(),
        anonymous: draft.anonymous,
        space: draft.space || SPACES.shared,
        subject: draft.subject || currentUser()?.username || null,
        assignedUsernames: draft.audience === 'some' ? draft.assignedUsernames : [],
        audience: draft.audience,
        status,
        createdAt: nowIso(),
      }, { expectRev: draft.requestRev });
      resetFormDraft();
      toast(status === 'open'
        ? `${request.feedbackId} issued to cadets.`
        : `${request.feedbackId} saved as a draft.`, 'ok');
      return navigate(`${panel.path}?tab=requests`);
    } catch (err) {
      if (err.conflict) return resolveConflict(err, status);
      return toast(`Could not save: ${err.message}`, 'danger', 8000);
    }
  }

  /**
   * Another instructor saved this form while it was open here. Rather than
   * picking a winner silently, show what changed and let this person decide —
   * losing ten minutes of question-writing to a background overwrite is the
   * failure worth avoiding.
   */
  async function resolveConflict(err, status) {
    const theirs = err.theirs || {};
    const choice = await modal({
      title: 'Someone else changed this feedback',
      body: el('div', { class: 'stack' },
        notice('warn', 'Your changes have not been saved yet',
          el('p', {}, 'Another instructor saved this form while you were editing it. '
            + 'Choose which version to keep.')),
        el('div', { class: 'card stack-sm' },
          el('div', { class: 'eyebrow' }, 'Their version'),
          el('div', { style: { fontWeight: '570' } }, theirs.title || theirs.name || '—'),
          theirs.updatedAt && el('div', { class: 'muted' }, `Saved ${fmtDateTime(theirs.updatedAt)}`)),
        el('div', { class: 'card stack-sm' },
          el('div', { class: 'eyebrow' }, 'Your version'),
          el('div', { style: { fontWeight: '570' } }, draft.eventName || '—'),
          el('div', { class: 'muted' }, `${pluralize(draft.questions.length, 'question')}`))),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Discard mine, load theirs', value: 'theirs' },
        { label: 'Keep mine, overwrite theirs', value: 'mine', variant: 'danger' },
      ],
    });

    if (choice === 'theirs') {
      resetFormDraft();
      toast('Loaded the other version.', 'ok');
      return navigate(`/instructor/create/${editingId}`);
    }
    if (choice === 'mine') {
      // Deliberate overwrite: re-read the current revisions and save over them.
      const [freshReq, freshForm] = await Promise.all([
        getRequest(draft.requestId), getForm(draft.formId),
      ]);
      draft.requestRev = Number(freshReq?.rev) || 0;
      draft.formRev = Number(freshForm?.rev) || 0;
      return save(status);
    }
    return undefined;
  }
}

/**
 * Everyone this feedback could be *about*.
 *
 * Cadre and commanders as well as instructors, because they run events too. A
 * departed member is still listed while they hold a roster entry, so editing an
 * old request does not silently reassign it to whoever is editing.
 */
async function loadStaff() {
  const roster = await loadRoster();
  return roster
    .filter((a) => (a.roles || []).some((r) => r !== ROLES.student))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Who the feedback reflects on.
 *
 * Pre-filled with the person issuing it, because in practice cadre issue
 * feedback for the labs they run. It is changeable because that is not always
 * true — an administrator issuing forms on somebody else's behalf would
 * otherwise file the results against themselves, and a commander reviewing by
 * person would read the wrong picture.
 */
function subjectPicker(draft, staff) {
  const me = currentUser();
  if (!staff.length) return null;

  const options = staff.map((person) => ({
    value: person.username,
    label: person.username === me?.username ? `${person.name} (you)` : person.name,
  }));
  if (!draft.subject) draft.subject = me?.username || options[0].value;

  return field('Who is this feedback about?',
    select(options, {
      value: draft.subject,
      onchange: (e) => { draft.subject = e.target.value; },
    }),
    {
      hint: 'Results are grouped by this person when a commander reviews feedback. '
        + 'Change it if somebody else ran the event.',
    });
}

/**
 * Where this feedback will live.
 *
 * Only rendered when the person has somewhere else to put it — an instructor
 * has exactly one option and does not need to be asked. The choice is checked
 * again by the server, so a page edited to add an option the account does not
 * hold gets a refusal rather than a misfiled request.
 */
function spacePicker(draft) {
  const choices = spaceChoicesFor(currentUser()?.roles || []);
  if (choices.length < 2) return null;

  const hint = el('span', {}, spaceHint(draft.space));
  return field('Who can see the responses',
    select(choices.map((c) => ({ value: c.value, label: c.label })), {
      value: draft.space,
      onchange: (e) => {
        draft.space = e.target.value;
        hint.textContent = spaceHint(draft.space);
      },
    }),
    { hint });
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function newQuestion(type) {
  return {
    id: makeId('q'),
    type,
    label: '',
    required: true,

  };
}

/** Turns a saved form back into the flat question list the creator edits. */
function flattenQuestions(form) {
  const items = (form?.sections || []).flatMap((s) => s.items || []);
  if (!items.length) return [newQuestion('scale'), newQuestion('scale'), newQuestion('text')];
  return items.map((item) => ({
    id: item.id,
    type: item.type === 'scale' ? 'scale' : 'text',
    label: item.label || '',
    required: item.required !== false,
  }));
}
