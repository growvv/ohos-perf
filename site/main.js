/* ohos-perf landing page behaviour: bilingual copy, reveal-on-scroll, copy buttons. */
(() => {
  'use strict';

  const root = document.documentElement;
  const STORE = 'ohos-perf.lang';
  const meta = document.querySelector('meta[name="description"]');
  const metaEn = meta ? meta.content : '';

  /* ---------- language ---------- */

  /** Escape text, then turn `backtick spans` into <code> so both locales keep the style. */
  function format(text) {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function applyLang(lang, persist = true) {
    const zh = lang === 'zh';
    root.dataset.lang = lang;
    root.lang = zh ? 'zh-CN' : 'en';

    for (const el of document.querySelectorAll('[data-en][data-zh]')) {
      const text = el.dataset[zh ? 'zh' : 'en'];
      if (text === undefined) continue;
      el.innerHTML = format(text);
    }

    if (meta) {
      meta.content = zh
        ? '面向鸿蒙性能分析的 TypeScript 工具包：能力探测、hitrace、procfs 与 hiprofiler 采集、trace 入库、类型化查询、十四个分析器（帧、故障树、binder、线程、内存、内存测量、启动、渲染、GC 压力、VSync、空帧、RenderService 跳过、火焰图、组件复用）与 CLI。确定性、可追溯、零原生依赖。'
        : metaEn;
    }

    if (persist) {
      try { localStorage.setItem(STORE, lang); } catch { /* private mode */ }
    }
  }

  let saved = null;
  try { saved = localStorage.getItem(STORE); } catch { /* private mode */ }
  const forced = new URLSearchParams(window.location.search).get('lang');
  const initial = forced === 'zh' || forced === 'en'
    ? forced
    : saved === 'zh' || saved === 'en'
      ? saved
      : (String(navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  applyLang(initial, forced === null);

  const langButton = document.getElementById('lang');
  if (langButton) {
    langButton.addEventListener('click', () => {
      applyLang(root.dataset.lang === 'zh' ? 'en' : 'zh');
    });
  }

  /* ---------- nav and reveal ---------- */

  const nav = document.querySelector('.nav');
  const onScroll = () => {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = [...document.querySelectorAll('.reveal')];
  const revealAll = new URLSearchParams(window.location.search).get('reveal') === 'all';
  if (revealAll) items.forEach((el) => el.classList.add('in'));
  if (reduced || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el, i) => {
      el.style.transitionDelay = `${Math.min((i % 6) * 45, 225)}ms`;
      io.observe(el);
    });
  }

  /* ---------- copy buttons ---------- */

  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copy || '');
      if (!target) return;
      const text = target.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
      }
      const previous = button.textContent;
      button.textContent = root.dataset.lang === 'zh' ? '已复制' : 'Copied';
      button.classList.add('done');
      setTimeout(() => {
        button.textContent = previous;
        button.classList.remove('done');
      }, 1600);
    });
  }

  /* ---------- demo video ---------- */

  const video = document.getElementById('promo');
  if (video && !reduced && 'IntersectionObserver' in window) {
    const vio = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const play = video.play();
          if (play && typeof play.catch === 'function') play.catch(() => {});
        } else {
          video.pause();
        }
      }
    }, { threshold: 0.35 });
    vio.observe(video);
  }
})();
