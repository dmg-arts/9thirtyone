/**
 * The join-link paste box, shared by every screen that needs to offer it.
 *
 * It used to live only at the top of the setup wizard, where it was the right
 * words in the wrong place: a card above a form reads as a preamble to the
 * form. Det 752's commander scrolled past it on 26 Oct, worked through setup
 * instead, and spent most of a day on a folder his browser could never open.
 *
 * So it moved here, to be mounted anywhere the answer is "you needed a join
 * link, not this screen" — including inside the error a stuck device is already
 * looking at, which is the only place that helps somebody whose device is
 * wrong *now*.
 */

import { el, icon, field, notice, clear, mount } from '../util.js';
import { navigate } from '../router.js';
import { parseJoinParams } from '../join.js';

/**
 * @param {object} [copy]
 * @param {string} [copy.title]  heading, so the same control can introduce
 *                               itself differently in setup and in an error
 * @param {string} [copy.blurb]  the sentence under it, or '' for none
 * @param {string} [copy.action] the button label
 */
export function joinLinkCard({
  title = 'Were you sent a join link?',
  blurb = 'If somebody sent you a link to join a detachment, paste it here. You do not need to set '
    + 'anything up — this screen is for whoever creates the detachment, not for joining one.',
  action = 'Join',
} = {}) {
  const input = el('input', {
    class: 'input mono', type: 'text', placeholder: 'https://…/#/join?c=…&f=…',
    autocapitalize: 'off', autocorrect: 'off', spellcheck: false,
    onkeydown: (e) => { if (e.key === 'Enter') apply(); },
  });
  const problem = el('div', {});

  const apply = () => {
    clear(problem);
    const text = String(input.value || '').trim();
    const marker = '#/join?';
    const at = text.indexOf(marker);
    // Cut at the first whitespace: people paste a line out of an email, not a
    // tidy URL, and a trailing word would otherwise land inside the query.
    const qs = at < 0 ? '' : text.slice(at + marker.length).split(/\s/)[0];

    if (!qs || !parseJoinParams(new URLSearchParams(qs))) {
      mount(problem, notice('warn', 'That does not look like a join link',
        el('p', {}, 'A join link contains ' + '“' + '#/join?' + '”' + ' and is the whole address, '
          + 'not just the part before it. Copy it again from the message it arrived in, or ask '
          + 'whoever set the detachment up to send it again.')));
      return;
    }
    navigate(`/join?${qs}`);
  };

  return el('section', { class: 'card stack' },
    el('h2', { class: 'section-title' }, title),
    blurb ? el('p', { class: 'muted' }, blurb) : null,
    field('Join link', input, { hint: 'It was emailed to you, and it can be used as often as you like.' }),
    problem,
    el('div', { class: 'row row--end' },
      el('button', { type: 'button', class: 'btn btn--primary', onclick: apply },
        icon('check'), action)));
}
