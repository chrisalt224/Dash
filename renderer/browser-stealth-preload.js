// browser-stealth-preload.js
// Webview preload script — runs in the webview's isolated world before any
// page scripts. Injects a <script> into the page's main world that hides
// the most-probed "embedded browser / automation" signals.
//
// This is best-effort. Google's CEF detection is multi-layered and they
// keep escalating; some checks (process tree, command-line flags) can't be
// hidden from JS.

const STEALTH = `
(function () {
  'use strict';
  const safe = (fn) => { try { fn(); } catch (e) {} };

  // navigator.webdriver — most common "this is automation" signal
  safe(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      configurable: true,
      get: () => false,
    });
  });

  // navigator.plugins — empty arrays are suspicious (real Chrome has the PDF viewer)
  safe(() => {
    const items = [
      { name: 'PDF Viewer',                filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer',         filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chromium PDF Viewer',       filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'WebKit built-in PDF',       filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    ];
    items.item = (i) => items[i] || null;
    items.namedItem = (n) => items.find((p) => p.name === n) || null;
    items.refresh = () => {};
    Object.defineProperty(Navigator.prototype, 'plugins', { get: () => items });
  });

  // navigator.languages — a single language is a yellow flag
  safe(() => {
    Object.defineProperty(Navigator.prototype, 'languages', {
      get: () => ['en-US', 'en'],
    });
  });

  // navigator.platform — explicitly Win32 (in case Electron's value drifts)
  safe(() => {
    Object.defineProperty(Navigator.prototype, 'platform', {
      get: () => 'Win32',
    });
  });

  // window.chrome — real Chrome exposes runtime / loadTimes / csi / app.
  // Bot checks look for the presence of window.chrome.runtime specifically.
  safe(() => {
    const c = window.chrome || {};
    if (!c.runtime) {
      c.runtime = {
        OnInstalledReason:        { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason:  { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch:             { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch:         { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs:               { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      };
    }
    if (!c.loadTimes) c.loadTimes = function () { return {}; };
    if (!c.csi) c.csi = function () { return {}; };
    if (!c.app) c.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
    window.chrome = c;
  });

  // Permissions API — should be consistent with Notification.permission
  safe(() => {
    if (window.navigator.permissions && window.navigator.permissions.query) {
      const original = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = (parameters) =>
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'default' })
          : original(parameters);
    }
  });

  // WebGL fingerprinting — many bot checks read UNMASKED_VENDOR/RENDERER
  safe(() => {
    const VENDOR = 37445, RENDERER = 37446;
    const fakeVendor = 'Intel Inc.';
    const fakeRenderer = 'Intel(R) Iris(TM) Plus Graphics 640';
    const get = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === VENDOR) return fakeVendor;
      if (p === RENDERER) return fakeRenderer;
      return get.call(this, p);
    };
    if (window.WebGL2RenderingContext) {
      const get2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (p) {
        if (p === VENDOR) return fakeVendor;
        if (p === RENDERER) return fakeRenderer;
        return get2.call(this, p);
      };
    }
  });

  // Make our shimmed function toString look native — some checks call
  // .toString() on navigator getters and look for "function() { ... }" body
  safe(() => {
    const nativeFnToString = Function.prototype.toString;
    const webdriverGetter = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get;
    Function.prototype.toString = function () {
      if (this === webdriverGetter) return 'function get webdriver() { [native code] }';
      return nativeFnToString.call(this);
    };
  });

  // Hairline-feature trick used by some legacy fingerprint libs
  safe(() => {
    const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
      get: function () {
        if (this.id === 'modernizr') return 1;
        return heightDesc.get.apply(this);
      },
    });
  });
})();
`;

const inject = () => {
  try {
    const s = document.createElement('script');
    s.textContent = STEALTH;
    // documentElement always exists by document_start; head may not yet
    (document.head || document.documentElement).appendChild(s);
    if (s.parentNode) s.parentNode.removeChild(s);
  } catch (e) {
    // Last-ditch: shouldn't happen, but don't break the page
    console.error('[stealth] inject failed:', e);
  }
};

inject();
