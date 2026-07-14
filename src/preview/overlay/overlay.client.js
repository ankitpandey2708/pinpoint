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
const ACCENT = '#6d5efc';

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
    render: function () {},
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
          elementId: t.elementId,
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
          elementId: a.elementId,
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

function mountUI(controller, config) {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById('pinpoint-root');
  if (existing) existing.remove();

  const host = document.createElement('div');
  host.id = 'pinpoint-root';
  host.setAttribute('data-pinpoint-ui', '1');
  document.body.appendChild(host);

  const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

  const style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',
    '.panel { position: fixed; top: 16px; right: 16px; width: 320px; max-height: 80vh;',
    '  overflow: auto; background: #14121f; color: #f5f4ff; font-family: system-ui, sans-serif;',
    '  border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45); z-index: 2147483647;',
    '  border: 1px solid rgba(109,94,252,.4); }',
    '.hd { display:flex; align-items:center; gap:8px; padding:14px 16px; font-weight:700;',
    '  border-bottom:1px solid rgba(255,255,255,.08); }',
    '.dot { width:10px; height:10px; border-radius:50%; background:' + ACCENT + '; }',
    '.body { padding: 12px 16px; }',
    '.hint { font-size:12px; opacity:.7; margin:0 0 10px; }',
    '.item { border:1px solid rgba(255,255,255,.1); border-radius:10px; padding:10px; margin-bottom:10px; }',
    '.pin { display:inline-flex; width:22px; height:22px; border-radius:50%; background:' + ACCENT + ';',
    '  color:#fff; align-items:center; justify-content:center; font-size:12px; font-weight:700; }',
    '.tag { font-size:11px; opacity:.65; margin-left:8px; }',
    'textarea { width:100%; box-sizing:border-box; margin-top:8px; background:#0e0d17; color:#fff;',
    '  border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:8px; resize:vertical; min-height:48px; }',
    '.del { background:none; border:0; color:#ff8a8a; cursor:pointer; font-size:12px; margin-top:6px; }',
    '.submit { width:100%; margin-top:10px; background:' + ACCENT + '; color:#fff; border:0;',
    '  border-radius:10px; padding:10px; font-weight:700; cursor:pointer; }',
    '.submit:disabled { opacity:.5; cursor:not-allowed; }',
    '.msg { font-size:12px; margin-top:8px; min-height:14px; }',
  ].join('\n');
  root.appendChild(style);

  const ACCENT2 = '#8b7dff';
  let activeId = null;
  let markers = [];

  Array.prototype.slice.call(document.querySelectorAll('.pinpoint-marker')).forEach(function (n) {
    n.remove();
  });

  function placeBox(node, rect) {
    node.style.left = Math.round(rect.left + window.scrollX) + 'px';
    node.style.top = Math.round(rect.top + window.scrollY) + 'px';
    node.style.width = Math.max(Math.round(rect.width), 8) + 'px';
    node.style.height = Math.max(Math.round(rect.height), 16) + 'px';
  }

  const focusBox = document.createElement('div');
  focusBox.className = 'pinpoint-marker';
  focusBox.setAttribute('data-pinpoint-ui', '1');
  focusBox.style.cssText =
    'position:absolute;display:none;pointer-events:none;box-sizing:border-box;border-radius:6px;' +
    'border:2px solid ' + ACCENT + ';background:rgba(109,94,252,.12);' +
    'z-index:2147483644;transition:all 60ms ease-out;';
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
    drawPins();
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

      const draft = document.createElement('div');
      draft.className = 'pinpoint-marker';
      draft.setAttribute('data-pinpoint-ui', '1');
      draft.style.cssText =
        'position:absolute;pointer-events:none;box-sizing:border-box;border-radius:4px;' +
        'z-index:2147483645;border:2px solid ' + ACCENT2 + ';background:rgba(109,94,252,.2);';
      placeBox(draft, rect);
      document.body.appendChild(draft);
      markers.push(draft);

      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'pinpoint-marker';
      pin.setAttribute('data-pinpoint-ui', '1');
      pin.textContent = String(i + 1);
      pin.style.cssText =
        'position:absolute;transform:translate(-50%,-50%);width:20px;height:20px;padding:0;' +
        'border-radius:999px;background:' + (a.id === activeId ? ACCENT2 : ACCENT) + ';' +
        'color:#fff;border:2px solid #fff;display:flex;align-items:center;justify-content:center;' +
        'font:700 11px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);' +
        'cursor:pointer;z-index:2147483646;';
      pin.style.left = Math.round(rect.left + window.scrollX) + 'px';
      pin.style.top = Math.round(rect.top + window.scrollY) + 'px';
      pin.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        focusComment(a.id);
      });
      document.body.appendChild(pin);
      markers.push(pin);
    });
  }

  const panel = document.createElement('div');
  panel.className = 'panel';
  root.appendChild(panel);

  let message = '';

  controller.render = function () {
    const list = controller.annotations();
    panel.innerHTML = '';

    const hd = document.createElement('div');
    hd.className = 'hd';
    hd.innerHTML = '<span class="dot"></span> Pin Point review';
    panel.appendChild(hd);

    const body = document.createElement('div');
    body.className = 'body';
    panel.appendChild(body);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = list.length
      ? 'Click a comment to edit it. Submit when done.'
      : 'Click any element on the page to leave feedback.';
    body.appendChild(hint);

    list.forEach(function (a, i) {
      const item = document.createElement('div');
      item.className = 'item';
      item.setAttribute('data-item-id', a.id);
      item.addEventListener('mouseenter', function () {
        showFocus(controller.elementFor(a.id));
      });
      item.addEventListener('mouseleave', hideFocus);
      const head = document.createElement('div');
      head.innerHTML =
        '<span class="pin">' + (i + 1) + '</span><span class="tag">&lt;' + a.tag + '&gt;</span>';
      item.appendChild(head);
      const ta = document.createElement('textarea');
      ta.value = a.comment;
      ta.placeholder = 'What should change here?';
      ta.addEventListener('input', function () {
        controller.commentSilent(a.id, ta.value);
      });
      item.appendChild(ta);
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = 'Delete';
      del.addEventListener('click', function () {
        controller.remove(a.id);
      });
      item.appendChild(del);
      body.appendChild(item);
    });

    if (list.length) {
      const submit = document.createElement('button');
      submit.className = 'submit';
      submit.textContent = 'Submit feedback';
      submit.addEventListener('click', function () {
        submit.disabled = true;
        controller.submit().then(function (res) {
          submit.disabled = false;
          if (res.ok) {
            message = res.jobId
              ? 'Thanks! Your feedback was submitted — a fix pull request is being generated automatically.'
              : 'Thank you! Your feedback was submitted.';
          } else {
            message = res.error || 'Submission failed.';
          }
          controller.render();
        });
      });
      body.appendChild(submit);
    }

    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = message;
    body.appendChild(msg);

    drawPins();
  };

  controller.render();

  document.addEventListener(
    'click',
    function (e) {
      const target = e.target;
      if (!target || isPinpointUi(target) || !isSelectable(target)) return;
      e.preventDefault();
      e.stopPropagation();
      controller.select(target).then(function (id) {
        focusComment(id);
      });
    },
    true,
  );

  document.addEventListener(
    'mouseover',
    function (e) {
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
    activeId = null;
    hideFocus();
    drawPins();
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
