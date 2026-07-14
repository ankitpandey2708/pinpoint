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
      // Update state while typing WITHOUT re-rendering (a full render rebuilds
      // the panel and would blur the field after every keystroke).
      commentSilent: function (id, text) {
        var a = find(id);
        if (a) {
          a.comment = text;
          persist();
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
      setReviewerSilent: function (name) {
        reviewerName = name || '';
        persist();
      },
      getReviewer: function () {
        return reviewerName;
      },
      submit: function () {
        // Reviewer name is optional; default to Anonymous when left blank.
        var name = (reviewerName || '').trim() || 'Anonymous';
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
            if (!resp || !resp.ok) {
              // Surface the server's actual reason (routes reply with {error}).
              return resp.json().then(
                function (data) {
                  return {
                    ok: false,
                    error: (data && data.error) || 'The server rejected the submission.',
                  };
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

    // On-page selection UX adapted from toss (UI only, no backend threads): one
    // focus highlight follows the hovered element (or the active comment's
    // element), each selected element keeps a persistent draft highlight, and a
    // numbered pin anchors to it. Clicking a pin jumps to its comment in the
    // panel. Markers live on document.body with absolute, document-relative
    // coordinates so they stay anchored while scrolling; styling is fully inline
    // so nothing leaks into the reviewed page.
    var ACCENT2 = '#8b7dff';
    var activeId = null;
    var markers = [];

    // Clear stale markers from a prior init (tests re-init repeatedly).
    Array.prototype.slice.call(document.querySelectorAll('.pinpoint-marker')).forEach(function (n) {
      n.remove();
    });

    function elementFor(id) {
      try {
        return document.querySelector('[data-pinpoint-id="' + id + '"]');
      } catch (e) {
        return null;
      }
    }
    function placeBox(node, rect) {
      node.style.left = Math.round(rect.left + window.scrollX) + 'px';
      node.style.top = Math.round(rect.top + window.scrollY) + 'px';
      node.style.width = Math.max(Math.round(rect.width), 8) + 'px';
      node.style.height = Math.max(Math.round(rect.height), 16) + 'px';
    }

    var focusBox = document.createElement('div');
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
      if (activeId) return; // keep the active comment's element highlighted
      focusBox.style.display = 'none';
    }
    function focusComment(id) {
      activeId = id;
      showFocus(elementFor(id));
      drawPins();
      var item = root.querySelector('[data-item-id="' + id + '"]');
      if (item) {
        if (item.scrollIntoView) item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        var ta = item.querySelector('textarea');
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
      // Drop a stale active id (e.g. its comment was just deleted).
      if (activeId && !controller.annotations().some(function (a) { return a.elementId === activeId; })) {
        activeId = null;
        focusBox.style.display = 'none';
      }
      controller.annotations().forEach(function (a, i) {
        var target = elementFor(a.elementId);
        if (!target) return;
        var rect = target.getBoundingClientRect();

        var draft = document.createElement('div');
        draft.className = 'pinpoint-marker';
        draft.setAttribute('data-pinpoint-ui', '1');
        draft.style.cssText =
          'position:absolute;pointer-events:none;box-sizing:border-box;border-radius:4px;' +
          'z-index:2147483645;border:2px solid ' + ACCENT2 + ';background:rgba(109,94,252,.2);';
        placeBox(draft, rect);
        document.body.appendChild(draft);
        markers.push(draft);

        var pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'pinpoint-marker';
        pin.setAttribute('data-pinpoint-ui', '1');
        pin.textContent = String(i + 1);
        pin.style.cssText =
          'position:absolute;transform:translate(-50%,-50%);width:20px;height:20px;padding:0;' +
          'border-radius:999px;background:' + (a.elementId === activeId ? ACCENT2 : ACCENT) + ';' +
          'color:#fff;border:2px solid #fff;display:flex;align-items:center;justify-content:center;' +
          'font:700 11px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);' +
          'cursor:pointer;z-index:2147483646;';
        pin.style.left = Math.round(rect.left + window.scrollX) + 'px';
        pin.style.top = Math.round(rect.top + window.scrollY) + 'px';
        pin.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          focusComment(a.elementId);
        });
        document.body.appendChild(pin);
        markers.push(pin);
      });
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
        ? 'Click a comment to edit it. Submit when done.'
        : 'Click any element on the page to leave feedback.';
      body.appendChild(hint);

      list.forEach(function (a, i) {
        var item = document.createElement('div');
        item.className = 'item';
        item.setAttribute('data-item-id', a.elementId);
        item.addEventListener('mouseenter', function () {
          showFocus(elementFor(a.elementId));
        });
        item.addEventListener('mouseleave', hideFocus);
        var head = document.createElement('div');
        head.innerHTML =
          '<span class="pin">' + (i + 1) + '</span><span class="tag">&lt;' + a.tag + '&gt;</span>';
        item.appendChild(head);
        var ta = document.createElement('textarea');
        ta.value = a.comment;
        ta.placeholder = 'What should change here?';
        ta.addEventListener('input', function () {
          controller.commentSilent(a.elementId, ta.value);
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

      // Submit CTA only appears once at least one element has been clicked.
      if (list.length) {
        var submit = document.createElement('button');
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

      var msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = message;
      body.appendChild(msg);

      drawPins();
    };

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
        var id = el.getAttribute('data-pinpoint-id');
        controller.select(el);
        // Jump straight to the new (or existing) comment's composer, toss-style.
        focusComment(id);
      },
      true,
    );

    // Hover highlight tracking on the page.
    document.addEventListener(
      'mouseover',
      function (e) {
        var target = e.target;
        if (!target || isPinpointUi(target)) return;
        var el = target.closest ? target.closest('[data-pinpoint-id]') : null;
        if (el) showFocus(el);
        else hideFocus();
      },
      true,
    );
    document.addEventListener(
      'mouseout',
      function (e) {
        var to = e.relatedTarget;
        if (!to || !(to.closest && to.closest('[data-pinpoint-id]'))) hideFocus();
      },
      true,
    );
    // Clear the active comment on Escape (mirrors toss's dismiss).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      activeId = null;
      hideFocus();
      drawPins();
    });
    // Absolute markers stay anchored on scroll; only a resize changes element
    // geometry, so redraw pins and the active focus box then.
    window.addEventListener('resize', function () {
      drawPins();
      if (activeId) showFocus(elementFor(activeId));
      else hideFocus();
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
