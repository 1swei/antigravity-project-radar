// Theme detector and adaptive token palette for Shadow DOM overlays.
module.exports = function createAgRadarTheme() {
  const palettes = {
    dark: {
      scheme: 'dark',
      sidebar: '#111114',
      background: '#111114',
      card: '#131317',
      hover: '#24252b',
      foreground: '#ffffff',
      'secondary-fg': '#d4d5dc',
      muted: '#87888f',
      border: '#27282e',
      accent: '#7aa2f7',
      'accent-bg': 'color-mix(in srgb, var(--radar-accent) 14%, transparent)',
      'accent-border': 'color-mix(in srgb, var(--radar-accent) 32%, transparent)',
      success: '#4ade80',
      'success-bg': 'color-mix(in srgb, var(--radar-success) 13%, transparent)',
      'success-border': 'color-mix(in srgb, var(--radar-success) 32%, transparent)',
      warning: '#f3c949',
      'warning-bg': 'color-mix(in srgb, var(--radar-warning) 14%, transparent)',
      'warning-border': 'color-mix(in srgb, var(--radar-warning) 34%, transparent)',
      danger: '#de5555',
      'danger-bg': 'color-mix(in srgb, var(--radar-danger) 14%, transparent)',
      'danger-border': 'color-mix(in srgb, var(--radar-danger) 34%, transparent)',
      shadow: '0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)',
    },
    light: {
      scheme: 'light',
      sidebar: '#f8f9fb',
      background: '#ffffff',
      card: '#ffffff',
      hover: '#eef1f6',
      foreground: '#1e2430',
      'secondary-fg': '#364152',
      muted: '#5f6b7d',
      border: '#d6dce6',
      accent: '#2563eb',
      'accent-bg': 'color-mix(in srgb, var(--radar-accent) 10%, transparent)',
      'accent-border': 'color-mix(in srgb, var(--radar-accent) 28%, transparent)',
      success: '#15803d',
      'success-bg': 'color-mix(in srgb, var(--radar-success) 10%, transparent)',
      'success-border': 'color-mix(in srgb, var(--radar-success) 28%, transparent)',
      warning: '#b45309',
      'warning-bg': 'color-mix(in srgb, var(--radar-warning) 11%, transparent)',
      'warning-border': 'color-mix(in srgb, var(--radar-warning) 30%, transparent)',
      danger: '#b91c1c',
      'danger-bg': 'color-mix(in srgb, var(--radar-danger) 10%, transparent)',
      'danger-border': 'color-mix(in srgb, var(--radar-danger) 28%, transparent)',
      shadow: '0 10px 28px rgba(15, 23, 42, 0.10), 0 2px 6px rgba(15, 23, 42, 0.05)',
    },
  };

  const declarations = theme => Object.entries(palettes[theme]).map(([k, v]) => `--radar-${k}:${v}`).join(';');
  function shadowCss() {
    return `:host{${declarations('dark')}}:host([data-radar-theme="light"]){${declarations('light')}}`;
  }

  function normalizeHostTheme(value) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    if (['dark', 'light', 'system'].includes(value.mode)) result.mode = value.mode;
    for (const mode of ['dark', 'light']) {
      for (const key of ['primary', 'background', 'foregroundOverride']) {
        const color = value[mode]?.[key];
        if (typeof color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) continue;
        (result[mode] ||= {})[key] = (color.length === 4 ? '#' + Array.from(color.slice(1), v => v + v).join('') : color).toLowerCase();
      }
    }
    return result;
  }

  function attach(targetsProvider) {
    const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (canvas) { canvas.width = canvas.height = 1; }
    const ctx = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
    let hostTheme = {};
    let stopped = false;

    function rgb(color) {
      if (!color || !ctx || typeof CSS === 'undefined' || !CSS.supports('color', color)) return null;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = 'transparent';
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (a < 250) return null;
      return [r, g, b];
    }

    function parseRgba(color, backdrop) {
      const m = String(color || '').trim().match(/^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)(?:\s*[,/]\s*([0-9.]+%?))?\s*\)$/i);
      if (!m) return null;
      const r = Number(m[1]);
      const g = Number(m[2]);
      const b = Number(m[3]);
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a) || a <= 0) return null;
      const base = backdrop || [255, 255, 255];
      return `rgb(${Math.round(base[0] * (1 - a) + r * a)} ${Math.round(base[1] * (1 - a) + g * a)} ${Math.round(base[2] * (1 - a) + b * a)})`;
    }

    function fromColor(color) {
      const v = rgb(color);
      return v ? (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] >= 145 ? 'light' : 'dark') : null;
    }

    function explicit(el) {
      if (!el) return null;
      for (const key of ['data-theme', 'data-color-mode', 'data-theme-mode', 'data-vscode-theme-kind']) {
        const value = el.getAttribute(key)?.toLowerCase();
        if (/^(light|light-theme|vs|vscode-light|hc-light)$/.test(value)) return 'light';
        if (/^(dark|dark-theme|vs-dark|vscode-dark|hc-black|hc-dark)$/.test(value)) return 'dark';
      }
      if (el.classList?.contains('light')) return 'light';
      if (el.classList?.contains('dark')) return 'dark';
      return null;
    }

    function resolve() {
      const root = document.documentElement;
      const body = document.body;
      const declared = explicit(body) || explicit(root);
      if (declared) return declared;
      const rootStyle = getComputedStyle(root);
      const sdk = fromColor(rootStyle.getPropertyValue('--background').trim());
      if (sdk) return sdk;
      const nav = document.querySelector('[role="navigation"][aria-label="Sidebar"]');
      if (nav) {
        const navTheme = fromColor(getComputedStyle(nav).backgroundColor);
        if (navTheme) return navTheme;
      }
      if (hostTheme.mode === 'light' || hostTheme.mode === 'dark') return hostTheme.mode;
      return media?.matches ? 'dark' : 'light';
    }

    function hostVar(names, backdropRgb = null) {
      const nav = document.querySelector('[role="navigation"][aria-label="Sidebar"]');
      for (const el of [nav, document.body, document.documentElement].filter(Boolean)) {
        const s = getComputedStyle(el);
        for (const name of names) {
          const val = s.getPropertyValue(name)?.trim();
          if (!val) continue;
          if (rgb(val)) return val;
          if (backdropRgb) {
            const composited = parseRgba(val, backdropRgb);
            if (composited) return composited;
          }
        }
      }
      return null;
    }

    function update() {
      if (stopped) return 'dark';
      const theme = resolve();
      const sidebarBg = hostVar(['--sidebar', '--color-sidebar']) || palettes[theme].sidebar;
      const cardBg = hostVar(['--popover', '--card', '--color-card']) || palettes[theme].card;
      const cardRgb = rgb(cardBg) || rgb(palettes[theme].card);
      const borderCol = hostVar(['--card-border', '--border'], cardRgb) || palettes[theme].border;
      const fgCol = hostVar(['--foreground', '--color-foreground']) || palettes[theme].foreground;
      const secFgCol = hostVar(['--secondary-foreground'], cardRgb) || palettes[theme]['secondary-fg'];
      const mutedCol = hostVar(['--muted-foreground'], cardRgb) || palettes[theme].muted;
      const hoverBg = hostVar(['--secondary', '--muted'], cardRgb) || palettes[theme].hover;
      const accentCol = hostVar(['--primary', '--color-primary']) || hostTheme[theme]?.primary || palettes[theme].accent;
      const successCol = hostVar(['--success']) || palettes[theme].success;
      const warningCol = hostVar(['--warning']) || palettes[theme].warning;
      const dangerCol = hostVar(['--error', '--destructive']) || palettes[theme].danger;

      const rootStyle = getComputedStyle(document.documentElement);
      const bodyStyle = document.body ? getComputedStyle(document.body) : null;
      const cleanFont = v => { const s = String(v || '').trim(); return s && s !== 'inherit' && s !== 'initial' ? s : ''; };
      const font = cleanFont(bodyStyle?.fontFamily)
        || cleanFont(rootStyle.getPropertyValue('--font-sans'))
        || '"Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const mono = cleanFont(rootStyle.getPropertyValue('--editor-font-family'))
        || cleanFont(rootStyle.getPropertyValue('--font-mono'))
        || 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

      const targets = typeof targetsProvider === 'function' ? targetsProvider() : [targetsProvider].filter(Boolean);
      for (const target of targets) {
        if (!target) continue;
        if (target.dataset.radarTheme !== theme) target.dataset.radarTheme = theme;
        const setVar = (k, v) => { if (target.style.getPropertyValue(k) !== v) target.style.setProperty(k, v); };
        setVar('--radar-sidebar', sidebarBg);
        setVar('--radar-card', cardBg);
        setVar('--radar-border', borderCol);
        setVar('--radar-foreground', fgCol);
        setVar('--radar-secondary-fg', secFgCol);
        setVar('--radar-muted', mutedCol);
        setVar('--radar-hover', hoverBg);
        setVar('--radar-accent', accentCol);
        setVar('--radar-success', successCol);
        setVar('--radar-warning', warningCol);
        setVar('--radar-danger', dangerCol);
        setVar('--radar-font', font);
        setVar('--radar-mono', mono);
      }
      return theme;
    }

    const observer = new MutationObserver(update);
    for (const el of [document.documentElement, document.body].filter(Boolean)) {
      observer.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-mode', 'data-theme-mode', 'data-agy-font', 'data-agy-theme', 'data-newux-theme'] });
    }
    media?.addEventListener?.('change', update);
    const timer = setInterval(update, 1500);
    timer.unref?.();
    update();

    return {
      update,
      setHostTheme(value) { hostTheme = normalizeHostTheme(value); return update(); },
      dispose() { stopped = true; observer.disconnect(); media?.removeEventListener?.('change', update); clearInterval(timer); },
    };
  }

  return { shadowCss, attach, normalizeHostTheme };
};
