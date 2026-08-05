/* Scroll reveal for the news hub and the article pages.
 *
 * main.js carries the same observer plus every canvas demo on the landing
 * page; the reading pages want the animation and none of the weight. */
(() => {
  'use strict';

  const els = document.querySelectorAll('.reveal');
  if (!els.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // The stylesheet already neutralises .reveal under reduced motion; adding
    // .in keeps the two paths identical if that rule is ever changed.
    els.forEach(el => el.classList.add('in'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12 });

  els.forEach(el => io.observe(el));
})();
