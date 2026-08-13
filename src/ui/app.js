/* StayLeased client enhancements — no framework, progressive enhancement only. */
(function () {
  'use strict';

  // toggles (menus, sidebar) — menus are EXCLUSIVE: opening one closes the rest
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (t) {
      var el = document.querySelector(t.getAttribute('data-toggle'));
      if (el) {
        // a menu the pointer just hover-opened stays open on its first click
        // (the click "confirms" it); the next click toggles it closed as usual
        if (el.classList.contains('open') && el.dataset.hoverOpened) {
          delete el.dataset.hoverOpened;
          e.stopPropagation();
          return;
        }
        var opening = !el.classList.contains('open');
        document.querySelectorAll('.menu.open').forEach(function (m) {
          if (m !== el) m.classList.remove('open');
        });
        el.classList.toggle('open', opening);
        delete el.dataset.hoverOpened;
      }
      e.stopPropagation();
      return;
    }
    // close menus on outside click
    document.querySelectorAll('.menu.open').forEach(function (m) {
      if (!m.contains(e.target)) m.classList.remove('open');
    });
    var sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('open') && !sb.contains(e.target) && !e.target.closest('.menu-btn')) {
      sb.classList.remove('open');
    }
  });

  // hover-open module-bar dropdowns (desktop, pointer devices only): headers
  // expand on hover with the same exclusivity as clicks; a short close delay
  // forgives diagonal travel into the open menu. Click/keyboard still work —
  // hover is an enhancement, not the mechanism.
  if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var hoverCloseTimer = null;
    document.querySelectorAll('.modulebar .mtab').forEach(function (tab) {
      var btn = tab.querySelector('[data-toggle]');
      var menu = btn && document.querySelector(btn.getAttribute('data-toggle'));
      if (!menu) return;
      tab.addEventListener('mouseenter', function () {
        if (hoverCloseTimer) { clearTimeout(hoverCloseTimer); hoverCloseTimer = null; }
        if (!menu.classList.contains('open')) {
          document.querySelectorAll('.menu.open').forEach(function (m) {
            if (m !== menu) m.classList.remove('open');
          });
          menu.dataset.hoverOpened = '1';
          menu.classList.add('open');
        }
      });
      tab.addEventListener('mouseleave', function () {
        if (hoverCloseTimer) clearTimeout(hoverCloseTimer);
        hoverCloseTimer = setTimeout(function () {
          menu.classList.remove('open');
          delete menu.dataset.hoverOpened;
        }, 160);
      });
    });
  }

  // chart hover tooltips: any SVG element with data-tip gets a cursor-following
  // value bubble (charts also keep native <title> for accessibility)
  var tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.id = 'charttip';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function moveTip(e) {
    var t = tip();
    var pad = 14;
    var x = e.clientX + pad, y = e.clientY - 34;
    var r = t.getBoundingClientRect();
    if (x + r.width + 8 > window.innerWidth) x = e.clientX - r.width - pad;
    if (y < 4) y = e.clientY + 18;
    t.style.left = x + 'px';
    t.style.top = y + 'px';
  }
  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return;
    var t = tip();
    t.textContent = el.getAttribute('data-tip');
    t.classList.add('show');
    moveTip(e);
  });
  document.addEventListener('mousemove', function (e) {
    if (tipEl && tipEl.classList.contains('show') && e.target.closest && e.target.closest('[data-tip]')) moveTip(e);
  });
  document.addEventListener('mouseout', function (e) {
    if (tipEl && e.target.closest && e.target.closest('[data-tip]') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-tip]'))) {
      tipEl.classList.remove('show');
    }
  });

  // row links
  document.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-href]');
    if (tr && !e.target.closest('a, button, input, select, form')) {
      window.location.href = tr.getAttribute('data-href');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('tr[data-href]')) {
      window.location.href = e.target.getAttribute('data-href');
    }
  });

  // auto-submit forms (property switcher, filters)
  document.addEventListener('change', function (e) {
    var f = e.target.closest('form[data-autosubmit]');
    if (f) f.submit();
  });

  // confirm-before-submit
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.hasAttribute('data-confirm') && !window.confirm(f.getAttribute('data-confirm'))) {
      e.preventDefault();
    }
  });

  // login persona chips
  document.querySelectorAll('.chip[data-email]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var form = document.querySelector('form[action="/login"]');
      if (!form) return;
      form.querySelector('[name=email]').value = chip.getAttribute('data-email');
      form.querySelector('[name=password]').value = chip.getAttribute('data-password') || 'demo1234';
      form.submit();
    });
  });

  // ---------- light / dark theme toggle ----------
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-theme-toggle]');
    if (!b) return;
    var el = document.documentElement;
    var next = el.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    el.setAttribute('data-theme', next);
    document.cookie = 'sl_theme=' + next + ';path=/;max-age=31536000;SameSite=Lax';
    document.dispatchEvent(new CustomEvent('sl-theme', { detail: next }));
  });

  // ---------- command palette ----------
  var palette = document.getElementById('palette');
  var pInput = document.getElementById('palette-input');
  var pResults = document.getElementById('palette-results');
  var sel = -1;

  function openPalette() {
    if (!palette) return;
    palette.classList.add('open');
    pInput.value = '';
    pResults.innerHTML = '<div class="hintbar">Type at least 2 characters</div>';
    sel = -1;
    setTimeout(function () { pInput.focus(); }, 10);
  }
  function closePalette() {
    if (palette) palette.classList.remove('open');
  }
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'Escape') closePalette();
  });
  document.querySelectorAll('[data-palette-open]').forEach(function (b) {
    b.addEventListener('click', openPalette);
  });
  if (palette) {
    palette.addEventListener('click', function (e) {
      if (e.target === palette) closePalette();
    });
  }
  var debounce;
  if (pInput) {
    pInput.addEventListener('input', function () {
      clearTimeout(debounce);
      var q = pInput.value.trim();
      if (q.length < 2) {
        pResults.innerHTML = '<div class="hintbar">Type at least 2 characters</div>';
        return;
      }
      debounce = setTimeout(function () {
        // A result label is operator-entered text (a resident's name, a work
        // order summary). It is going into innerHTML, so escape it here.
        function esc(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }
        fetch('/search.json?q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (!data.results || !data.results.length) {
              sel = -1;
              pResults.innerHTML = '<div class="hintbar">No matches for “' + esc(q) + '”</div>';
              return;
            }
            pResults.innerHTML = data.results
              .map(function (r) {
                return '<a href="' + esc(r.href) + '"><span class="kind">' + esc(r.kind) + '</span><span><b>' + esc(r.label) + '</b>' + (r.sub ? ' <span class="muted">· ' + esc(r.sub) + '</span>' : '') + '</span></a>';
              })
              .join('');
            // The top hit is selected as soon as results land, so Enter goes
            // somewhere. Typing a resident's name and pressing Enter used to
            // do nothing at all unless you first pressed the down arrow —
            // which reads as a search box that does not work.
            sel = 0;
            var first = pResults.querySelector('a');
            if (first) first.classList.add('sel');
          });
      }, 160);
    });
    pInput.addEventListener('keydown', function (e) {
      var links = pResults.querySelectorAll('a');
      if (e.key === 'Enter') {
        // Results may still be in flight when Enter is pressed — go as soon as
        // they arrive rather than swallowing the keystroke.
        if (links.length) { e.preventDefault(); window.location.href = links[sel >= 0 ? sel : 0].href; return; }
        e.preventDefault();
        var pending = pInput.value.trim();
        if (pending.length < 2) return;
        setTimeout(function () {
          var later = pResults.querySelectorAll('a');
          if (later.length) window.location.href = later[0].href;
        }, 320);
        return;
      }
      if (!links.length) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, links.length - 1); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); }
      else return;
      e.preventDefault();
      links.forEach(function (l, i) { l.classList.toggle('sel', i === sel); });
      if (links[sel]) links[sel].scrollIntoView({ block: 'nearest' });
    });
  }

  // ---------- signature pad (e-sign) ----------
  document.querySelectorAll('canvas.sigpad').forEach(function (canvas) {
    var ctx = canvas.getContext('2d');
    var drawing = false;
    var drew = false;
    function resize() {
      var r = canvas.getBoundingClientRect();
      var data = canvas.toDataURL();
      canvas.width = r.width * 2;
      canvas.height = r.height * 2;
      ctx.scale(2, 2);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#1b2331';
      if (drew) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, r.width, r.height); };
        img.src = data;
      }
    }
    resize();
    function pos(e) {
      var r = canvas.getBoundingClientRect();
      var p = e.touches ? e.touches[0] : e;
      return [p.clientX - r.left, p.clientY - r.top];
    }
    function start(e) { drawing = true; drew = true; var p = pos(e); ctx.beginPath(); ctx.moveTo(p[0], p[1]); e.preventDefault(); }
    function move(e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); e.preventDefault(); }
    function end() { drawing = false; var f = document.querySelector(canvas.getAttribute('data-target')); if (f) f.value = drew ? canvas.toDataURL('image/png') : ''; }
    canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move); window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start); canvas.addEventListener('touchmove', move); canvas.addEventListener('touchend', end);
    var clear = document.querySelector('[data-sig-clear="' + canvas.id + '"]');
    if (clear) clear.addEventListener('click', function () { ctx.clearRect(0, 0, canvas.width, canvas.height); drew = false; end(); });
  });

  // ---------- dashboard motion: value count-up + occupancy ring draw ----------
  // Runs only where a .dash-hero exists; respects prefers-reduced-motion.
  (function () {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !document.querySelector('.dash-hero')) return;

    function countUp(el, dur) {
      var txt = (el.textContent || '').trim();
      var m = /^([^0-9]*)([\d.,]+)(.*)$/.exec(txt);
      if (!m) return;
      var prefix = m[1], num = m[2].replace(/,/g, ''), suffix = m[3];
      var target = parseFloat(num);
      if (isNaN(target)) return;
      var dec = (num.split('.')[1] || '').length;
      var grouped = m[2].indexOf(',') !== -1;
      var t0 = null;
      function fmt(v) {
        var s = dec ? v.toFixed(dec) : String(Math.round(v));
        if (grouped || (!dec && v >= 10000)) s = Number(s).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
        return prefix + s + suffix;
      }
      function step(ts) {
        if (t0 === null) t0 = ts;
        var p = Math.min(1, (ts - t0) / dur);
        var e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(target * e);
        if (p < 1) requestAnimationFrame(step); else el.textContent = txt;
      }
      requestAnimationFrame(step);
    }
    // Data tiles do NOT count up. A KPI that animates is a KPI that displays
    // numbers which are not true — occupancy reading 10.8% then 26.6% then
    // 81.6%, delinquency $237.98 then $587.04 then $1,798.00 — while the
    // Property Comparison table on the same screen shows the real figure
    // immediately, so the page contradicts itself while it settles. The motion
    // doctrine already asks for one-shot entrances then stillness; on a number
    // the honest entrance is simply being correct. countUp is kept for the ring
    // label, whose value is drawn alongside its arc rather than read.
    document.querySelectorAll('.dash-ring .dr-val > div').forEach(function (el) {
      var node = el.childNodes[0];
      if (node && node.nodeType === 3) {
        var span = document.createElement('span');
        span.textContent = node.textContent;
        el.replaceChild(span, node);
        countUp(span, 420);
      }
    });

    // ring: redraw from zero to its target arc
    document.querySelectorAll('.dash-ring svg circle[stroke-dasharray]').forEach(function (c) {
      var target = c.getAttribute('stroke-dasharray') || '';
      var parts = target.split(' ');
      if (parts.length !== 2) return;
      var arc = parseFloat(parts[0]), circ = parseFloat(parts[1]);
      if (isNaN(arc) || isNaN(circ) || arc === circ) return; // skip the track circle
      c.setAttribute('stroke-dasharray', '0 ' + circ);
      c.style.transition = 'stroke-dasharray 1.1s cubic-bezier(.16,1,.3,1)';
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { c.setAttribute('stroke-dasharray', arc + ' ' + circ); });
      });
    });
  })();

  // ---------- scroll-reveal for below-the-fold content ----------
  // Top-level content blocks that start below the fold fade-and-rise into
  // place as they scroll into view. Applied only where motion is welcome.
  (function () {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) return;
    var content = document.querySelector('.content');
    if (!content) return;
    var els = [].slice.call(content.children).filter(function (el) {
      var t = el.className || '';
      if (typeof t !== 'string') return false;
      if (!/(^| )(card|kpi-band|grid|dash-duo|chart-pair)( |$)/.test(t)) return false;
      return el.getBoundingClientRect().top > window.innerHeight * 0.95;
    });
    if (!els.length) return;
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { threshold: 0.06, rootMargin: '0px 0px -5% 0px' });
    els.forEach(function (el) { el.classList.add('scrollrev'); io.observe(el); });
  })();

  // ---------- Ask StayLeased — the everywhere panel ----------
  // The brandbar button opens a slide-over on ANY page instead of navigating.
  // Content is tailored server-side (/ask/panel.json): greeting grounded in
  // the current property's live figures + suggested questions for this page.
  //
  // The panel is a companion, not a modal. There is no scrim and no blur: the
  // page behind it stays readable and clickable, because the questions people
  // ask are about what is on the screen and checking the screen should not
  // require dismissing the answer. Pinning docks it beside the content and
  // carries it — with the conversation — across navigations.
  (function () {
    var dock = null, thread = null, chipsEl = null, form = null, inp = null, sendBtn = null, pinBtn = null;
    var history = [], busy = false, loaded = false, pinned = false;
    var PIN_KEY = 'sl_ask_pinned', HIST_KEY = 'sl_ask_history';
    var PIN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.8V4h6v6.8l2.5 3.2H6.5z"/></svg>';

    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text) n.textContent = text;
      return n;
    }
    function scrollDown() { if (thread) thread.scrollTop = thread.scrollHeight; }
    function bubble(role) {
      var m = el('div', 'aichat-msg ' + role);
      var b = el('div', 'aichat-bubble');
      m.appendChild(b);
      thread.appendChild(m);
      scrollDown();
      return b;
    }
    function setBusy(on) {
      busy = on;
      dock.classList.toggle('busy', on);
      if (sendBtn) sendBtn.disabled = on;
    }

    function build() {
      dock = el('div', 'askdock');
      // Not a modal: the panel is a companion to the page, not a gate in front
      // of it. role=complementary, so assistive tech does not announce it as a
      // dialog that has trapped the user.
      dock.setAttribute('role', 'complementary');
      dock.setAttribute('aria-label', 'Ask StayLeased');
      var panel = el('aside', 'askdock-panel');
      var head = el('div', 'askdock-head');
      var orb = el('span', 'aichat-orb');
      orb.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9z"/></svg>';
      var ttl = el('div', 'askdock-title');
      ttl.appendChild(el('b', null, 'Ask StayLeased'));
      var scope = el('span', 'askdock-scope', 'Portfolio');
      ttl.appendChild(scope);
      var full = el('a', 'askdock-full', 'Full page');
      full.href = '/ask';
      // Pinning docks the panel beside the page instead of over it, and keeps
      // it open across navigations — so you can walk the app with the answer
      // still on screen and keep asking about what you are looking at.
      pinBtn = el('button', 'askdock-pin');
      pinBtn.type = 'button';
      pinBtn.innerHTML = PIN_SVG;
      pinBtn.addEventListener('click', function () { setPinned(!pinned); });
      var x = el('button', 'askdock-close');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.innerHTML = '&times;';
      x.addEventListener('click', close);
      head.appendChild(orb); head.appendChild(ttl); head.appendChild(full); head.appendChild(pinBtn); head.appendChild(x);
      thread = el('div', 'aichat-thread');
      thread.setAttribute('aria-live', 'polite');
      chipsEl = el('div', 'aichat-chips');
      form = el('form', 'aichat-form');
      inp = el('input');
      inp.placeholder = 'Ask about where you are…';
      inp.maxLength = 300;
      inp.setAttribute('aria-label', 'Ask StayLeased');
      sendBtn = el('button', 'aichat-send');
      sendBtn.type = 'submit';
      sendBtn.setAttribute('aria-label', 'Send');
      sendBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
      form.appendChild(inp); form.appendChild(sendBtn);
      panel.appendChild(head); panel.appendChild(thread); panel.appendChild(chipsEl); panel.appendChild(form);
      dock.appendChild(panel);
      document.body.appendChild(dock);

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = (inp.value || '').trim();
        if (q) ask(q);
        inp.value = '';
      });
      chipsEl.addEventListener('click', function (e) {
        var c = e.target.closest('.aichat-chip');
        if (c && !busy) ask(c.textContent);
      });
      document.addEventListener('keydown', function (e) {
        // Escape closes a floating panel. A pinned one is part of the layout,
        // and yanking it away on a stray Escape would be a surprise.
        if (e.key === 'Escape' && !pinned && dock.classList.contains('open')) close();
      });
      // With no scrim to catch it, clicking away is what dismisses the panel —
      // but only while it is floating, and never on the button that opened it.
      document.addEventListener('mousedown', function (e) {
        if (pinned || !dock.classList.contains('open')) return;
        if (dock.contains(e.target) || (e.target.closest && e.target.closest('[data-ask-open]'))) return;
        close();
      });
    }

    function setPinned(on) {
      pinned = !!on;
      if (dock) dock.classList.toggle('pinned', pinned);
      document.body.classList.toggle('ask-pinned', pinned && dock && dock.classList.contains('open'));
      if (pinBtn) {
        pinBtn.classList.toggle('on', pinned);
        pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        pinBtn.title = pinned ? 'Unpin — let the panel float over the page' : 'Pin open — dock beside the page and keep it open as you navigate';
        pinBtn.setAttribute('aria-label', pinBtn.title);
      }
      try { sessionStorage.setItem(PIN_KEY, pinned ? '1' : '0'); } catch (err) { /* private mode */ }
    }

    /** The conversation follows the pin across page loads. Without this,
     * "keep it open while I visit other pages" would hand you an open panel
     * that had forgotten everything you just asked it. */
    function saveHistory() {
      if (!pinned) return;
      try { sessionStorage.setItem(HIST_KEY, JSON.stringify(history.slice(-12))); } catch (err) { /* quota */ }
    }
    function restoreHistory() {
      var saved = [];
      try { saved = JSON.parse(sessionStorage.getItem(HIST_KEY) || '[]'); } catch (err) { saved = []; }
      if (!saved.length || !Array.isArray(saved)) return false;
      saved.forEach(function (m) {
        history.push(m);
        bubble(m.role === 'you' ? 'you' : 'agent').textContent = m.text || '';
      });
      return true;
    }

    function hydrate() {
      if (loaded) return;
      loaded = true;
      var resumed = restoreHistory();
      // The scope line and the suggested questions are about the page you are
      // on NOW, so they refresh on every navigation even when the panel and
      // its conversation carried over.
      fetch('/ask/panel.json?path=' + encodeURIComponent(location.pathname), { headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          dock.querySelector('.askdock-scope').textContent = d.scope ? 'Scoped to ' + d.scope : 'Portfolio-wide';
          if (!resumed) bubble('agent').textContent = d.greeting || 'Ask me about your portfolio.';
          chipsEl.innerHTML = '';
          (d.chips || []).forEach(function (c) {
            var b = el('button', 'aichat-chip', c);
            b.type = 'button';
            chipsEl.appendChild(b);
          });
        })
        .catch(function () { if (!resumed) bubble('agent').textContent = 'Ask me about your portfolio.'; });
    }

    function ask(q) {
      if (busy) return;
      bubble('you').textContent = q;
      history.push({ role: 'you', text: q });
      setBusy(true);
      var wait = bubble('agent');
      wait.innerHTML = '<span class="aichat-typing"><i></i><i></i><i></i></span>';
      fetch('/ask.json', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': location.origin },
        body: 'q=' + encodeURIComponent(q) + '&history=' + encodeURIComponent(JSON.stringify(history.slice(-8))),
      }).then(function (r) { return r.json(); }).then(function (d) {
        wait.innerHTML = '';
        if (d.title) {
          var t = el('div', 'aichat-title', d.title);
          wait.appendChild(t);
        }
        var sum = el('div', 'aichat-summary', d.summary || 'Nothing came back — try again.');
        wait.appendChild(sum);
        if (d.extraHtml) {
          var ex = el('div', 'aichat-extra vis');
          ex.innerHTML = d.extraHtml;
          wait.appendChild(ex);
        }
        history.push({ role: 'agent', text: d.summary || '' });
        saveHistory();
        setBusy(false);
        scrollDown();
      }).catch(function () {
        wait.textContent = 'Something went wrong — try again.';
        setBusy(false);
      });
      saveHistory();
    }

    function open(opts) {
      if (!dock) build();
      dock.classList.add('open');
      setPinned(pinned);
      hydrate();
      if (!(opts && opts.quiet)) setTimeout(function () { if (inp) inp.focus(); }, 180);
    }
    function close() {
      if (!dock) return;
      dock.classList.remove('open');
      document.body.classList.remove('ask-pinned');
      // Closing is a decision to stop; it should not come back on the next
      // page. Unpinning here is what makes the close button mean "close".
      if (pinned) setPinned(false);
      try { sessionStorage.removeItem(HIST_KEY); } catch (err) { /* private mode */ }
    }

    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ask-open]');
      if (!b) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey) return; // let new-tab clicks through
      if (location.pathname === '/ask') return; // already on the full page
      e.preventDefault();
      if (dock && dock.classList.contains('open') && !pinned) { close(); return; }
      open();
    });

    // A pinned panel reopens itself on the next page, without stealing focus —
    // the operator navigated to read the page, not to type in the panel.
    try {
      if (sessionStorage.getItem(PIN_KEY) === '1' && document.querySelector('[data-ask-open]')) {
        pinned = true;
        open({ quiet: true });
      }
    } catch (err) { /* private mode: pinning simply does not persist */ }
  })();

  // drag & drop lanes (dispatch board / unit board / turns)
  document.querySelectorAll('[data-dnd-lane]').forEach(function (lane) {
    lane.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      lane.classList.add('dnd-over');
    });
    // dragleave fires when the pointer crosses into a CHILD element too, so
    // the lane un-highlights mid-drag unless the child is checked for.
    lane.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget || !lane.contains(e.relatedTarget)) lane.classList.remove('dnd-over');
    });
    lane.addEventListener('drop', function (e) {
      e.preventDefault();
      lane.classList.remove('dnd-over');
      var id = e.dataTransfer.getData('text/plain');
      var form = document.getElementById('dnd-form');
      if (form && id) {
        form.querySelector('[name=item_id]').value = id;
        form.querySelector('[name=lane]').value = lane.getAttribute('data-dnd-lane');
        form.submit();
      }
    });
  });
  document.querySelectorAll('[data-dnd-item]').forEach(function (item) {
    item.setAttribute('draggable', 'true');
    item.addEventListener('dragstart', function (e) {
      e.dataTransfer.setData('text/plain', item.getAttribute('data-dnd-item'));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dnd-dragging');
      // marks the whole board as "a card is in flight" so lanes that cannot
      // accept it can recede while the drag is happening, and only then
      document.body.classList.add('dnd-active');
    });
    item.addEventListener('dragend', function () {
      item.classList.remove('dnd-dragging');
      document.body.classList.remove('dnd-active');
      document.querySelectorAll('.dnd-over').forEach(function (l) { l.classList.remove('dnd-over'); });
    });
  });

  // select-all-on-focus for read-only address fields
  // (CSP-safe replacement for inline onfocus="this.select()")
  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (el && el.classList && el.classList.contains('selectall') && typeof el.select === 'function') {
      el.select();
    }
  });
})();

// ---------- file dropzones: drag-drop + chosen-file feedback ----------
(function () {
  'use strict';
  document.querySelectorAll('[data-dropzone]').forEach(function (zone) {
    var input = zone.querySelector('input[type=file]');
    var nameEl = zone.querySelector('[data-dz-name]');
    if (!input) return;
    function show() {
      var n = input.files ? input.files.length : 0;
      if (nameEl) nameEl.textContent = n === 1 ? input.files[0].name : n > 1 ? n + ' files selected' : '';
      zone.classList.toggle('has-file', n > 0);
    }
    input.addEventListener('change', show);
    ['dragover', 'dragenter'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('drag'); });
    });
    zone.addEventListener('dragleave', function () { zone.classList.remove('drag'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('drag');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        input.files = e.dataTransfer.files;
        show();
      }
    });
  });
})();
