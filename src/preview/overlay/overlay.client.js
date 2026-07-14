/*
 * Pinpoint review overlay — bundled browser client. Injected into the running
 * app's page (no build-time instrumentation). It lets a client hover, select
 * ANY element, comment, keep a local draft, and submit. On selection it resolves
 * the element's source via `element-source` (bundled) and sends an enriched
 * locator (component + stack + rendered snippet + selector + text) so the server
 * and fix agent can target the edit. Never sees repository or credential data.
 *
 * This file is the bundle ENTRY: scripts/build-overlay.mjs bundles it (with
 * element-source) into the served overlay.bundle.js. Keep it browser-safe.
 */
import { resolveTarget } from './resolve';

const STORAGE_PREFIX = 'pinpoint:draft:';

/*
 * "Precision instrument" palette. Coral signal is chosen deliberately: the
 * on-page markers must stay legible over ARBITRARY host pages (white or dark),
 * and a mid-saturation warm coral holds contrast against both far better than
 * lime or the old purple. Panel chrome lives in CSS vars; the on-page markers
 * (rendered into the host document, not the shadow root) reuse these literals.
 */
const SIGNAL = '#ff5a3c';
const SIGNAL_SOFT = 'rgba(255,90,60,0.18)';
const SIGNAL_LINE = 'rgba(255,90,60,0.55)';

function isPinpointUi(el) {
  let node = el;
  while (node) {
    if (node.getAttribute && node.getAttribute('data-pinpoint-ui')) return true;
    node = node.parentNode || (node.host ? node.host : null);
  }
  return false;
}

/** Elements a client should not be able to annotate (structural/non-visual). */
function isSelectable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'head' || tag === 'script' || tag === 'style') {
    return false;
  }
  return true;
}

function buildController(config) {
  const fetchImpl =
    config.fetch || (typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null);
  const draftKey = STORAGE_PREFIX + config.projectId + ':' + config.reviewKey;
  let reviewerName = '';
  let annotations = [];
  // In-session map of ephemeral id -> live element, so markers re-anchor without
  // instrumentation ids. After a reload the map is empty and we fall back to the
  // persisted CSS selector.
  const liveElements = Object.create(null);
  let nextId = 1;

  try {
    const raw = localStorage.getItem(draftKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      annotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
      reviewerName = typeof parsed.reviewerName === 'string' ? parsed.reviewerName : '';
    }
  } catch (e) {
    annotations = [];
  }

  function persist() {
    try {
      // Element refs are session-only; persist just the serializable annotation.
      localStorage.setItem(draftKey, JSON.stringify({ reviewerName: reviewerName, annotations: annotations }));
    } catch (e) {
      /* storage may be unavailable; drafts are best effort */
    }
  }

  function find(id) {
    for (let i = 0; i < annotations.length; i++) {
      if (annotations[i].id === id) return annotations[i];
    }
    return null;
  }

  function elementFor(id) {
    const live = liveElements[id];
    if (live && live.isConnected) return live;
    const a = find(id);
    if (a && a.selector) {
      try {
        return document.querySelector(a.selector);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  const controller = {
    draftKey: draftKey,
    render: function () { },
    elementFor: elementFor,
    // Resolve + record a selection. Async because source resolution is async.
    select: function (el) {
      if (!isSelectable(el)) return Promise.resolve(null);
      const id = 'pin' + nextId++;
      return resolveTarget(el).then(function (t) {
        annotations.push({
          id: id,
          route: config.route || (typeof location !== 'undefined' ? location.pathname : '/'),
          tag: t.tag,
          componentName: t.componentName,
          source: t.source,
          stack: t.stack,
          selector: t.selector,
          outerHtml: t.outerHtml,
          classes: t.classes,
          visibleText: t.visibleText,
          nearbyText: t.nearbyText,
          comment: '',
        });
        liveElements[id] = el;
        persist();
        controller.render();
        return id;
      });
    },
    commentSilent: function (id, text) {
      const a = find(id);
      if (a) {
        a.comment = text;
        persist();
      }
    },
    remove: function (id) {
      annotations = annotations.filter(function (a) {
        return a.id !== id;
      });
      delete liveElements[id];
      persist();
      controller.render();
    },
    annotations: function () {
      return annotations.slice();
    },
    setReviewerSilent: function (name) {
      reviewerName = name || '';
      persist();
    },
    getReviewer: function () {
      return reviewerName;
    },
    submit: function () {
      const name = (reviewerName || '').trim() || 'Anonymous';
      const withComments = annotations.filter(function (a) {
        return (a.comment || '').trim().length > 0;
      });
      if (withComments.length === 0) {
        return Promise.resolve({ ok: false, error: 'Add at least one comment before submitting.' });
      }
      if (!fetchImpl) return Promise.resolve({ ok: false, error: 'fetch is unavailable' });
      const payload = withComments.map(function (a) {
        return {
          route: a.route,
          tag: a.tag,
          componentName: a.componentName,
          source: a.source,
          stack: a.stack,
          selector: a.selector,
          outerHtml: a.outerHtml,
          classes: a.classes,
          visibleText: a.visibleText,
          nearbyText: a.nearbyText,
          comment: a.comment,
        };
      });
      return fetchImpl(config.apiBase + '/projects/' + config.projectId + '/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewerName: name, route: config.route, annotations: payload }),
      })
        .then(function (resp) {
          if (!resp || !resp.ok) {
            return resp.json().then(
              function (data) {
                return { ok: false, error: (data && data.error) || 'The server rejected the submission.' };
              },
              function () {
                return { ok: false, error: 'The server rejected the submission.' };
              },
            );
          }
          return resp.json().then(
            function (data) {
              annotations = [];
              reviewerName = '';
              try {
                localStorage.removeItem(draftKey);
              } catch (e) {
                /* ignore */
              }
              controller.render();
              return { ok: true, id: data && data.id, jobId: data && data.jobId };
            },
            function () {
              annotations = [];
              reviewerName = '';
              controller.render();
              return { ok: true };
            },
          );
        })
        .catch(function () {
          return { ok: false, error: 'A network error occurred.' };
        });
    },
  };

  return controller;
}

/* ---- Icon set (inline SVG strings, stroke = currentColor) ------------------ */
const ICON = {
  crosshair:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="7"/>' +
    '<path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/></svg>',
  crosshairLg:
    '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" ' +
    'stroke-width="1.3" stroke-linecap="round"><circle cx="12" cy="12" r="7"/>' +
    '<path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/></svg>',
  minimize:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round"><path d="M6 12h12"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 .8 12a1 1 0 0 0 1 .95h6.4a1 1 0 0 0 1-.95L18 7"/>' +
    '<path d="M10 11v5M14 11v5"/></svg>',
  send:
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.5 12h12.5M11.5 6.5 18 12l-6.5 5.5"/></svg>',
  cursor:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M5 3.5 12 20l2.2-6.3L20.5 11z"/></svg>',
  target:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/>' +
    '<path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/>' +
    '<circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>',
};

/* Marker styles live in the HOST document (markers are rendered into <body>, not
 * the shadow root). We inject them once with a stable id, using !important on the
 * few properties a hostile host stylesheet might otherwise clobber. */
function injectMarkerStyles() {
  const existing = document.getElementById('pinpoint-marker-styles');
  if (existing) existing.remove();
  const s = document.createElement('style');
  s.id = 'pinpoint-marker-styles';
  s.setAttribute('data-pinpoint-ui', '1');
  s.textContent = [
    '.pinpoint-marker{margin:0!important;padding:0!important;box-sizing:border-box!important;',
    '  font-family:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace!important;}',
    '.pinpoint-focus{border-radius:7px;animation:pinpoint-focus-glow 1.8s ease-in-out infinite;}',
    '.pinpoint-region{border-radius:6px;animation:pinpoint-pop .18s cubic-bezier(.2,.9,.3,1.3) both;}',
    '.pinpoint-pin{animation:pinpoint-pop .28s cubic-bezier(.2,.9,.3,1.4) both;}',
    '.pinpoint-pin.is-active{animation:pinpoint-pin-pulse 1.6s ease-out infinite;}',
    '@keyframes pinpoint-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}',
    '@keyframes pinpoint-focus-glow{0%,100%{box-shadow:0 0 0 1px ' + SIGNAL_LINE + ',0 0 20px rgba(255,90,60,.22)}',
    '  50%{box-shadow:0 0 0 1px rgba(255,90,60,.85),0 0 28px rgba(255,90,60,.4)}}',
    '@keyframes pinpoint-pin-pulse{0%{box-shadow:0 0 0 0 rgba(255,90,60,.55),0 5px 16px rgba(0,0,0,.45)}',
    '  70%{box-shadow:0 0 0 10px rgba(255,90,60,0),0 5px 16px rgba(0,0,0,.45)}',
    '  100%{box-shadow:0 0 0 0 rgba(255,90,60,0),0 5px 16px rgba(0,0,0,.45)}}',
    // Comment mode: force a crosshair everywhere so it is obvious a click annotates
    // rather than triggering the app. Pinpoint UI (pins/panel) keeps its own cursor.
    'html.pinpoint-commenting, html.pinpoint-commenting *{cursor:crosshair!important;}',
    'html.pinpoint-commenting [data-pinpoint-ui], html.pinpoint-commenting [data-pinpoint-ui] *{cursor:auto!important;}',
    'html.pinpoint-commenting .pinpoint-pin{cursor:pointer!important;}',
  ].join('\n');
  (document.head || document.documentElement).appendChild(s);
}

function mountUI(controller, config) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('pinpoint-root');
  if (existing) existing.remove();

  injectMarkerStyles();

  const host = document.createElement('div');
  host.id = 'pinpoint-root';
  host.setAttribute('data-pinpoint-ui', '1');
  document.body.appendChild(host);

  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;
      --font-sans: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", sans-serif;
      --bg: rgba(18,19,24,0.82);
      --border: rgba(255,255,255,0.10);
      --border-2: rgba(255,255,255,0.16);
      --surface: rgba(255,255,255,0.035);
      --surface-hi: rgba(255,255,255,0.07);
      --text: #f2f0ec;
      --dim: rgba(242,240,236,0.56);
      --faint: rgba(242,240,236,0.32);
      --signal: ${SIGNAL};
      --signal-hi: #ff7d63;
      --signal-soft: rgba(255,90,60,0.14);
      --ok: #57d59b;
    }
    * { box-sizing: border-box; }

    .panel {
      position: fixed; top: 18px; right: 18px; width: 344px; max-height: 82vh;
      display: flex; flex-direction: column;
      font-family: var(--font-mono); color: var(--text);
      background: var(--bg);
      -webkit-backdrop-filter: blur(26px) saturate(160%);
      backdrop-filter: blur(26px) saturate(160%);
      border: 1px solid var(--border);
      border-radius: 18px;
      box-shadow: 0 28px 70px -18px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.06);
      z-index: 2147483647;
      overflow: hidden;
      animation: panel-in .42s cubic-bezier(.16,1,.3,1) both;
    }
    @keyframes panel-in {
      from { opacity: 0; transform: translateY(-10px) scale(.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* ---- Header --------------------------------------------------------- */
    .hd {
      position: relative; flex: 0 0 auto;
      display: flex; align-items: center; gap: 10px;
      padding: 14px 14px 13px 16px;
      border-bottom: 1px solid var(--border);
      background:
        radial-gradient(120% 140% at 0% 0%, rgba(255,90,60,.10), transparent 55%),
        linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,0));
    }
    .cross { color: var(--signal); display: flex; }
    .cross svg { animation: cross-spin 22s linear infinite; }
    @keyframes cross-spin { to { transform: rotate(360deg); } }
    .brand { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .word { font-size: 13px; font-weight: 600; letter-spacing: .22em; }
    .sub { font-size: 8.5px; letter-spacing: .3em; color: var(--faint); text-transform: uppercase; }
    .hd-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
    .count {
      font-size: 11px; font-weight: 600; color: var(--signal);
      min-width: 22px; height: 22px; padding: 0 7px; border-radius: 999px;
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      background: var(--signal-soft); border: 1px solid rgba(255,90,60,.3);
    }
    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0; border-radius: 8px;
      background: var(--surface); border: 1px solid var(--border);
      color: var(--dim); cursor: pointer; transition: all .14s ease;
    }
    .icon-btn:hover { color: var(--text); background: var(--surface-hi); border-color: var(--border-2); }

    /* ---- Mode toggle ---------------------------------------------------- */
    .modebar { flex: 0 0 auto; padding: 12px 14px 0; }
    .seg { display: flex; gap: 3px; padding: 3px; border-radius: 11px; background: rgba(0,0,0,.3); border: 1px solid var(--border); }
    .seg button {
      flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      padding: 7px 6px; font-family: var(--font-mono); font-size: 11px; font-weight: 600; letter-spacing: .08em;
      color: var(--dim); background: transparent; border: 0; border-radius: 8px; cursor: pointer;
      transition: color .14s ease, background .14s ease, box-shadow .14s ease;
    }
    .seg button:hover { color: var(--text); }
    .seg button.on { color: #1a0d09; background: linear-gradient(180deg, var(--signal-hi), var(--signal)); box-shadow: 0 3px 10px -2px rgba(255,90,60,.5); }
    .seg button svg { flex: 0 0 auto; }

    /* ---- Scroll region -------------------------------------------------- */
    .scroll { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; padding: 14px 14px 4px; }
    .scroll::-webkit-scrollbar { width: 9px; }
    .scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border: 3px solid transparent; background-clip: content-box; border-radius: 999px; }
    .scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.22); background-clip: content-box; }

    .hint { font-size: 11px; line-height: 1.5; color: var(--dim); margin: 0 2px 12px; }

    /* ---- Empty state ---------------------------------------------------- */
    .empty { text-align: center; padding: 26px 12px 30px; }
    .empty-mark {
      width: 62px; height: 62px; margin: 0 auto 16px; border-radius: 16px;
      display: flex; align-items: center; justify-content: center; color: var(--signal);
      background: var(--signal-soft); border: 1px solid rgba(255,90,60,.28);
      animation: empty-float 3.4s ease-in-out infinite;
    }
    @keyframes empty-float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
    .empty-title { font-size: 13px; letter-spacing: .04em; color: var(--text); margin: 0 0 6px; }
    .empty-sub { font-family: var(--font-sans); font-size: 12px; line-height: 1.55; color: var(--dim); margin: 0 auto; max-width: 220px; }

    /* ---- Annotation item ------------------------------------------------ */
    .item {
      position: relative; border: 1px solid var(--border); border-radius: 12px;
      padding: 11px 11px 12px; margin-bottom: 10px; background: var(--surface);
      transition: border-color .16s ease, background .16s ease;
      animation: item-in .34s cubic-bezier(.16,1,.3,1) both;
    }
    @keyframes item-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
    .item:nth-child(2) { animation-delay: .03s; }
    .item:nth-child(3) { animation-delay: .06s; }
    .item:nth-child(4) { animation-delay: .09s; }
    .item:nth-child(5) { animation-delay: .12s; }
    .item:hover { border-color: var(--border-2); background: var(--surface-hi); }
    .item.active { border-color: rgba(255,90,60,.55); box-shadow: 0 0 0 1px rgba(255,90,60,.35), 0 8px 22px -10px rgba(255,90,60,.5); }

    .item-hd { display: flex; align-items: center; gap: 8px; }
    .pin {
      flex: 0 0 auto; width: 22px; height: 22px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600; color: #1a0d09;
      background: var(--signal); box-shadow: 0 2px 8px rgba(255,90,60,.4);
    }
    .tag {
      font-size: 10.5px; letter-spacing: .02em; color: var(--dim);
      padding: 2px 7px; border-radius: 6px; background: rgba(255,255,255,.05);
      border: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tag b { color: var(--signal-hi); font-weight: 600; }
    .del {
      margin-left: auto; flex: 0 0 auto;
      display: inline-flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; border-radius: 7px; padding: 0;
      background: transparent; border: 1px solid transparent; color: var(--faint);
      cursor: pointer; opacity: 0; transition: all .14s ease;
    }
    .item:hover .del, .item.active .del { opacity: 1; }
    .del:hover { color: var(--signal-hi); background: var(--signal-soft); border-color: rgba(255,90,60,.3); }

    textarea {
      width: 100%; margin-top: 9px; padding: 9px 10px; resize: vertical; min-height: 52px;
      font-family: var(--font-sans); font-size: 12.5px; line-height: 1.5; color: var(--text);
      background: rgba(0,0,0,.28); border: 1px solid var(--border); border-radius: 9px;
      outline: none; transition: border-color .14s ease, box-shadow .14s ease;
    }
    textarea::placeholder { color: var(--faint); }
    textarea:focus { border-color: rgba(255,90,60,.55); box-shadow: 0 0 0 3px var(--signal-soft); }

    /* ---- Footer --------------------------------------------------------- */
    .ft { flex: 0 0 auto; padding: 12px 14px 14px; border-top: 1px solid var(--border); background: linear-gradient(0deg, rgba(255,255,255,.03), transparent); }
    .field { margin-bottom: 10px; }
    .field label { display: block; font-size: 8.5px; letter-spacing: .26em; text-transform: uppercase; color: var(--faint); margin: 0 0 6px 2px; }
    .name {
      width: 100%; padding: 8px 10px; font-family: var(--font-mono); font-size: 12px; color: var(--text);
      background: rgba(0,0,0,.28); border: 1px solid var(--border); border-radius: 9px; outline: none;
      transition: border-color .14s ease, box-shadow .14s ease;
    }
    .name::placeholder { color: var(--faint); }
    .name:focus { border-color: rgba(255,90,60,.55); box-shadow: 0 0 0 3px var(--signal-soft); }

    .submit {
      width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
      padding: 11px; font-family: var(--font-mono); font-size: 12px; font-weight: 600; letter-spacing: .06em;
      color: #1a0d09; background: linear-gradient(180deg, var(--signal-hi), var(--signal));
      border: 0; border-radius: 11px; cursor: pointer;
      box-shadow: 0 8px 22px -8px rgba(255,90,60,.65); transition: transform .12s ease, box-shadow .16s ease, filter .16s ease;
    }
    .submit:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 12px 26px -8px rgba(255,90,60,.75); filter: brightness(1.05); }
    .submit:active:not(:disabled) { transform: translateY(0); }
    .submit:disabled { opacity: .55; cursor: progress; }

    .msg { font-family: var(--font-sans); font-size: 11.5px; line-height: 1.45; margin-top: 10px; padding: 0; min-height: 0; }
    .msg.on { padding: 9px 11px; border-radius: 9px; }
    .msg.ok  { color: var(--ok); background: rgba(87,213,155,.1); border: 1px solid rgba(87,213,155,.28); }
    .msg.err { color: var(--signal-hi); background: var(--signal-soft); border: 1px solid rgba(255,90,60,.3); }

    /* ---- Collapsed pill ------------------------------------------------- */
    .fab {
      position: fixed; top: 18px; right: 18px; z-index: 2147483647;
      display: inline-flex; align-items: center; gap: 8px; padding: 9px 13px 9px 11px;
      font-family: var(--font-mono); font-size: 12px; font-weight: 600; letter-spacing: .16em; color: var(--text);
      background: var(--bg); -webkit-backdrop-filter: blur(26px) saturate(160%); backdrop-filter: blur(26px) saturate(160%);
      border: 1px solid var(--border); border-radius: 999px; cursor: pointer;
      box-shadow: 0 16px 40px -12px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06);
      animation: panel-in .34s cubic-bezier(.16,1,.3,1) both; transition: transform .14s ease, border-color .14s ease;
    }
    .fab:hover { transform: translateY(-1px); border-color: var(--border-2); }
    .fab .cross { color: var(--signal); }
    .fab-count {
      font-size: 10.5px; color: var(--signal); background: var(--signal-soft);
      border: 1px solid rgba(255,90,60,.3); border-radius: 999px; padding: 1px 7px; letter-spacing: 0;
    }

    @media (max-width: 420px) {
      .panel { left: 12px; right: 12px; top: 12px; width: auto; }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel, .fab, .item, .cross svg, .empty-mark { animation: none !important; }
    }
  `;
  root.appendChild(style);

  let activeId = null;
  let collapsed = false;
  let commentMode = true; // default: land ready to annotate; toggle/Esc drops to Browse
  let markers = [];
  let message = '';
  let messageKind = '';

  Array.prototype.slice.call(document.querySelectorAll('.pinpoint-marker')).forEach(function (n) {
    n.remove();
  });

  // A coral frame around the viewport, shown only while commenting, so the whole
  // page visibly signals "clicks land as feedback right now".
  const frameEl = document.createElement('div');
  frameEl.className = 'pinpoint-marker';
  frameEl.setAttribute('data-pinpoint-ui', '1');
  frameEl.style.cssText =
    'position:fixed;inset:0;display:none;pointer-events:none;z-index:2147483643;border-radius:2px;' +
    'box-shadow:inset 0 0 0 2px ' + SIGNAL_LINE + ',inset 0 0 60px rgba(255,90,60,.14);';
  document.body.appendChild(frameEl);

  // Effective commenting state: intent AND panel expanded. A collapsed pill must
  // never keep hijacking clicks, since there is no visible panel to explain why.
  function isCommenting() {
    return commentMode && !collapsed;
  }
  function syncMode() {
    const on = isCommenting();
    frameEl.style.display = on ? 'block' : 'none';
    const rootEl = document.documentElement;
    if (rootEl && rootEl.classList) rootEl.classList.toggle('pinpoint-commenting', on);
    if (!on) hideFocus();
  }

  function placeBox(node, rect) {
    node.style.left = Math.round(rect.left + window.scrollX) + 'px';
    node.style.top = Math.round(rect.top + window.scrollY) + 'px';
    node.style.width = Math.max(Math.round(rect.width), 8) + 'px';
    node.style.height = Math.max(Math.round(rect.height), 16) + 'px';
  }

  const focusBox = document.createElement('div');
  focusBox.className = 'pinpoint-marker pinpoint-focus';
  focusBox.setAttribute('data-pinpoint-ui', '1');
  focusBox.style.cssText =
    'position:absolute;display:none;pointer-events:none;box-sizing:border-box;' +
    'border:1.5px solid ' + SIGNAL + ';background:' + SIGNAL_SOFT + ';z-index:2147483644;' +
    'transition:left .08s ease-out,top .08s ease-out,width .08s ease-out,height .08s ease-out;';
  document.body.appendChild(focusBox);

  function showFocus(el) {
    if (!el) return;
    placeBox(focusBox, el.getBoundingClientRect());
    focusBox.style.display = 'block';
  }
  function hideFocus() {
    if (activeId) return;
    focusBox.style.display = 'none';
  }
  function focusComment(id) {
    if (!id) return;
    activeId = id;
    showFocus(controller.elementFor(id));
    controller.render();
    const item = root.querySelector('[data-item-id="' + id + '"]');
    if (item) {
      if (item.scrollIntoView) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const ta = item.querySelector('textarea');
      if (ta) ta.focus();
    }
  }

  function clearMarkers() {
    markers.forEach(function (m) {
      m.remove();
    });
    markers = [];
  }
  function drawPins() {
    clearMarkers();
    if (activeId && !controller.annotations().some(function (a) { return a.id === activeId; })) {
      activeId = null;
      focusBox.style.display = 'none';
    }
    controller.annotations().forEach(function (a, i) {
      const target = controller.elementFor(a.id);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const isActive = a.id === activeId;

      const region = document.createElement('div');
      region.className = 'pinpoint-marker pinpoint-region';
      region.setAttribute('data-pinpoint-ui', '1');
      region.style.cssText =
        'position:absolute;pointer-events:none;box-sizing:border-box;z-index:2147483645;' +
        'border:1.5px ' + (isActive ? 'solid' : 'dashed') + ' ' + SIGNAL_LINE + ';' +
        'background:' + (isActive ? SIGNAL_SOFT : 'rgba(255,90,60,0.08)') + ';';
      placeBox(region, rect);
      document.body.appendChild(region);
      markers.push(region);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'pinpoint-marker pinpoint-pin' + (isActive ? ' is-active' : '');
      pin.setAttribute('data-pinpoint-ui', '1');
      pin.setAttribute('aria-label', 'Comment ' + (i + 1));
      pin.textContent = String(i + 1);
      pin.style.cssText =
        'position:absolute;transform:translate(-50%,-50%);width:22px;height:22px;padding:0;' +
        'border-radius:8px 8px 8px 2px;background:' + SIGNAL + ';color:#1a0d09;' +
        'border:2px solid rgba(255,255,255,.9);display:flex;align-items:center;justify-content:center;' +
        'font:600 11px ui-monospace,"SF Mono",Menlo,monospace;box-shadow:0 5px 16px rgba(0,0,0,.45);' +
        'cursor:pointer;z-index:2147483646;';
      pin.style.left = Math.round(rect.left + window.scrollX) + 'px';
      pin.style.top = Math.round(rect.top + window.scrollY) + 'px';
      pin.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        collapsed = false;
        focusComment(a.id);
      });
      document.body.appendChild(pin);
      markers.push(pin);
    });
  }

  const panel = document.createElement('div');
  root.appendChild(panel);

  controller.render = function () {
    const list = controller.annotations();

    if (collapsed) {
      panel.className = '';
      panel.innerHTML =
        '<button class="fab" type="button" aria-label="Expand Pinpoint review">' +
        '<span class="cross">' + ICON.crosshair + '</span>' +
        '<span>PINPOINT</span>' +
        (list.length ? '<span class="fab-count">' + list.length + '</span>' : '') +
        '</button>';
      panel.querySelector('.fab').addEventListener('click', function () {
        collapsed = false;
        controller.render();
      });
      syncMode();
      drawPins();
      return;
    }

    panel.className = 'panel';
    panel.innerHTML = '';

    // Header
    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.innerHTML =
      '<span class="cross">' + ICON.crosshair + '</span>' +
      '<span class="brand"><span class="word">PINPOINT</span><span class="sub">Review mode</span></span>' +
      '<span class="hd-actions">' +
      (list.length ? '<span class="count">' + list.length + '</span>' : '') +
      '<button class="icon-btn" type="button" data-act="min" aria-label="Minimize">' + ICON.minimize + '</button>' +
      '</span>';
    hd.querySelector('[data-act="min"]').addEventListener('click', function () {
      collapsed = true;
      controller.render();
    });
    panel.appendChild(hd);

    // Mode toggle: Browse (use the app) vs Comment (clicks annotate)
    const modebar = document.createElement('div');
    modebar.className = 'modebar';
    modebar.innerHTML =
      '<div class="seg" role="group" aria-label="Interaction mode">' +
      '<button type="button" data-mode="browse" aria-pressed="' + (!commentMode) + '" class="' + (commentMode ? '' : 'on') + '">' +
      ICON.cursor + '<span>Browse</span></button>' +
      '<button type="button" data-mode="comment" aria-pressed="' + commentMode + '" class="' + (commentMode ? 'on' : '') + '">' +
      ICON.target + '<span>Comment</span></button>' +
      '</div>';
    modebar.querySelector('[data-mode="browse"]').addEventListener('click', function () {
      commentMode = false;
      activeId = null;
      controller.render();
    });
    modebar.querySelector('[data-mode="comment"]').addEventListener('click', function () {
      commentMode = true;
      controller.render();
    });
    panel.appendChild(modebar);

    // Scroll body
    const scroll = document.createElement('div');
    scroll.className = 'scroll';
    panel.appendChild(scroll);

    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.innerHTML =
        '<div class="empty-mark">' + ICON.crosshairLg + '</div>' +
        (commentMode
          ? '<p class="empty-title">Point at anything</p>' +
          '<p class="empty-sub">Click any element on the page to leave a note. Your feedback turns into a fix automatically.</p>'
          : '<p class="empty-title">Browsing the app</p>' +
          '<p class="empty-sub">Navigate freely — clicks work as usual. Switch to Comment mode when you want to leave feedback.</p>');
      scroll.appendChild(empty);
    } else {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = commentMode
        ? 'Tap a marker to jump to its note. Add your comments, then submit.'
        : 'Browse mode — clicks use the app. Switch to Comment to add more notes.';
      scroll.appendChild(hint);

      list.forEach(function (a) {
        const item = document.createElement('div');
        item.className = 'item' + (a.id === activeId ? ' active' : '');
        item.setAttribute('data-item-id', a.id);
        item.addEventListener('mouseenter', function () {
          showFocus(controller.elementFor(a.id));
        });
        item.addEventListener('mouseleave', hideFocus);

        const head = document.createElement('div');
        head.className = 'item-hd';
        const idx = list.indexOf(a) + 1;
        head.innerHTML =
          '<span class="pin">' + idx + '</span>' +
          '<span class="tag">&lt;<b>' + a.tag + '</b>&gt;</span>';
        const del = document.createElement('button');
        del.className = 'del';
        del.type = 'button';
        del.setAttribute('aria-label', 'Delete comment ' + idx);
        del.innerHTML = ICON.trash;
        del.addEventListener('click', function () {
          controller.remove(a.id);
        });
        head.appendChild(del);
        item.appendChild(head);

        const ta = document.createElement('textarea');
        ta.value = a.comment;
        ta.placeholder = 'What should change here?';
        ta.addEventListener('input', function () {
          controller.commentSilent(a.id, ta.value);
        });
        ta.addEventListener('focus', function () {
          activeId = a.id;
          showFocus(controller.elementFor(a.id));
        });
        item.appendChild(ta);
        scroll.appendChild(item);
      });
    }

    // Footer (name + submit) only appears once there is something to send.
    if (list.length) {
      const ft = document.createElement('div');
      ft.className = 'ft';

      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      label.textContent = 'Your name';
      const nameInput = document.createElement('input');
      nameInput.className = 'name';
      nameInput.type = 'text';
      nameInput.placeholder = 'Anonymous';
      nameInput.value = controller.getReviewer();
      nameInput.addEventListener('input', function () {
        controller.setReviewerSilent(nameInput.value);
      });
      field.appendChild(label);
      field.appendChild(nameInput);
      ft.appendChild(field);

      const submit = document.createElement('button');
      submit.className = 'submit';
      submit.type = 'button';
      submit.innerHTML = ICON.send + '<span>Submit feedback</span>';
      submit.addEventListener('click', function () {
        submit.disabled = true;
        submit.innerHTML = '<span>Sending…</span>';
        controller.submit().then(function (res) {
          if (res.ok) {
            messageKind = 'ok';
            message = res.jobId
              ? 'Thanks! Your feedback was submitted — a fix pull request is being generated automatically.'
              : 'Thank you! Your feedback was submitted.';
          } else {
            messageKind = 'err';
            message = res.error || 'Submission failed.';
          }
          controller.render();
        });
      });
      ft.appendChild(submit);

      if (message) {
        const msg = document.createElement('div');
        msg.className = 'msg on ' + (messageKind || '');
        msg.textContent = message;
        ft.appendChild(msg);
      }
      panel.appendChild(ft);
    } else if (message) {
      // Success clears the list; keep the confirmation visible in a bare footer.
      const ft = document.createElement('div');
      ft.className = 'ft';
      const msg = document.createElement('div');
      msg.className = 'msg on ' + (messageKind || '');
      msg.textContent = message;
      ft.appendChild(msg);
      panel.appendChild(ft);
    }

    syncMode();
    drawPins();
  };

  controller.render();

  document.addEventListener(
    'click',
    function (e) {
      // Browse mode (or collapsed): let clicks flow to the app untouched.
      if (!isCommenting()) return;
      const target = e.target;
      if (!target || isPinpointUi(target) || !isSelectable(target)) return;
      e.preventDefault();
      e.stopPropagation();
      message = '';
      messageKind = '';
      controller.select(target).then(function (id) {
        collapsed = false;
        focusComment(id);
      });
    },
    true,
  );

  document.addEventListener(
    'mouseover',
    function (e) {
      if (!isCommenting()) return;
      const target = e.target;
      if (!target || isPinpointUi(target) || !isSelectable(target)) {
        hideFocus();
        return;
      }
      showFocus(target);
    },
    true,
  );
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // First Esc clears the active selection; if none, drop out of Comment mode.
    if (activeId) {
      activeId = null;
      hideFocus();
      controller.render();
    } else if (commentMode) {
      commentMode = false;
      controller.render();
    }
  });
  window.addEventListener('resize', function () {
    drawPins();
    if (activeId) showFocus(controller.elementFor(activeId));
    else hideFocus();
  });
}

const Pinpoint = {
  init: function (config) {
    const controller = buildController(config);
    try {
      mountUI(controller, config);
    } catch (e) {
      /* UI is optional in headless/test contexts */
    }
    return controller;
  },
};

if (typeof window !== 'undefined') {
  window.Pinpoint = Pinpoint;
  if (window.__PINPOINT_CONFIG__ && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        Pinpoint.init(window.__PINPOINT_CONFIG__);
      });
    } else {
      Pinpoint.init(window.__PINPOINT_CONFIG__);
    }
  }
}
