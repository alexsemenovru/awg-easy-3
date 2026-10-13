'use strict';

window.awgTooltips = (() => {
  let nextId = 0;
  let pinned = null;
  const close = () => {
    if (!pinned) return;
    pinned.removeAttribute('data-open');
    pinned.querySelector('.info-trigger').setAttribute('aria-expanded', 'false');
    pinned = null;
  };
  const position = (tip) => {
    const bubble = tip.querySelector('.info-bubble');
    const width = Math.min(290, window.innerWidth - 20);
    const left = Math.max(10, Math.min(tip.getBoundingClientRect().left, window.innerWidth - width - 10));
    bubble.style.left = `${left - tip.getBoundingClientRect().left}px`;
  };
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('.info-tip')) close();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
  const attach = (root) => {
    for (const tip of root.querySelectorAll('.info-tip')) {
      const trigger = tip.querySelector('.info-trigger');
      const bubble = tip.querySelector('.info-bubble');
      bubble.id = `awg-tip-${++nextId}`;
      trigger.setAttribute('aria-describedby', bubble.id);
      tip.addEventListener('mouseenter', () => position(tip));
      tip.addEventListener('focusin', () => position(tip));
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (pinned === tip) { close(); return; }
        close();
        position(tip);
        tip.setAttribute('data-open', '');
        trigger.setAttribute('aria-expanded', 'true');
        pinned = tip;
      });
    }
  };
  return Object.freeze({ attach });
})();
