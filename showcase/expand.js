/*!
 * showcase/expand.js — click-to-expand images and an expand button on videos
 * for every nitsuah GitHub Pages site. One <script> tag, no dependencies:
 *
 *   <script src="https://cdn.jsdelivr.net/gh/nitsuah/.github@main/showcase/expand.js" defer></script>
 *
 * Images: click (or Enter) opens a fullscreen viewer; click, Esc or ✕ closes it;
 *   ←/→ step through every expandable image on the page.
 * Videos: an ⛶ button in the top-right corner plays the video fullscreen with
 *   native controls.
 * Opt out with data-no-expand (data-no-expand="images" keeps video buttons);
 * point the viewer at a larger file with data-full.
 * Spec: https://github.com/nitsuah/.github/blob/main/showcase/STANDARD.md
 */
(function () {
  'use strict';
  if (window.__showcaseExpand) return;
  window.__showcaseExpand = '1.0.0';

  var MIN_SIZE = 160; // icons, logos and avatars stay inert
  var SKIP = 'header, nav, footer, a, button, [data-no-expand]';

  var css =
    '.sx-img{cursor:zoom-in;transition:filter .15s,box-shadow .15s}' +
    '.sx-img:hover,.sx-img:focus-visible{filter:brightness(1.06);box-shadow:0 0 0 2px rgba(127,127,127,.45);outline:none}' +
    '.sx-ov{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    'gap:12px;padding:2vh 2vw;background:rgba(6,8,12,.94);cursor:zoom-out;animation:sx-in .15s ease-out}' +
    '@keyframes sx-in{from{opacity:0}}' +
    '.sx-ov img{max-width:96vw;max-height:88vh;width:auto;height:auto;object-fit:contain;border-radius:6px;box-shadow:0 10px 40px rgba(0,0,0,.6)}' +
    '.sx-cap{max-width:90vw;color:#e8eaed;font:14px/1.45 system-ui,sans-serif;text-align:center}' +
    '.sx-btn{position:absolute;display:grid;place-items:center;width:40px;height:40px;border:0;border-radius:8px;cursor:pointer;' +
    'background:rgba(20,22,28,.7);border:1px solid rgba(255,255,255,.35);color:#fff;font:22px/1 system-ui,sans-serif;backdrop-filter:blur(4px)}' +
    '.sx-btn:hover,.sx-btn:focus-visible{background:rgba(60,64,72,.9);outline:2px solid #fff;outline-offset:1px}' +
    '.sx-ov .sx-btn{position:fixed}' +
    '.sx-x{top:14px;right:14px}.sx-prev,.sx-next{top:50%;transform:translateY(-50%);height:64px}.sx-prev{left:14px}.sx-next{right:14px}' +
    '.sx-vbtn{z-index:5;opacity:.85}.sx-vbtn:hover{opacity:1}' +
    '@media (prefers-reduced-motion:reduce){.sx-ov{animation:none}.sx-img{transition:none}}';

  function injectStyle() {
    var s = document.createElement('style');
    s.id = 'showcase-expand';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function eligible(img) {
    if (img.closest(SKIP) || img.closest('.sx-ov')) return false;
    // Intrinsic size only: layout size is meaningless before a lazy image loads
    // (mark() retries on load).
    return img.naturalWidth >= MIN_SIZE && img.naturalHeight >= MIN_SIZE / 2;
  }

  function mark(img) {
    if (img.dataset.sx) return;
    if (!eligible(img)) {
      if (!img.complete) img.addEventListener('load', function () { mark(img); }, { once: true });
      return;
    }
    img.dataset.sx = '1';
    img.classList.add('sx-img');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', 'Expand image' + (img.alt ? ': ' + img.alt : ''));
  }

  // ---- image viewer -------------------------------------------------------
  var ov, big, cap, list = [], idx = 0, lastFocus;

  function caption(img) {
    var fig = img.closest('figure');
    var fc = fig && fig.querySelector('figcaption');
    return (fc && fc.textContent.trim()) || img.alt || '';
  }

  function show(i) {
    idx = (i + list.length) % list.length;
    var img = list[idx];
    big.src = img.dataset.full || img.currentSrc || img.src;
    big.alt = img.alt || '';
    cap.textContent = caption(img);
    cap.hidden = !cap.textContent;
  }

  function open(img) {
    list = Array.prototype.filter.call(document.querySelectorAll('img.sx-img'), function (el) {
      return el.offsetParent !== null;
    });
    if (list.indexOf(img) < 0) list.push(img);
    lastFocus = document.activeElement;
    ov = document.createElement('div');
    ov.className = 'sx-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Expanded image');
    big = document.createElement('img');
    cap = document.createElement('div');
    cap.className = 'sx-cap';
    var x = button('✕', 'Close', 'sx-x', close);
    ov.appendChild(big);
    ov.appendChild(cap);
    ov.appendChild(x);
    if (list.length > 1) {
      ov.appendChild(button('‹', 'Previous image', 'sx-prev', function () { show(idx - 1); }));
      ov.appendChild(button('›', 'Next image', 'sx-next', function () { show(idx + 1); }));
    }
    ov.addEventListener('click', function (e) { if (!e.target.closest('.sx-btn')) close(); });
    document.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFsChange);
    document.body.appendChild(ov);
    show(list.indexOf(img));
    x.focus();
    if (ov.requestFullscreen && !document.fullscreenElement) ov.requestFullscreen().catch(function () {});
  }

  function close() {
    if (!ov) return;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('fullscreenchange', onFsChange);
    if (document.fullscreenElement === ov) document.exitFullscreen().catch(function () {});
    ov.remove();
    ov = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // Leaving fullscreen with the browser's own Esc closes the viewer too.
  function onFsChange() { if (ov && !document.fullscreenElement) close(); }

  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight' && list.length > 1) show(idx + 1);
    else if (e.key === 'ArrowLeft' && list.length > 1) show(idx - 1);
    else if (e.key === 'Tab') { // keep focus inside the dialog
      var b = ov.querySelectorAll('.sx-btn');
      var first = b[0], lastB = b[b.length - 1];
      if (e.shiftKey && document.activeElement === first) { lastB.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === lastB) { first.focus(); e.preventDefault(); }
    }
  }

  function button(text, label, cls, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'sx-btn ' + cls;
    b.textContent = text;
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', function (e) { e.stopPropagation(); fn(e); });
    return b;
  }

  // ---- video expand button ------------------------------------------------
  function enhanceVideo(v) {
    if (v.dataset.sx || v.closest('[data-no-expand]:not([data-no-expand="images"])')) return;
    v.dataset.sx = '1';
    var parent = v.parentElement;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    var b = button('⛶', 'Play fullscreen', 'sx-vbtn', function () { fullscreenVideo(v); });
    parent.appendChild(b);
    function place() {
      b.style.top = v.offsetTop + 10 + 'px';
      b.style.left = v.offsetLeft + v.offsetWidth - 50 + 'px';
    }
    place();
    if (window.ResizeObserver) new ResizeObserver(place).observe(v);
    window.addEventListener('resize', place);
  }

  function fullscreenVideo(v) {
    var hadControls = v.controls;
    v.controls = true;
    var restore = function () {
      if (document.fullscreenElement) return;
      v.controls = hadControls;
      document.removeEventListener('fullscreenchange', restore);
    };
    if (v.requestFullscreen) {
      document.addEventListener('fullscreenchange', restore);
      v.requestFullscreen().catch(restore);
    } else if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen(); // iOS Safari: video-only fullscreen with native controls
    }
    if (v.paused) v.play().catch(function () {});
  }

  // ---- wiring -------------------------------------------------------------
  function scan(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('img'), mark);
    Array.prototype.forEach.call((root || document).querySelectorAll('video'), enhanceVideo);
  }

  function init() {
    injectStyle();
    scan();
    document.addEventListener('click', function (e) {
      var img = e.target.closest && e.target.closest('img.sx-img');
      if (img && !ov) { e.preventDefault(); open(img); }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('sx-img') && !ov) {
        e.preventDefault();
        open(e.target);
      }
    });
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        muts.forEach(function (m) {
          m.addedNodes.forEach(function (n) {
            if (n.nodeType !== 1) return;
            if (n.tagName === 'IMG') mark(n);
            else if (n.tagName === 'VIDEO') enhanceVideo(n);
            else if (!n.classList.contains('sx-ov')) scan(n);
          });
        });
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
