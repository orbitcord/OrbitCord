(() => {
  // Discord deletes window.localStorage while it starts. Keep the original
  // Storage object for Lowcord's own settings.
  try { window.__lowcordStorage = window.localStorage; } catch {}
  try {
    // Settings left behind by the retired Vencord build.
    for (const key of ["VencordSettings", "lowcord:seeded"]) window.__lowcordStorage?.removeItem(key);
  } catch {}

  const native = window.__LOWCORD_NATIVE__;
  const invoke = (cmd, args) => {
    const calls = {
      notify: () => native.notify(args.title, args.body),
      set_badge: () => native.setBadge(args.count),
      log: () => native.log(args.message),
      open_external: () => native.openExternal(args.url),
    };
    return Promise.resolve().then(calls[cmd]).catch(error => console.error("[Lowcord] Native bridge:", error));
  };

  class LowcordNotification extends EventTarget {
    static permission = "granted";
    static requestPermission(callback) {
      if (typeof callback === "function") callback("granted");
      return Promise.resolve("granted");
    }
    static maxActions = 0;

    constructor(title, options = {}) {
      super();
      this.title = String(title);
      this.body = options.body ?? "";
      this.tag = options.tag ?? "";
      this.icon = options.icon ?? "";
      this.data = options.data;
      this.onclick = this.onclose = this.onerror = this.onshow = null;
      invoke("notify", { title: this.title, body: String(this.body) });
    }
    close() {}
  }
  Object.defineProperty(window, "Notification", {
    value: LowcordNotification,
    writable: true,
    configurable: true,
  });

  let lastBadge = -1;
  const updateBadge = () => {
    const title = document.title;
    const match = /^\((\d+)\)/.exec(title);
    const count = match ? Number(match[1]) : title.startsWith("\u2022") ? -2 : 0;
    if (count === lastBadge) return;
    lastBadge = count;
    invoke("set_badge", { count: count === -2 ? 1 : count });
  };
  const observeTitle = () => {
    const target = document.querySelector("title");
    if (!target) return false;
    new MutationObserver(updateBadge).observe(target, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    updateBadge();
    return true;
  };
  const waitForTitle = () => {
    if (observeTitle()) return;
    const root = new MutationObserver(() => {
      if (observeTitle()) root.disconnect();
    });
    root.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) waitForTitle();
  else document.addEventListener("DOMContentLoaded", waitForTitle, { once: true });

  // Outside Windows, Electron has no passkey prompt: iCloud Keychain and
  // phone (QR) passkeys need Chrome's UI or an Apple browser entitlement, so
  // those requests stay pending forever and block the next login attempt.
  // Disable the invisible autofill request and enforce the request timeout,
  // so Discord shows its passkey error and its QR / password login still work.
  // Plugged-in security keys keep working within that window.
  if (window.PublicKeyCredential && navigator.credentials && !/Windows/.test(navigator.userAgent)) {
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
    const credentials = navigator.credentials;
    for (const method of ["get", "create"]) {
      const original = credentials[method].bind(credentials);
      credentials[method] = (options) => {
        if (!options?.publicKey || options.mediation === "conditional") return original(options);
        const limit = Math.min(Math.max(Number(options.publicKey.timeout) || 60000, 10000), 120000);
        const timeout = AbortSignal.timeout(limit);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        return original({ ...options, signal }).catch((error) => {
          if (!timeout.aborted || options.signal?.aborted) throw error;
          throw new DOMException("No passkey was available. Use a security key, the QR code, or your password.", "NotAllowedError");
        });
      };
    }
  }

  window.__LOWCORD_OPEN_EXTERNAL__ =(url) => invoke("open_external", { url });
  window.__LOWCORD_REPORT__ = () => {
    const report = () => {
      const { Lowcord } = window;
      const on = Lowcord?.extensions?.catalog.filter(({ id }) => Lowcord.extensions.enabled(id)).map(({ id }) => id) ?? [];
      const found = ["React", "createRoot", "CloudUpload", "RestAPI"].filter((name) => Lowcord?.[name]);
      invoke("log", { message: `Notification=${window.Notification.name}; extensions on: ${on.join(", ")}; Discord modules found: ${found.join(", ")}` });
    };
    setTimeout(report, 8000);
  };
})();
