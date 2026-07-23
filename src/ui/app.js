/* StayLeased client enhancements — no framework, progressive enhancement only. */
(function () {
  'use strict';

  // toggles (menus, sidebar) — menus are EXCLUSIVE: opening one closes the rest
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (t) {
      var el = document.querySelector(t.getAttribute('data-toggle'));
      if (el) {
        var opening = !el.classList.contains('open');
        document.querySelectorAll('.menu.open').forEach(function (m) {
          if (m !== el) m.classList.remove('open');
        });
        el.classList.toggle('open', opening);
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
        fetch('/search.json?q=' + encodeURIComponent(q))
          .then(function (r) { return r.json(); })
          .then(function (data) {
            sel = -1;
            if (!data.results || !data.results.length) {
              pResults.innerHTML = '<div class="hintbar">No matches for “' + q.replace(/[<>&]/g, '') + '”</div>';
              return;
            }
            pResults.innerHTML = data.results
              .map(function (r) {
                return '<a href="' + r.href + '"><span class="kind">' + r.kind + '</span><span><b>' + r.label + '</b>' + (r.sub ? ' <span class="muted">· ' + r.sub + '</span>' : '') + '</span></a>';
              })
              .join('');
          });
      }, 160);
    });
    pInput.addEventListener('keydown', function (e) {
      var links = pResults.querySelectorAll('a');
      if (!links.length) return;
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, links.length - 1); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); }
      else if (e.key === 'Enter' && sel >= 0) { window.location.href = links[sel].href; return; }
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

  // drag & drop lanes (dispatch board / turns)
  document.querySelectorAll('[data-dnd-lane]').forEach(function (lane) {
    lane.addEventListener('dragover', function (e) { e.preventDefault(); });
    lane.addEventListener('drop', function (e) {
      e.preventDefault();
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
    });
  });
})();
