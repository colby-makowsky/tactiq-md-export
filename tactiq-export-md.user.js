// ==UserScript==
// @name         Tactiq → Markdown one-click export
// @namespace    https://github.com/colby-makowsky/tactiq-md-export
// @version      1.1.1
// @description  Adds a download icon to every meeting row on Tactiq (Search + My Meetings) that exports the transcript as a clean .md file named "YYYY-MM-DD - <title>.md".
// @author       Colby Makowsky
// @match        https://app.tactiq.io/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/colby-makowsky/tactiq-md-export/main/tactiq-export-md.user.js
// @updateURL    https://raw.githubusercontent.com/colby-makowsky/tactiq-md-export/main/tactiq-export-md.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1) Capture the Firebase bearer token from the app's own API traffic.
  //    Tactiq's web app constantly calls api2.tactiq.io with an Authorization
  //    header. We wrap fetch (at document-start, before the app runs) and stash
  //    the latest token. The app refreshes it for us, so it never goes stale.
  // ---------------------------------------------------------------------------
  let TOKEN = null;
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      let auth = null;
      if (init && init.headers) {
        auth = new Headers(init.headers).get('authorization');
      } else if (input && input.headers && typeof input.headers.get === 'function') {
        auth = input.headers.get('authorization');
      }
      if (url.includes('api2.tactiq.io') && auth) TOKEN = auth;
    } catch (e) { /* ignore */ }
    return origFetch.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // 2) GraphQL: fetch the meeting + transcript blocks for a given meeting id.
  // ---------------------------------------------------------------------------
  const QUERY = `query meetingWithTranscript($meetingId: ID!) {
    meeting(id: $meetingId) {
      id
      title
      created
      duration
      participants { name }
      transcript
    }
  }`;

  async function fetchMeeting(meetingId) {
    if (!TOKEN) {
      throw new Error('No auth token captured yet. Click around the app once (or reload), then try again.');
    }
    const res = await origFetch('https://api2.tactiq.io/api/2/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': TOKEN,
        'accept': 'application/graphql-response+json,application/json;q=0.9',
      },
      body: JSON.stringify({
        operationName: 'meetingWithTranscript',
        variables: { meetingId },
        query: QUERY,
      }),
    });
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map(e => e.message).join('; '));
    const meeting = json.data && json.data.meeting;
    if (!meeting) throw new Error('No meeting data returned.');
    return meeting;
  }

  // ---------------------------------------------------------------------------
  // 3) Formatting helpers.
  // ---------------------------------------------------------------------------
  // Tactiq stores epoch-ms timestamps plus a tzOffset (ms) for the meeting's
  // local wall-clock. Subtracting the offset and formatting in UTC reproduces
  // exactly what Tactiq shows (e.g. "2:03:59 PM").
  function wallDate(ms, tzOffset) {
    return new Date(ms - (tzOffset || 0));
  }
  function timeStr(ms, tzOffset) {
    return wallDate(ms, tzOffset).toLocaleTimeString('en-US', {
      timeZone: 'UTC', hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
  }
  function headerDate(ms, tzOffset) {
    return wallDate(ms, tzOffset).toLocaleString('en-US', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  }
  // ISO 8601 wall-clock + explicit offset, e.g. "2026-03-12T14:03-05:00".
  // Tactiq's tzOffset is JS-style (minutes/ms *behind* UTC), so the printed
  // offset is its negation. Unambiguous and sortable; date = slice(0, 10).
  function isoStart(ms, tzOffset) {
    const p = (n) => String(n).padStart(2, '0');
    const d = wallDate(ms, tzOffset);
    const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    const time = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    const om = Math.round(-(tzOffset || 0) / 60000);
    const off = `${om < 0 ? '-' : '+'}${p(Math.floor(Math.abs(om) / 60))}:${p(Math.abs(om) % 60)}`;
    return `${day}T${time}${off}`;
  }

  // "03/12/2026 Confirmed: ..." -> { date:"2026-03-12", rest:"Confirmed: ..." }
  function splitTitle(title, createdMs) {
    const m = title.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      return {
        date: `${m[3]}-${m[1]}-${m[2]}`,
        rest: title.slice(m[0].length).replace(/^[\s:–—-]+/, ''),
      };
    }
    const d = new Date(createdMs || Date.now());
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      rest: title,
    };
  }

  function buildFilename(title, createdMs) {
    const { date, rest } = splitTitle(title, createdMs);
    const clean = rest
      .replace(/[\/\\:*?"<>|]+/g, ' - ') // filesystem-illegal -> " - "
      .replace(/\s+/g, ' ')
      .replace(/^[\s-]+|[\s-]+$/g, '')
      .trim();
    return clean ? `${date} - ${clean}.md` : `${date}.md`;
  }

  // Merge consecutive blocks by the same speaker into one "turn", so one
  // person's many tiny fragments become a single readable paragraph.
  function mergeTurns(blocks) {
    const turns = [];
    for (const b of blocks) {
      const text = (b.transcript || '').trim();
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last && last.speaker === b.speakerName) {
        last.text += ' ' + text;
      } else {
        turns.push({ speaker: b.speakerName, ts: b.timestamp, text });
      }
    }
    return turns;
  }

  // A line ending in two spaces is a Markdown hard break — renders as a <br>
  // regardless of the reader's "strict line breaks" setting.
  const BR = '  ';

  // Emit a YAML scalar, quoting ONLY when a bare value would actually be
  // mis-parsed. This is a denylist (not an allowlist) so ordinary punctuation —
  // curly quotes, parentheses, accents, mid-string quotes — stays unquoted; we
  // only wrap leading indicator chars, ": "/trailing ":", " #", and bool/number
  // lookalikes.
  function yaml(s) {
    const v = String(s);
    const needsQuote =
      v === '' ||
      /^\s|\s$/.test(v) ||                                    // leading/trailing whitespace
      /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) ||                    // leading YAML indicator
      /:(\s|$)/.test(v) ||                                    // ": " or trailing ":" (looks like a mapping)
      /\s#/.test(v) ||                                        // " #" (looks like a comment)
      /^(true|false|null|yes|no|on|off|~)$/i.test(v) ||       // bool / null lookalike
      /^[+-]?(\d[\d,_]*\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v); // number lookalike
    return needsQuote ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
  }

  function buildMarkdown(meeting) {
    const t = meeting.transcript || {};
    const tz = t.tzOffset || 0;
    const blocks = (t.blocks || []).filter((b) => !b.isDeleted);

    const stamps = blocks.map((b) => b.timestamp).filter(Boolean);
    const durMin = stamps.length
      ? Math.round((Math.max(...stamps) - Math.min(...stamps)) / 60000)
      : Math.round((meeting.duration || 0) / 60);

    const startMs = t.createdAt || meeting.created;
    const dateStr = startMs ? headerDate(startMs, tz) : '';
    // Derive date + start from one wall-clock source so they never disagree;
    // fall back to the title-parsed date only when there's no start timestamp.
    const startIso = startMs ? isoStart(startMs, tz) : '';
    const isoDate = startIso ? startIso.slice(0, 10) : splitTitle(meeting.title, meeting.created).date;
    const names = (meeting.participants || []).map((p) => p.name).filter(Boolean);
    const participants = names.join(', ');
    const heading = splitTitle(meeting.title, meeting.created).rest || meeting.title;
    const sourceUrl = `https://app.tactiq.io/transcripts/${meeting.id}`;

    const out = [];

    // YAML frontmatter — the portable, tool-agnostic metadata standard.
    // qmd indexes this as plain text; Obsidian reads it as properties.
    out.push('---');
    out.push(`title: ${yaml(heading)}`);
    if (isoDate) out.push(`date: ${isoDate}`);
    if (startIso) out.push(`start: ${startIso}`);
    out.push(`duration_minutes: ${durMin}`);
    if (names.length) {
      out.push('participants:');
      names.forEach((n) => out.push(`  - ${yaml(n)}`));
    }
    out.push(`source: ${sourceUrl}`);
    out.push('tags: [meeting, transcript]');
    out.push('---', '');

    out.push(`# ${heading}`, '');

    // Plain metadata line — keeps date/duration/participants searchable as
    // body prose (qmd queries body text, not frontmatter fields).
    const metaBits = [dateStr, `${durMin} min`, participants].filter(Boolean);
    out.push(`**${metaBits.join(' · ')}** · [Open in Tactiq](${sourceUrl})`, '');

    // Highlights (pinned blocks) — a real section so qmd can isolate it as a
    // chunk, instead of an Obsidian-only callout.
    const pinned = blocks.filter((b) => b.isPinned);
    if (pinned.length) {
      out.push('## Highlights', '');
      pinned.forEach((b) =>
        out.push(`- **${b.speakerName}** · ${timeStr(b.timestamp, tz)} — ${(b.transcript || '').trim()}`));
      out.push('');
    }

    // Transcript — one paragraph per merged speaker turn
    out.push('## Transcript', '');
    mergeTurns(blocks).forEach((turn) => {
      out.push(`**${turn.speaker}** · ${timeStr(turn.ts, tz)}${BR}`);
      out.push(turn.text, '');
    });

    return out.join('\n').replace(/\n+$/, '\n');
  }

  function triggerDownload(filename, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // One meeting -> download its .md. Shared by the row button and bulk button.
  async function exportMeeting(meetingId) {
    const meeting = await fetchMeeting(meetingId);
    triggerDownload(buildFilename(meeting.title, meeting.created), buildMarkdown(meeting));
  }

  // ---------------------------------------------------------------------------
  // 4) The injected button.
  // ---------------------------------------------------------------------------
  const DOWNLOAD_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SPINNER_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>';
  const CHECK_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const ERROR_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // Custom tooltip that matches Tactiq's by reusing its own utility classes
  // (rounded-md bg-foreground px-3 py-1.5 text-background text-sm shadow-lg).
  // Using their tokens means it auto-matches light/dark theme.
  let tipEl = null;
  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'rounded-md bg-foreground px-3 py-1.5 text-background text-sm shadow-lg';
    tipEl.style.cssText =
      'position:fixed;z-index:2147483005;pointer-events:none;opacity:0;' +
      'transition:opacity .12s;white-space:nowrap;';
    const arrow = document.createElement('div');
    arrow.className = 'bg-foreground tq-tip-arrow';
    arrow.style.cssText =
      'position:absolute;width:10px;height:10px;bottom:-5px;border-radius:2px;transform:rotate(45deg);';
    const txt = document.createElement('span');
    txt.className = 'tq-tip-text';
    tipEl.append(arrow, txt);
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function showTip(target, text) {
    const el = ensureTip();
    el.querySelector('.tq-tip-text').textContent = text;
    el.style.display = 'block';
    el.style.opacity = '0';
    requestAnimationFrame(() => {
      const r = target.getBoundingClientRect();
      const tw = el.offsetWidth, th = el.offsetHeight;
      const center = r.left + r.width / 2;
      let left = Math.max(4, Math.min(center - tw / 2, window.innerWidth - tw - 4));
      const top = r.top - th - 14; // match Tactiq's ~14px gap above the icon
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.querySelector('.tq-tip-arrow').style.left = (center - left - 5) + 'px';
      el.style.opacity = '1';
    });
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = '0'; }

  function attachTip(el) {
    let t = null;
    const show = () => { t = setTimeout(() => showTip(el, el._tip || 'Download'), 500); };
    const hide = () => { clearTimeout(t); hideTip(); };
    el.addEventListener('mouseenter', show);
    el.addEventListener('mouseleave', hide);
    el.addEventListener('focus', () => showTip(el, el._tip || 'Download'));
    el.addEventListener('blur', hide);
    el.addEventListener('click', hide);
  }

  function makeButton(templateBtn, meetingId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = templateBtn ? templateBtn.className : '';
    btn.classList.add('tq-md-export');
    btn.setAttribute('aria-label', 'Download');
    btn._tip = 'Download';
    btn.innerHTML = DOWNLOAD_SVG;
    attachTip(btn);

    let busy = false;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      busy = true;
      btn.innerHTML = SPINNER_SVG;
      try {
        await exportMeeting(meetingId);
        btn.innerHTML = CHECK_SVG;
        btn.style.color = '#16a34a';
      } catch (err) {
        console.error('[Tactiq→MD] export failed:', err);
        btn.innerHTML = ERROR_SVG;
        btn.style.color = '#dc2626';
        btn._tip = 'Export failed: ' + err.message;
      } finally {
        setTimeout(() => {
          btn.innerHTML = DOWNLOAD_SVG;
          btn.style.color = '';
          btn._tip = 'Download';
          busy = false;
        }, 1600);
      }
    }, true);

    return btn;
  }

  // ---------------------------------------------------------------------------
  // 5) Inject a button into every meeting row's action-icon group.
  //    Anchor off the per-row "Archive meeting:" button (rightmost icon); its
  //    parent is the icon group, and the row's <a href="/transcripts/<id>">
  //    gives us the meeting id.
  // ---------------------------------------------------------------------------
  function findMeetingId(fromEl) {
    let el = fromEl;
    for (let i = 0; i < 12 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const link = el.querySelector('a[href*="/transcripts/"]');
      if (link) {
        const m = link.getAttribute('href').match(/\/transcripts\/([A-Za-z0-9_-]+)/);
        if (m) return m[1];
      }
    }
    return null;
  }

  // The shared icon-group is the smallest ancestor holding both the Copy-link
  // and Archive icons (each icon is otherwise wrapped in its own tooltip
  // trigger — appending into that wrapper would borrow its tooltip).
  function findIconGroup(archiveBtn) {
    let el = archiveBtn;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentElement;
      if (el &&
          el.querySelector('button[aria-label^="Copy link to:"]') &&
          el.querySelector('button[aria-label^="Archive meeting:"]')) {
        return el;
      }
    }
    return archiveBtn.parentElement;
  }

  function inject() {
    const archiveBtns = document.querySelectorAll('button[aria-label^="Archive meeting:"]');
    archiveBtns.forEach((archiveBtn) => {
      const group = findIconGroup(archiveBtn);
      if (!group || group.querySelector('.tq-md-export')) return;
      const meetingId = findMeetingId(archiveBtn);
      if (!meetingId) return;
      group.appendChild(makeButton(archiveBtn, meetingId));
    });
    // Keep our icon last in its group. When a row is checkbox-selected, Tactiq
    // re-mounts that row's action icons and can shove our (non-React) button to
    // the front — re-append it so the icon order stays consistent everywhere.
    document.querySelectorAll('.tq-md-export').forEach((btn) => {
      const g = btn.parentElement;
      if (g && g.lastElementChild !== btn) g.appendChild(btn);
    });
    injectBulk();
  }

  // ---------------------------------------------------------------------------
  // 5b) Bulk: when rows are checkbox-selected, Tactiq shows a floating toolbar
  //     ("N selected | Ask Tactiq AI | Add to space | Archive"). Each row's
  //     checkbox is <button role="checkbox" id="<meetingId>">, so the selected
  //     ids are just the checked checkboxes' ids. Add a "Download" button.
  // ---------------------------------------------------------------------------
  const ID_RE = /^[A-Za-z0-9_-]{16,24}$/;

  function getSelectedMeetingIds() {
    const ids = [];
    document
      .querySelectorAll('[role="checkbox"][aria-checked="true"], [role="checkbox"][data-state="checked"]')
      .forEach((cb) => {
        const id = cb.id;
        if (id && ID_RE.test(id) && !ids.includes(id)) ids.push(id);
      });
    return ids;
  }

  function findSelectionBar() {
    const counter = [...document.querySelectorAll('span, button')].find((el) =>
      /^\d+\s+selected$/.test((el.textContent || '').trim()));
    if (!counter) return null;
    let bar = counter;
    for (let i = 0; i < 7 && bar.parentElement; i++) {
      bar = bar.parentElement;
      const btns = [...bar.querySelectorAll('button')];
      if (btns.some((b) => /Archive|Add to space|Ask Tactiq/.test(b.textContent || ''))) return bar;
    }
    return null;
  }

  function injectBulk() {
    const bar = findSelectionBar();
    if (!bar || bar.querySelector('.tq-md-bulk')) return;
    const tmpl = [...bar.querySelectorAll('button')]
      .find((b) => /Archive|Add to space/.test(b.textContent || ''));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = tmpl ? tmpl.className : '';
    btn.classList.add('tq-md-bulk');
    const ICON =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
    btn.innerHTML = `${ICON}<span>Download</span>`;
    const label = btn.querySelector('span');

    let busy = false;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      const ids = getSelectedMeetingIds();
      if (!ids.length) return;
      busy = true;
      let ok = 0, fail = 0;
      for (let i = 0; i < ids.length; i++) {
        if (label) label.textContent = `Downloading ${i + 1}/${ids.length}…`;
        try { await exportMeeting(ids[i]); ok++; }
        catch (err) { console.error('[Tactiq→MD] bulk item failed', ids[i], err); fail++; }
        await sleep(500); // sequential, so the browser groups the downloads
      }
      if (label) label.textContent = fail ? `Done — ${ok} ok, ${fail} failed` : `Downloaded ${ok}`;
      setTimeout(() => { if (label) label.textContent = 'Download'; busy = false; }, 2800);
    }, true);

    bar.appendChild(btn);
  }

  // Re-inject as the SPA re-renders / virtualizes rows. Debounced.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; inject(); });
  }

  function start() {
    inject();
    const obs = new MutationObserver(schedule);
    obs.observe(document.body, { childList: true, subtree: true });
    // safety net
    setInterval(inject, 2000);
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
