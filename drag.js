// Drag-to-reorder for the task list (Pointer Events, event delegation).
// onMove(id, beforeId, afterId) is called once per completed move; null = list end.
export function enableDrag(listEl, { onMove, canDrag }) {
  let st = null; // active drag: { li, grip, pid, startY, startScroll, y, line, raf, before, after }
  const ids = (li) => (li ? li.dataset.id : null);
  const rowsOf = () => [...listEl.children].filter((el) => el.dataset && el.dataset.id);

  function neighbors(li, y) {
    const others = rowsOf().filter((el) => el !== li);
    let i = 0;
    while (i < others.length) {
      const r = others[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) break;
      i++;
    }
    return { prev: others[i - 1] || null, next: others[i] || null, others, i };
  }

  function update() {
    if (!st) return;
    const { li } = st;
    const lr = listEl.getBoundingClientRect(), h = li.offsetHeight;
    const base = st.baseTop - (window.scrollY - st.startScroll); // row's untransformed viewport top
    const dy = Math.min(Math.max(st.y - st.startY + (window.scrollY - st.startScroll), lr.top - base),
      lr.bottom - h - base);
    li.style.transform = `translateY(${dy}px) scale(1.02)`;
    const { prev, next } = neighbors(li, st.y);
    st.before = prev; st.after = next;
    const top = next ? next.getBoundingClientRect().top
      : prev ? prev.getBoundingClientRect().bottom : lr.top;
    st.line.style.cssText = `left:${lr.left}px;width:${lr.width}px;top:${top - 1}px`;
  }

  function tick() {
    if (!st) return;
    const edge = 70, h = window.innerHeight;
    const v = st.y < edge ? -(edge - st.y) : st.y > h - edge ? st.y - (h - edge) : 0;
    if (v) { window.scrollBy(0, Math.round(v / 4)); update(); }
    st.raf = requestAnimationFrame(tick);
  }

  function end(commit) {
    if (!st) return;
    const s = st; st = null;
    cancelAnimationFrame(s.raf);
    document.removeEventListener('keydown', onKey, true);
    s.grip.removeEventListener('pointermove', onPointerMove);
    s.grip.removeEventListener('pointerup', onUp);
    s.grip.removeEventListener('pointercancel', onCancel);
    try { s.grip.releasePointerCapture(s.pid); } catch {}
    s.line.remove();
    document.body.classList.remove('dragging');
    s.li.classList.remove('drag-lifted');
    s.li.style.transform = '';
    if (!commit || !s.li.isConnected) return;
    const b = ids(s.before), a = ids(s.after);
    const same = s.before === s.li.previousElementSibling && s.after === s.li.nextElementSibling;
    if (!same && (b || a)) onMove(s.li.dataset.id, b, a);
  }

  const onPointerMove = (e) => { if (st && e.pointerId === st.pid) { st.y = e.clientY; update(); } };
  const onUp = (e) => { if (st && e.pointerId === st.pid) end(true); };
  const onCancel = (e) => { if (st && e.pointerId === st.pid) end(false); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
  };

  listEl.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest && e.target.closest('.grip');
    const li = grip && grip.closest('li[data-id]');
    if (!li || st || !listEl.contains(li) || !canDrag() || e.button > 0) return;
    e.preventDefault();
    const line = document.createElement('div');
    line.className = 'drag-line';
    document.body.appendChild(line);
    st = { li, grip, pid: e.pointerId, startY: e.clientY, startScroll: window.scrollY, baseTop: li.getBoundingClientRect().top,
           y: e.clientY, line, raf: 0, before: li.previousElementSibling, after: li.nextElementSibling };
    try { grip.setPointerCapture(e.pointerId); } catch {}
    grip.addEventListener('pointermove', onPointerMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onCancel);
    document.addEventListener('keydown', onKey, true);
    document.body.classList.add('dragging');
    li.classList.add('drag-lifted');
    update();
    st.raf = requestAnimationFrame(tick);
  });

  listEl.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.target.classList || !e.target.classList.contains('grip')) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const li = e.target.closest('li[data-id]');
    if (!li || st || !canDrag()) return;
    e.preventDefault();
    const up = e.key === 'ArrowUp';
    const other = up ? li.previousElementSibling : li.nextElementSibling;
    if (!other) return;
    const far = up ? other.previousElementSibling : other.nextElementSibling;
    onMove(li.dataset.id, up ? ids(far) : ids(other), up ? ids(other) : ids(far));
  });
}
