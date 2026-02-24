// ── Live spans table ──────────────────────────────────────────────────────────

import type { SpanEvent } from '../core/types.ts';

import { targetColor } from '../core/colors.ts';
import { fmtTime, fmtDur, escHtml } from '../core/utils.ts';
import { C } from '../core/theme.ts';

// ── MultiSelect widget ──────────────────────────────────────────────────────

class MultiSelect {
  private selected: Set<string>        = new Set();
  private known:    Map<string, number> = new Map(); // value → count
  private query     = '';
  private isOpen    = false;

  private readonly btn:      HTMLButtonElement;
  private readonly dropdown: HTMLDivElement;
  private readonly onChange: () => void;

  constructor(container: HTMLElement, onChange: () => void) {
    this.onChange = onChange;

    this.btn = document.createElement('button');
    this.btn.className = 'ms-btn';
    this.btn.textContent = 'any…';
    this.btn.type = 'button';
    container.appendChild(this.btn);

    this.dropdown = document.createElement('div');
    this.dropdown.className = 'ms-dropdown';
    this.dropdown.style.display = 'none';
    container.appendChild(this.dropdown);

    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    document.addEventListener('click', (e) => {
      if (this.isOpen && !container.contains(e.target as Node)) this.close();
    });
  }

  register(value: string): void {
    this.known.set(value, (this.known.get(value) ?? 0) + 1);
    // Do not rebuild the DOM list here — it rebuilds next time the dropdown opens.
    // Calling renderList() on every span arrival freezes the dropdown on high-rate streams.
  }

  getSelected(): Set<string> { return this.selected; }
  hasSelection(): boolean    { return this.selected.size > 0; }

  clear(): void {
    this.selected.clear();
    this.updateBtn();
    if (this.isOpen) this.renderList();
  }

  private toggle() { this.isOpen ? this.close() : this.open(); }

  private open() {
    this.isOpen = true;
    this.dropdown.style.display = 'block';
    this.buildDropdown();
  }

  private close() {
    this.isOpen = false;
    this.dropdown.style.display = 'none';
  }

  private buildDropdown() {
    this.dropdown.innerHTML = '';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'ms-search';
    search.placeholder = 'filter…';
    search.value = this.query;
    search.addEventListener('input', () => { this.query = search.value; this.renderList(); });
    search.addEventListener('click', (e) => e.stopPropagation());
    this.dropdown.appendChild(search);
    const list = document.createElement('div');
    list.className = 'ms-list';
    this.dropdown.appendChild(list);
    this.renderList();
    requestAnimationFrame(() => search.focus());
  }

  private renderList() {
    const list = this.dropdown.querySelector<HTMLElement>('.ms-list');
    if (!list) return;
    list.innerHTML = '';
    const q      = this.query.toLowerCase();
    const sorted = Array.from(this.known.keys())
      .filter(v => !q || v.toLowerCase().includes(q))
      .sort();
    if (sorted.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ms-empty';
      empty.textContent = q ? 'No matches' : 'No values yet';
      list.appendChild(empty);
      return;
    }
    for (const val of sorted) {
      const item = document.createElement('label');
      item.className = 'ms-item';
      item.addEventListener('click', (e) => e.stopPropagation());
      const cb = document.createElement('input');
      cb.type    = 'checkbox';
      cb.checked = this.selected.has(val);
      cb.addEventListener('change', () => {
        if (cb.checked) this.selected.add(val); else this.selected.delete(val);
        this.updateBtn();
        this.onChange();
      });
      const text = document.createElement('span');
      text.className   = 'ms-item-text';
      text.textContent = val;
      text.title       = val;
      const cnt = document.createElement('span');
      cnt.style.cssText = `margin-left:auto;font-size:9px;color:${C.muted};flex-shrink:0`;
      cnt.textContent   = String(this.known.get(val) ?? '');
      item.appendChild(cb);
      item.appendChild(text);
      item.appendChild(cnt);
      list.appendChild(item);
    }
  }

  private updateBtn() {
    if (this.selected.size === 0) {
      this.btn.textContent = 'any…';
      this.btn.classList.remove('ms-active');
    } else {
      this.btn.textContent = `${this.selected.size} selected`;
      this.btn.classList.add('ms-active');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export interface TracesTableOpts {
  tbody:            HTMLTableSectionElement;
  wrap:             HTMLElement;
  countEl:          HTMLElement;
  emptyEl:          HTMLElement;
  filterTargetWrap: HTMLElement;
  filterNameWrap:   HTMLElement;
  filterDurMin:     HTMLInputElement;
  filterDurMax:     HTMLInputElement;
  filterClear:      HTMLButtonElement;
  filterMatch:      HTMLElement;
  detailPanel:      HTMLElement;
  /** Optional: resolve a span_id → full SpanEvent (with attributes) at click time. */
  lookupFullSpan?: (spanId: string) => SpanEvent | undefined;
}

export class TracesTable {
  private readonly tbody:        HTMLTableSectionElement;
  private readonly wrap:         HTMLElement;
  private readonly countEl:      HTMLElement;
  private readonly emptyEl:      HTMLElement;
  private readonly msTarget:     MultiSelect;
  private readonly msName:       MultiSelect;
  private readonly filterDurMin: HTMLInputElement;
  private readonly filterDurMax: HTMLInputElement;
  private readonly filterMatch:  HTMLElement;
  private readonly detailPanel:  HTMLElement;
  private readonly lookupFullSpan?: (spanId: string) => SpanEvent | undefined;

  private allSpans: SpanEvent[] = [];
  static readonly BUFFER_SIZE = 2000;

  private pending:       SpanEvent[] = [];
  private rowCount       = 0;
  private totalSeen      = 0;
  private atTop          = true;
  private scheduled      = false;
  private refilterQueued = false;

  static readonly MAX_ROWS   = 500;

  private selectedRow: HTMLTableRowElement | null = null;

  constructor(opts: TracesTableOpts) {
    this.tbody        = opts.tbody;
    this.wrap         = opts.wrap;
    this.countEl      = opts.countEl;
    this.emptyEl      = opts.emptyEl;
    this.filterDurMin = opts.filterDurMin;
    this.filterDurMax = opts.filterDurMax;
    this.filterMatch  = opts.filterMatch;
    this.detailPanel  = opts.detailPanel;
    this.lookupFullSpan = opts.lookupFullSpan;

    const queueRefilter = () => {
      if (!this.refilterQueued) {
        this.refilterQueued = true;
        requestAnimationFrame(() => this.refilter());
      }
    };

    this.msTarget = new MultiSelect(opts.filterTargetWrap, queueRefilter);
    this.msName   = new MultiSelect(opts.filterNameWrap,   queueRefilter);

    opts.wrap.addEventListener('scroll', () => {
      this.atTop = opts.wrap.scrollTop < 60;
      if (this.atTop) this.clearUnread();
    }, { passive: true });

    opts.filterDurMin.addEventListener('input', queueRefilter);
    opts.filterDurMax.addEventListener('input', queueRefilter);
    opts.filterClear.addEventListener('click', () => {
      this.msTarget.clear();
      this.msName.clear();
      opts.filterDurMin.value = '';
      opts.filterDurMax.value = '';
      queueRefilter();
    });
  }

  // ── Filter ────────────────────────────────────────────────────────────────

  private matches(span: SpanEvent): boolean {
    const selTargets = this.msTarget.getSelected();
    const selNames   = this.msName.getSelected();
    const fMin = parseFloat(this.filterDurMin.value);
    const fMax = parseFloat(this.filterDurMax.value);
    if (selTargets.size > 0 && !selTargets.has(span.target)) return false;
    if (selNames.size   > 0 && !selNames.has(span.name))     return false;
    if (!isNaN(fMin) && span.duration_ms < fMin)             return false;
    if (!isNaN(fMax) && span.duration_ms > fMax)             return false;
    return true;
  }

  private hasFilters(): boolean {
    return this.msTarget.hasSelection() || this.msName.hasSelection() ||
           !!(this.filterDurMin.value.trim() || this.filterDurMax.value.trim());
  }

  // ── Public API ────────────────────────────────────────────────────────────

  add(span: SpanEvent, tabVisible: boolean): void {
    // push (O(1)) instead of unshift (O(n)); lazy compact only when well over limit.
    this.allSpans.push(span);
    if (this.allSpans.length > TracesTable.BUFFER_SIZE + 200) {
      this.allSpans = this.allSpans.slice(-TracesTable.BUFFER_SIZE);
    }
    this.totalSeen++;

    // Register values for the dropdowns
    this.msTarget.register(span.target);
    this.msName.register(span.name);



    if (this.matches(span)) {
      this.pending.push(span);
      if (!this.scheduled) {
        this.scheduled = true;
        requestAnimationFrame(() => this.flush());
      }
    }
  }

  clearUnread(): void {}

  /** Back-fill attributes (and other fields) from a completed trace into any
   * already-stored spans that were added via SpanArrivedPayload (which carries
   * no attributes). This makes the detail panel show full span fields. */
  enrich(spans: SpanEvent[]): void {
    const byId = new Map<string, SpanEvent>();
    for (const s of spans) byId.set(s.span_id, s);
    for (const s of this.allSpans) {
      const full = byId.get(s.span_id);
      if (full && full.attributes?.length) s.attributes = full.attributes;
    }
  }

  // ── Refilter from ring buffer (on filter change) ──────────────────────────

  private refilter(): void {
    this.refilterQueued = false;
    this.pending = [];

    // allSpans is oldest→newest (push order); iterate in reverse for newest-first display.
    // Count all matches for the footer, but only keep the first MAX_ROWS for display.
    const toShow: SpanEvent[] = [];
    let totalMatches = 0;
    for (let i = this.allSpans.length - 1; i >= 0; i--) {
      if (this.matches(this.allSpans[i])) {
        totalMatches++;
        if (toShow.length < TracesTable.MAX_ROWS) toShow.push(this.allSpans[i]);
      }
    }

    this.tbody.textContent = '';
    this.rowCount = 0;

    if (toShow.length > 0) {
      const frag = document.createDocumentFragment();
      for (const s of toShow) frag.appendChild(this.makeRow(s, false));
      this.tbody.appendChild(frag);
      this.rowCount = toShow.length;
    }

    this.updateFooter(totalMatches);
    this.emptyEl.style.display = this.rowCount > 0 ? 'none' : '';

    if (this.hasFilters()) {
      this.filterMatch.textContent = `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`;
      this.filterMatch.style.display = 'inline';
    } else {
      this.filterMatch.style.display = 'none';
    }

    this.hideDetail();
  }

  // ── DOM flush ─────────────────────────────────────────────────────────────

  private flush(): void {
    this.scheduled = false;
    if (this.pending.length === 0) return;

    const flash = this.pending.length <= 5;
    // pending is oldest→newest (push order), reverse for newest-first display.
    // Process all pending at once — the frame queue cap (200/frame) bounds the batch size.
    const toFlush = this.pending.splice(0).reverse();

    const frag = document.createDocumentFragment();
    for (const s of toFlush) frag.appendChild(this.makeRow(s, flash));
    this.tbody.insertBefore(frag, this.tbody.firstChild);
    this.rowCount += toFlush.length;

    const excess = this.rowCount - TracesTable.MAX_ROWS;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) this.tbody.deleteRow(-1);
      this.rowCount = TracesTable.MAX_ROWS;
    }

    this.updateFooter(this.rowCount);
    if (this.rowCount > 0) this.emptyEl.style.display = 'none';
    if (this.atTop) this.wrap.scrollTop = 0;
  }

  private updateFooter(filteredCount: number): void {
    const total = this.totalSeen.toLocaleString();
    if (this.hasFilters()) {
      this.countEl.textContent = `${filteredCount} of ${total} spans`;
    } else {
      this.countEl.textContent =
        this.totalSeen > TracesTable.MAX_ROWS
          ? `showing last ${this.rowCount.toLocaleString()} of ${total} spans`
          : `${this.rowCount.toLocaleString()} span${this.rowCount !== 1 ? 's' : ''}`;
    }
  }

  // ── Row builder ───────────────────────────────────────────────────────────

  private makeRow(span: SpanEvent, flash: boolean): HTMLTableRowElement {
    const color  = targetColor(span.target).fill;
    const durCls =
      span.duration_ms > 1000 ? 'dur-vsl' :
      span.duration_ms > 200  ? 'dur-sl'  :
      span.duration_ms > 50   ? 'dur-md'  : '';

    const tr = document.createElement('tr');
    tr.className = flash ? 'span-row nr' : 'span-row';

    const tdTime = tr.insertCell();
    tdTime.className = 'c-time mono';
    tdTime.textContent = fmtTime(span.start_time_unix_nano);

    const tdTrace = tr.insertCell();
    tdTrace.className = 'c-trace';
    const chip = document.createElement('span');
    chip.className = 'trace-chip';
    chip.style.color = color;
    chip.textContent = span.trace_id.slice(0, 8);
    tdTrace.appendChild(chip);

    const tdName = tr.insertCell();
    tdName.className = 'c-name';
    tdName.title = span.name;
    tdName.textContent = span.name;

    const tdTarget = tr.insertCell();
    tdTarget.className = 'c-target';
    const dot = document.createElement('span');
    dot.className = 'cat-dot';
    dot.style.background = color;
    const tgtText = document.createElement('span');
    tgtText.className = 'tgt-text';
    tgtText.title = span.target;
    tgtText.textContent = span.target;
    tdTarget.appendChild(dot);
    tdTarget.appendChild(tgtText);

    const tdDur = tr.insertCell();
    tdDur.className = `c-dur mono${durCls ? ' ' + durCls : ''}`;
    tdDur.textContent = fmtDur(span.duration_ms);

    tr.addEventListener('click', () => this.showDetail(span, tr));
    return tr;
  }

  // ── Detail panel ──────────────────────────────────────────────────────────

  private showDetail(span: SpanEvent, row: HTMLTableRowElement): void {
    if (this.selectedRow === row) { this.hideDetail(); return; }
    this.selectedRow?.classList.remove('row-selected');
    this.selectedRow = row;
    row.classList.add('row-selected');

    // Fetch the richest available version of the span (has attributes if trace completed)
    const full = (this.lookupFullSpan && this.lookupFullSpan(span.span_id)) ?? span;

    const statusOk = !full.status || full.status === 'ok' || full.status === 'unset';
    const durCls   =
      full.duration_ms > 1000 ? 'dur-vsl' :
      full.duration_ms > 200  ? 'dur-sl'  :
      full.duration_ms > 50   ? 'dur-md'  : '';

    const attrRows = (full.attributes ?? [])
      .map(([k, v]) => `<tr>
        <td class="da-key">${escHtml(String(k))}</td>
        <td class="da-val">${escHtml(String(v))}</td>
      </tr>`).join('');

    this.detailPanel.innerHTML = `
      <div class="dp-header">
        <span class="dp-name" title="${escHtml(full.name)}">${escHtml(full.name)}</span>
        <button class="dp-close" id="dp-close-btn">✕</button>
      </div>
      <div class="dp-body">
        <div class="dp-section">
          <div class="dp-row"><span class="dp-label">Target</span><span class="dp-mono">${escHtml(full.target)}</span></div>
          <div class="dp-row"><span class="dp-label">Service</span><span class="dp-mono">${escHtml(full.service_name || '—')}</span></div>
          <div class="dp-row"><span class="dp-label">Duration</span><span class="dp-mono ${durCls}">${escHtml(fmtDur(full.duration_ms))}</span></div>
          <div class="dp-row"><span class="dp-label">Status</span><span class="st-badge ${statusOk ? 'st-ok' : 'st-err'}">${escHtml(full.status || 'unset')}</span></div>
        </div>
        <div class="dp-section">
          <div class="dp-row"><span class="dp-label">Trace ID</span><span class="dp-mono dp-small">${escHtml(full.trace_id)}</span></div>
          <div class="dp-row"><span class="dp-label">Span ID</span><span class="dp-mono dp-small">${escHtml(full.span_id)}</span></div>
          ${full.parent_span_id ? `<div class="dp-row"><span class="dp-label">Parent</span><span class="dp-mono dp-small">${escHtml(full.parent_span_id)}</span></div>` : ''}
          <div class="dp-row"><span class="dp-label">Start</span><span class="dp-mono dp-small">${escHtml(fmtTime(full.start_time_unix_nano))}</span></div>
        </div>
        ${attrRows ? `<div class="dp-section"><div class="dp-section-title">Attributes</div><table class="dp-attrs"><tbody>${attrRows}</tbody></table></div>` : ''}
      </div>`;

    this.detailPanel.classList.add('dp-open');
    this.detailPanel.querySelector<HTMLButtonElement>('#dp-close-btn')!
      .addEventListener('click', () => this.hideDetail());
  }

  private hideDetail(): void {
    this.selectedRow?.classList.remove('row-selected');
    this.selectedRow = null;
    this.detailPanel.classList.remove('dp-open');
  }
}

