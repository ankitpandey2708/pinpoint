/*
 * Pin Point developer dashboard. Framework-free. Lists submitted reviews, shows
 * per-annotation source mappings and confidence, and lets the developer start a
 * fix job (Generate Fix PR) — the only place an agent can be triggered. The
 * developer token is injected by the server into window.__PINPOINT_DASH__ and
 * is sent only on mutation requests.
 */
(function () {
  'use strict';

  var cfg = window.__PINPOINT_DASH__ || { apiBase: '/api', devToken: '' };
  var API = cfg.apiBase || '/api';
  var TERMINAL = { 'pr-opened': true, failed: true };

  var listEl = document.getElementById('review-list');
  var emptyEl = document.getElementById('reviews-empty');
  var detailEl = document.getElementById('detail');
  var refreshEl = document.getElementById('refresh');
  var selectedId = null;
  var pollTimer = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function getJSON(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
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
      card.appendChild(el('div', 'who', r.reviewerName));
      var meta = el('div', 'meta');
      meta.textContent =
        r.annotationCount + ' comment' + (r.annotationCount === 1 ? '' : 's') +
        ' · ' + r.resolvedCount + ' mapped · ' + new Date(r.createdAt).toLocaleString();
      card.appendChild(meta);
      if (r.job) {
        var status = el('span', 'status ' + r.job.status, r.job.status);
        status.style.marginTop = '8px';
        status.style.display = 'inline-block';
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
    var repo = el('div', 'repo');
    repo.textContent =
      (review.githubRepo || 'local repository') + ' · ' + review.baseBranch + ' @ ' +
      review.baseCommit.slice(0, 8) + ' · route ' + review.route;
    detailEl.appendChild(repo);

    review.annotations.forEach(function (a) {
      var box = el('div', 'annotation');
      var head = el('div', 'head');
      head.appendChild(el('span', 'pin', String(a.index)));
      head.appendChild(el('span', 'tagchip', '<' + a.tag + '>'));
      head.appendChild(el('span', 'badge ' + a.mapping.confidence, a.mapping.confidence));
      box.appendChild(head);
      box.appendChild(el('div', 'comment', a.comment));
      box.appendChild(el('span', 'source-chip', sourceLabel(a.mapping)));
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
    btn.disabled = !canStart || jobActive || jobDone;
    if (!canStart) btn.textContent = 'No source mapped';
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
    h.appendChild(document.createTextNode('Job '));
    h.appendChild(el('span', 'status ' + job.status, job.status));
    panel.appendChild(h);

    if (job.changedFiles && job.changedFiles.length) {
      panel.appendChild(el('div', null, 'Files changed:'));
      var files = el('ul', 'files');
      job.changedFiles.forEach(function (f) {
        files.appendChild(el('li', null, f));
      });
      panel.appendChild(files);
    }

    if (job.verification) {
      var checks = el('ul', 'checks');
      job.verification.checks.forEach(function (c) {
        var cls = c.skipped ? 'skip' : c.ok ? 'ok' : 'bad';
        checks.appendChild(el('li', cls, c.name + ' — ' + c.command.join(' ')));
      });
      panel.appendChild(checks);
    }

    if (job.status === 'pr-opened' && job.prUrl) {
      var link = el('a', 'pr-link', 'View draft pull request →');
      link.href = job.prUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      panel.appendChild(el('div', null, ''));
      panel.appendChild(link);
    }

    if (job.status === 'failed' && job.failureReason) {
      panel.appendChild(el('div', 'fail-reason', 'Failed: ' + job.failureReason));
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
