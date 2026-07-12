/*
 * Pinpoint review overlay — framework-free browser script injected into
 * instrumented previews. It lets a client hover, select elements, comment,
 * keep a local draft, and submit. It never sees repository or credential data.
 * Exposes `window.Pinpoint.init(config)` returning a controller (used by tests
 * and auto-boot).
 */
(function () {
  'use strict';

  var STORAGE_PREFIX = 'pinpoint:draft:';
  var ACCENT = '#6d5efc';

  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'body' && depth < 6) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + '#' + node.id);
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var sameTag = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === node.tagName;
        });
        if (sameTag.length > 1) {
          var idx = sameTag.indexOf(node) + 1;
          tag += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(tag);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function isPinpointUi(el) {
    var node = el;
    while (node) {
      if (node.getAttribute && node.getAttribute('data-pinpoint-ui')) return true;
      node = node.parentNode || (node.host ? node.host : null);
    }
    return false;
  }

  function buildController(config) {
    var fetchImpl =
      config.fetch ||
      (typeof window !== 'undefined' && window.fetch ? window.fetch.bind(window) : null);
    var draftKey = STORAGE_PREFIX + config.projectId + ':' + config.reviewKey;
    var reviewerName = '';
    var annotations = [];

    try {
      var raw = localStorage.getItem(draftKey);
      if (raw) {
        var parsed = JSON.parse(raw);
        annotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
        reviewerName = typeof parsed.reviewerName === 'string' ? parsed.reviewerName : '';
      }
    } catch (e) {
      annotations = [];
    }

    function persist() {
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ reviewerName: reviewerName, annotations: annotations }),
        );
      } catch (e) {
        /* storage may be unavailable; drafts are best effort */
      }
    }

    function find(id) {
      for (var i = 0; i < annotations.length; i++) {
        if (annotations[i].elementId === id) return annotations[i];
      }
      return null;
    }

    function capture(el) {
      var parentText = el.parentElement ? el.parentElement.textContent || '' : '';
      return {
        elementId: el.getAttribute('data-pinpoint-id'),
        route: config.route || (typeof location !== 'undefined' ? location.pathname : '/'),
        selector: cssSelector(el),
        tag: el.tagName.toLowerCase(),
        classes: el.classList ? Array.prototype.slice.call(el.classList) : [],
        visibleText: (el.textContent || '').trim().slice(0, 200),
        nearbyText: parentText.trim().slice(0, 200),
        comment: '',
      };
    }

    var controller = {
      draftKey: draftKey,
      render: function () {},
      select: function (el) {
        if (!el || !el.getAttribute) return;
        var id = el.getAttribute('data-pinpoint-id');
        if (!id) return;
        if (!find(id)) {
          annotations.push(capture(el));
          persist();
          controller.render();
        }
      },
      comment: function (id, text) {
        var a = find(id);
        if (a) {
          a.comment = text;
          persist();
          controller.render();
        }
      },
      remove: function (id) {
        annotations = annotations.filter(function (a) {
          return a.elementId !== id;
        });
        persist();
        controller.render();
      },
      annotations: function () {
        return annotations.map(function (a) {
          return {
            elementId: a.elementId,
            route: a.route,
            selector: a.selector,
            tag: a.tag,
            classes: a.classes,
            visibleText: a.visibleText,
            nearbyText: a.nearbyText,
            comment: a.comment,
          };
        });
      },
      setReviewer: function (name) {
        reviewerName = name || '';
        persist();
        controller.render();
      },
      getReviewer: function () {
        return reviewerName;
      },
      submit: function () {
        var name = (reviewerName || '').trim();
        if (!name) return Promise.resolve({ ok: false, error: 'A reviewer name is required.' });
        var withComments = annotations.filter(function (a) {
          return (a.comment || '').trim().length > 0;
        });
        if (withComments.length === 0) {
          return Promise.resolve({ ok: false, error: 'Add at least one comment before submitting.' });
        }
        if (!fetchImpl) return Promise.resolve({ ok: false, error: 'fetch is unavailable' });
        return fetchImpl(config.apiBase + '/projects/' + config.projectId + '/reviews', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reviewerName: name, route: config.route, annotations: withComments }),
        })
          .then(function (resp) {
            if (!resp || !resp.ok) return { ok: false, error: 'The server rejected the submission.' };
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
                return { ok: true, id: data && data.id };
              },
              function () {
                annotations = [];
                reviewerName = '';
                try {
                  localStorage.removeItem(draftKey);
                } catch (e) {
                  /* ignore */
                }
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
    var existing = document.getElementById('pinpoint-root');
    if (existing) existing.remove();

    var host = document.createElement('div');
    host.id = 'pinpoint-root';
    host.setAttribute('data-pinpoint-ui', '1');
    document.body.appendChild(host);

    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    var style = document.createElement('style');
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
      'input { width:100%; box-sizing:border-box; background:#0e0d17; color:#fff;',
      '  border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:8px; }',
      '.del { background:none; border:0; color:#ff8a8a; cursor:pointer; font-size:12px; margin-top:6px; }',
      '.submit { width:100%; margin-top:10px; background:' + ACCENT + '; color:#fff; border:0;',
      '  border-radius:10px; padding:10px; font-weight:700; cursor:pointer; }',
      '.submit:disabled { opacity:.5; cursor:not-allowed; }',
      '.msg { font-size:12px; margin-top:8px; min-height:14px; }',
    ].join('\n');
    root.appendChild(style);

    // On-page highlight layer: a hover outline over the element under the cursor
    // and numbered pins over each selected element. Drawn inside the shadow root
    // (viewport-fixed) so it tracks scroll/resize without leaking page styles.
    var hlLayer = document.createElement('div');
    hlLayer.className = 'hl-layer';
    root.appendChild(hlLayer);
    var hover = document.createElement('div');
    hover.className = 'hl-hover';
    hlLayer.appendChild(hover);

    function elementFor(id) {
      try {
        return document.querySelector('[data-pinpoint-id="' + id + '"]');
      } catch (e) {
        return null;
      }
    }
    function drawPins() {
      Array.prototype.slice.call(hlLayer.querySelectorAll('.hl-pin')).forEach(function (p) {
        p.remove();
      });
      controller.annotations().forEach(function (a, i) {
        var target = elementFor(a.elementId);
        if (!target) return;
        var r = target.getBoundingClientRect();
        var pin = document.createElement('div');
        pin.className = 'hl-pin';
        pin.textContent = String(i + 1);
        pin.style.left = r.left + 'px';
        pin.style.top = r.top + 'px';
        hlLayer.appendChild(pin);
      });
    }
    function showHover(el) {
      var r = el.getBoundingClientRect();
      hover.style.display = 'block';
      hover.style.left = r.left + 'px';
      hover.style.top = r.top + 'px';
      hover.style.width = r.width + 'px';
      hover.style.height = r.height + 'px';
    }
    function hideHover() {
      hover.style.display = 'none';
    }

    var panel = document.createElement('div');
    panel.className = 'panel';
    root.appendChild(panel);

    var message = '';

    controller.render = function () {
      var list = controller.annotations();
      panel.innerHTML = '';

      var hd = document.createElement('div');
      hd.className = 'hd';
      hd.innerHTML = '<span class="dot"></span> Pin Point review';
      panel.appendChild(hd);

      var body = document.createElement('div');
      body.className = 'body';
      panel.appendChild(body);

      var hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = list.length
        ? 'Click a comment to edit it. Add your name and submit when done.'
        : 'Click any element on the page to leave feedback.';
      body.appendChild(hint);

      list.forEach(function (a, i) {
        var item = document.createElement('div');
        item.className = 'item';
        var head = document.createElement('div');
        head.innerHTML =
          '<span class="pin">' + (i + 1) + '</span><span class="tag">&lt;' + a.tag + '&gt;</span>';
        item.appendChild(head);
        var ta = document.createElement('textarea');
        ta.value = a.comment;
        ta.placeholder = 'What should change here?';
        ta.addEventListener('input', function () {
          controllerCommentSilent(a.elementId, ta.value);
        });
        item.appendChild(ta);
        var del = document.createElement('button');
        del.className = 'del';
        del.textContent = 'Delete';
        del.addEventListener('click', function () {
          controller.remove(a.elementId);
        });
        item.appendChild(del);
        body.appendChild(item);
      });

      var name = document.createElement('input');
      name.placeholder = 'Your name';
      name.value = controller.getReviewer();
      name.addEventListener('input', function () {
        controllerReviewerSilent(name.value);
      });
      body.appendChild(name);

      var submit = document.createElement('button');
      submit.className = 'submit';
      submit.textContent = 'Submit feedback';
      submit.addEventListener('click', function () {
        submit.disabled = true;
        controller.submit().then(function (res) {
          submit.disabled = false;
          message = res.ok ? 'Thank you! Your feedback was submitted.' : res.error || 'Submission failed.';
          controller.render();
        });
      });
      body.appendChild(submit);

      var msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = message;
      body.appendChild(msg);

      drawPins();
    };

    // Silent variants avoid a full re-render (which would blur the field) while typing.
    function controllerCommentSilent(id, text) {
      controller.comment(id, text);
    }
    function controllerReviewerSilent(name) {
      controller.setReviewer(name);
    }
    // Re-point render for the silent helpers after first render assignment.
    var realRender = controller.render;
    controller.comment = (function (orig) {
      return function (id, text) {
        orig.call(controller, id, text);
      };
    })(controller.comment);

    controller.render = realRender;
    controller.render();

    document.addEventListener(
      'click',
      function (e) {
        var target = e.target;
        if (!target || isPinpointUi(target)) return;
        var el = target.closest ? target.closest('[data-pinpoint-id]') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        controller.select(el);
      },
      true,
    );

    // Hover highlight tracking.
    document.addEventListener(
      'mouseover',
      function (e) {
        var target = e.target;
        if (!target || isPinpointUi(target)) return;
        var el = target.closest ? target.closest('[data-pinpoint-id]') : null;
        if (el) showHover(el);
        else hideHover();
      },
      true,
    );
    document.addEventListener(
      'mouseout',
      function (e) {
        var to = e.relatedTarget;
        if (!to || !(to.closest && to.closest('[data-pinpoint-id]'))) hideHover();
      },
      true,
    );
    // Keep pins/hover aligned as the page scrolls or resizes.
    window.addEventListener(
      'scroll',
      function () {
        hideHover();
        drawPins();
      },
      true,
    );
    window.addEventListener('resize', function () {
      hideHover();
      drawPins();
    });
  }

  var Pinpoint = {
    init: function (config) {
      var controller = buildController(config);
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
})();
