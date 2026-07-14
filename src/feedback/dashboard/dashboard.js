/*
 * Pin Point developer dashboard. Framework-free. Lists submitted reviews, shows
 * per-annotation source mappings and confidence, and lets the developer start a
 * fix job (Generate Fix PR) — the only place an agent can be triggered. The
 * developer token is injected by the server into window.__PINPOINT_DASH__ and
 * is sent on every developer API request.
 */
(function () {
  'use strict';

  var cfg = window.__PINPOINT_DASH__ || { apiBase: '/__pinpoint__/api', devToken: '' };
  var API = cfg.apiBase || '/__pinpoint__/api';
  var TERMINAL = { 'pr-opened': true, failed: true };

  var listEl = document.getElementById('review-list');
  var emptyEl = document.getElementById('reviews-empty');
  var detailEl = document.getElementById('detail');
  var refreshEl = document.getElementById('refresh');
  var selectedId = null;
  var pollTimer = null;

  // ---- Small view helpers ---------------------------------------------------
  var ICON = {
    file:
      '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    external:
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/></svg>',
  };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Humanize job status ("running-agent" -> "running agent") for display only;
  // the raw status is kept as a CSS class so styling/state logic is unchanged.
  function humanize(status) {
    return String(status || '').replace(/-/g, ' ');
  }

  function statusPill(status) {
    return el('span', 'status ' + status, humanize(status));
  }

  function timeAgo(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var s = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  function getJSON(url) {
    return fetch(url, {
      headers: { accept: 'application/json', 'x-pinpoint-token': cfg.devToken || '' },
    }).then(function (r) {
      if (!r.ok) throw new Error('request failed: ' + r.status);
      return r.json();
    });
  }

  function postJob(reviewId) {
    return fetch(API + '/reviews/' + encodeURIComponent(reviewId) + '/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pinpoint-token': cfg.devToken || '' },
      body: '{}',
    });
  }

  function sourceLabel(mapping) {
    if (mapping.sourceFile) {
      var loc = mapping.sourceFile;
      if (mapping.line) loc += ':' + mapping.line;
      return loc;
    }
    if (mapping.component) return mapping.component;
    return 'unresolved';
  }

  function renderList(reviews) {
    listEl.innerHTML = '';
    emptyEl.hidden = reviews.length > 0;
    reviews.forEach(function (r) {
      var card = el('li', 'review-card');
      if (r.id === selectedId) card.classList.add('active');
      card.title = new Date(r.createdAt).toLocaleString();

      card.appendChild(el('div', 'who', r.reviewerName));
      var meta = el('div', 'meta');
      meta.textContent =
        r.annotationCount + ' comment' + (r.annotationCount === 1 ? '' : 's') +
        ' · ' + r.resolvedCount + ' mapped · ' + timeAgo(r.createdAt);
      card.appendChild(meta);

      if (r.job) {
        var status = statusPill(r.job.status);
        status.style.marginTop = '9px';
        card.appendChild(status);
      }
      card.addEventListener('click', function () {
        selectReview(r.id);
      });
      listEl.appendChild(card);
    });
  }

  function renderDetail(data) {
    var review = data.review;
    detailEl.innerHTML = '';
    detailEl.appendChild(el('h3', null, 'Review from ' + review.reviewerName));

    // Repo context as discrete mono chips instead of one run-on line.
    var repo = el('div', 'repo');
    function chip(label, value) {
      var c = el('span', 'repo-chip');
      c.innerHTML = (label ? label + ' ' : '') + '<b></b>';
      c.querySelector('b').textContent = value;
      return c;
    }
    repo.appendChild(chip('', review.githubRepo || 'local repository'));
    repo.appendChild(chip('branch', review.baseBranch));
    repo.appendChild(chip('commit', review.baseCommit.slice(0, 8)));
    repo.appendChild(chip('route', review.route));
    detailEl.appendChild(repo);

    // Stat strip: comments / mapped / unmapped.
    var mapped = review.annotations.filter(function (a) {
      return a.mapping.confidence !== 'unresolved';
    }).length;
    var stats = el('div', 'stats');
    function stat(cls, n, k) {
      var s = el('div', 'stat' + (cls ? ' ' + cls : ''));
      s.appendChild(el('div', 'n', String(n)));
      s.appendChild(el('span', 'k', k));
      return s;
    }
    stats.appendChild(stat('', review.annotations.length, 'comments'));
    stats.appendChild(stat('mapped', mapped, 'mapped'));
    stats.appendChild(stat('unmapped', review.annotations.length - mapped, 'unmapped'));
    detailEl.appendChild(stats);

    review.annotations.forEach(function (a) {
      var box = el('div', 'annotation');
      var head = el('div', 'head');
      head.appendChild(el('span', 'pin', String(a.index)));
      head.appendChild(el('span', 'tagchip', '<' + a.tag + '>'));
      head.appendChild(el('span', 'badge ' + a.mapping.confidence, a.mapping.confidence));
      box.appendChild(head);
      box.appendChild(el('div', 'comment', a.comment));

      var src = el('span', 'source-chip');
      src.innerHTML = ICON.file;
      src.appendChild(document.createTextNode(' ' + sourceLabel(a.mapping)));
      box.appendChild(src);
      detailEl.appendChild(box);
    });

    var actions = el('div', 'actions');
    var btn = el('button', 'primary', 'Generate Fix PR');
    var job = data.job;
    var canStart = review.annotations.some(function (a) {
      return a.mapping.confidence !== 'unresolved';
    });
    var jobActive = job && !TERMINAL[job.status];
    var jobDone = job && job.status === 'pr-opened';
    var jobFailed = job && job.status === 'failed';
    btn.disabled = !canStart || jobActive || jobDone;
    // Jobs start automatically on submission; this button is the retry path when
    // a run failed, and a manual fallback when nothing auto-started.
    if (!canStart) btn.textContent = 'No source mapped';
    else if (jobFailed) btn.textContent = 'Retry Fix PR';
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Starting…';
      postJob(review.id).then(function (r) {
        if (!r.ok) {
          return r.json().then(function (e) {
            btn.textContent = 'Generate Fix PR';
            btn.disabled = false;
            alert(e.error || 'Failed to start job');
          });
        }
        return r.json().then(function (j) {
          pollJob(j.id);
        });
      });
    });
    actions.appendChild(btn);
    detailEl.appendChild(actions);

    if (job) renderJob(job);
    else if (jobActive) startPolling(job.id);
  }

  function renderJob(job) {
    var old = document.querySelector('.job-panel');
    if (old) old.remove();
    var panel = el('div', 'job-panel');
    var h = el('h4');
    h.appendChild(document.createTextNode('Fix job'));
    h.appendChild(statusPill(job.status));
    panel.appendChild(h);

    if (job.changedFiles && job.changedFiles.length) {
      panel.appendChild(el('div', 'section-label', 'Files changed'));
      var files = el('ul', 'files');
      job.changedFiles.forEach(function (f) {
        files.appendChild(el('li', null, f));
      });
      panel.appendChild(files);
    }

    if (job.verification) {
      panel.appendChild(el('div', 'section-label', 'Verification'));
      var checks = el('ul', 'checks');
      job.verification.checks.forEach(function (c) {
        var cls = c.skipped ? 'skip' : c.ok ? 'ok' : 'bad';
        checks.appendChild(el('li', cls, c.name + ' — ' + c.command.join(' ')));
      });
      panel.appendChild(checks);
    }

    if (job.status === 'pr-opened' && job.prUrl) {
      var link = el('a', 'pr-link');
      link.href = job.prUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.innerHTML = ICON.external;
      link.appendChild(document.createTextNode(' View draft pull request'));
      panel.appendChild(link);
    }

    if (job.status === 'failed' && job.failureReason) {
      panel.appendChild(el('div', 'fail-reason', 'Failed: ' + job.failureReason));
    }

    // Sanitized agent log, lazy-loaded on demand. Available once the agent has
    // produced a log file (any stage from running-agent onward).
    if (job.logPath) {
      var logBtn = el('button', 'ghost', 'Show agent log');
      var logPre = el('pre', 'log');
      logPre.hidden = true;
      logBtn.style.marginTop = '14px';
      logBtn.addEventListener('click', function () {
        if (!logPre.hidden) {
          logPre.hidden = true;
          logBtn.textContent = 'Show agent log';
          return;
        }
        logBtn.disabled = true;
        getJSON(API + '/jobs/' + encodeURIComponent(job.id) + '/log')
          .then(function (d) {
            logPre.textContent = d.log && d.log.length ? d.log : '(no log output)';
            logPre.hidden = false;
            logBtn.textContent = 'Hide agent log';
          })
          .catch(function () {
            logPre.textContent = 'Could not load the log.';
            logPre.hidden = false;
          })
          .then(function () {
            logBtn.disabled = false;
          });
      });
      panel.appendChild(logBtn);
      panel.appendChild(logPre);
    }

    detailEl.appendChild(panel);
  }

  function pollJob(jobId) {
    getJSON(API + '/jobs/' + encodeURIComponent(jobId))
      .then(function (job) {
        renderJob(job);
        if (!TERMINAL[job.status]) {
          pollTimer = setTimeout(function () {
            pollJob(jobId);
          }, 1500);
        } else {
          if (selectedId) selectReview(selectedId, true);
          loadReviews();
        }
      })
      .catch(function () {
        /* transient; stop polling */
      });
  }

  function startPolling(jobId) {
    if (pollTimer) clearTimeout(pollTimer);
    pollJob(jobId);
  }

  function selectReview(id, silent) {
    selectedId = id;
    if (pollTimer) clearTimeout(pollTimer);
    if (!silent) {
      Array.prototype.forEach.call(listEl.children, function (c) {
        c.classList.remove('active');
      });
    }
    getJSON(API + '/reviews/' + encodeURIComponent(id)).then(function (data) {
      renderDetail(data);
      if (data.job && !TERMINAL[data.job.status]) startPolling(data.job.id);
    });
  }

  function loadReviews() {
    getJSON(API + '/reviews').then(renderList).catch(function () {
      emptyEl.hidden = false;
      emptyEl.textContent = 'Could not load reviews.';
    });
  }

  refreshEl.addEventListener('click', loadReviews);
  loadReviews();
})();
