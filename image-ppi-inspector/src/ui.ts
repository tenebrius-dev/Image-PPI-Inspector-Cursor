type InspectPayload = {
  originalWidth: number;
  originalHeight: number;
  currentWidth: number;
  currentHeight: number;
  effectivePpi: number;
  printWidthMm: number;
};

type PluginMessage =
  | { type: 'inspect'; payload: InspectPayload | null; reason?: string }
  | { type: 'resize-done'; ok: boolean; error?: string };

const app = document.getElementById('app');

function fmt(n: number, digits: number): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function clampTargetPpi(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return 300;
  }
  return Math.min(2400, Math.max(1, raw));
}

function renderEmpty(reason: string | undefined): void {
  if (!app) {
    return;
  }
  app.innerHTML = `
    <div class="flex min-h-screen flex-col gap-3 bg-[var(--figma-color-bg)] p-4 text-[var(--figma-color-text)]">
      <header class="border-b border-[var(--figma-color-border)] pb-3">
        <h1 class="text-sm font-semibold tracking-tight">Image PPI Inspector</h1>
        <p class="mt-1 text-xs text-[var(--figma-color-text-secondary)]">Rectangle or Frame · image fill · 1 px = 1/72 in</p>
      </header>
      <div class="rounded-xl border border-dashed border-[var(--figma-color-border)] bg-[var(--figma-color-bg-secondary)] px-3 py-4 text-sm leading-relaxed text-[var(--figma-color-text-secondary)]">
        ${reason ?? 'Nothing to inspect.'}
      </div>
    </div>
  `;
}

function renderPanel(payload: InspectPayload, initialTarget: number): void {
  if (!app) {
    return;
  }

  const warn = payload.effectivePpi < 250;
  const ppiClass = warn
    ? 'font-semibold text-[var(--figma-color-text-danger)]'
    : 'font-semibold text-[var(--figma-color-text-success)]';

  app.innerHTML = `
    <div class="flex min-h-screen flex-col gap-3 bg-[var(--figma-color-bg)] p-4 text-[var(--figma-color-text)]">
      <header class="border-b border-[var(--figma-color-border)] pb-3">
        <h1 class="text-sm font-semibold tracking-tight">Image PPI Inspector</h1>
        <p class="mt-1 text-xs text-[var(--figma-color-text-secondary)]">Live selection · print assumptions below</p>
      </header>

      ${
        warn
          ? `<div class="rounded-lg border border-[var(--figma-color-border-warning-strong)] bg-[var(--figma-color-bg-warning-tertiary)] px-3 py-2 text-xs text-[var(--figma-color-text-warning)]">
          Warning: effective PPI is below 250 — may look soft in print.
        </div>`
          : ''
      }

      <section class="space-y-3 rounded-xl border border-[var(--figma-color-border)] bg-[var(--figma-color-bg-secondary)] p-3">
        <div class="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div class="text-[var(--figma-color-text-secondary)]">Source image</div>
            <div class="mt-0.5 font-mono">${fmt(payload.originalWidth, 0)} × ${fmt(
              payload.originalHeight,
              0
            )} px</div>
          </div>
          <div>
            <div class="text-[var(--figma-color-text-secondary)]">Layer size</div>
            <div class="mt-0.5 font-mono">${fmt(payload.currentWidth, 1)} × ${fmt(
              payload.currentHeight,
              1
            )} px</div>
          </div>
        </div>

        <div class="border-t border-[var(--figma-color-border)] pt-3">
          <div class="text-xs text-[var(--figma-color-text-secondary)]">Effective PPI</div>
          <div class="mt-0.5 font-mono text-lg ${ppiClass}">${fmt(payload.effectivePpi, 1)}</div>
          <div class="mt-1 text-[11px] leading-snug text-[var(--figma-color-text-secondary)]">
            Based on image width ÷ (layer width in inches), with 1 Figma px = 1/72 in.
          </div>
        </div>

        <div class="border-t border-[var(--figma-color-border)] pt-3">
          <div class="text-xs text-[var(--figma-color-text-secondary)]">Print width at current size</div>
          <div class="mt-0.5 font-mono">${fmt(payload.printWidthMm, 2)} mm</div>
        </div>
      </section>

      <section class="space-y-3 rounded-xl border border-[var(--figma-color-border)] bg-[var(--figma-color-bg-secondary)] p-3">
        <div>
          <label for="target-ppi" class="text-xs font-medium text-[var(--figma-color-text-secondary)]">Target PPI</label>
          <input
            id="target-ppi"
            type="number"
            min="1"
            step="1"
            value="${initialTarget}"
            class="mt-1 w-full rounded-lg border border-[var(--figma-color-border-strong)] bg-[var(--figma-color-bg)] px-3 py-2 text-sm text-[var(--figma-color-text)] outline-none focus:border-[var(--figma-color-border-selected)] focus:ring-2 focus:ring-[var(--figma-color-border-selected)]"
          />
        </div>
        <div>
          <div class="text-xs text-[var(--figma-color-text-secondary)]">Max print width at target PPI</div>
          <div id="max-print-mm" class="mt-0.5 font-mono"></div>
        </div>
        <button
          id="resize-btn"
          type="button"
          class="w-full rounded-lg bg-[var(--figma-color-bg-brand)] px-3 py-2.5 text-sm font-medium text-[var(--figma-color-text-onbrand)] transition hover:opacity-90 active:opacity-100"
        >
          Resize to Target
        </button>
        <p class="text-[11px] leading-snug text-[var(--figma-color-text-secondary)]">
          Scales the layer so width matches the target PPI (uniform scale; height follows).
        </p>
      </section>
    </div>
  `;

  const input = document.getElementById('target-ppi') as HTMLInputElement | null;
  const maxEl = document.getElementById('max-print-mm');
  const btn = document.getElementById('resize-btn') as HTMLButtonElement | null;

  function updateMax(): void {
    const t = clampTargetPpi(parseFloat(input?.value ?? '300'));
    const maxMm = (payload.originalWidth / t) * 25.4;
    if (maxEl) {
      maxEl.textContent = `${fmt(maxMm, 2)} mm`;
    }
  }

  input?.addEventListener('input', updateMax);
  updateMax();

  btn?.addEventListener('click', () => {
    const t = clampTargetPpi(parseFloat(input?.value ?? '300'));
    parent.postMessage({ pluginMessage: { type: 'resize-to-target', targetPpi: t } }, '*');
  });
}

function handleMessage(event: MessageEvent): void {
  const msg = event.data.pluginMessage as PluginMessage | undefined;
  if (!msg) {
    return;
  }

  if (msg.type === 'inspect') {
    if (!msg.payload) {
      renderEmpty(msg.reason);
      return;
    }
    const saved = document.getElementById('target-ppi') as HTMLInputElement | null;
    const previous = saved ? clampTargetPpi(parseFloat(saved.value)) : 300;
    renderPanel(msg.payload, previous);
    return;
  }

  /* resize-done: errors are surfaced via Figma notify from the main thread */
}

if (app) {
  window.onmessage = handleMessage;
  renderEmpty('Loading…');
}
