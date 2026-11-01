// Pure privacy state machines, shared by the production page and Node tests.
(() => {
    const id = value => typeof value === 'string' && /^\d{1,24}$/.test(value);
    class ExpiryQueue {
        constructor({ owner, load = () => null, save, remove, now = Date.now, changed = () => {} }) {
            if (!id(owner)) throw new Error('An account is required for message expiry');
            Object.assign(this, { owner, save, remove, now, changed });
            this.state = { rules: [], messages: [] }; this.running = false; this.lastError = '';
            try {
                const saved = load();
                if (saved?.owner === owner && Array.isArray(saved.rules) && Array.isArray(saved.messages)) {
                    this.state.rules = saved.rules.filter(rule => this.validRule(rule)).slice(0, 100);
                    this.state.messages = saved.messages.filter(m => id(m.id) && id(m.channel) && Number.isFinite(m.deadline)
                        && Number.isFinite(m.created) && Number.isFinite(m.retryAt ?? 0) && typeof m.rule === 'string').slice(0, 10_000);
                }
            } catch { this.lastError = 'Could not read saved expiry rules.'; }
        }
        validRule(rule) {
            return rule && typeof rule.id === 'string' && rule.id.length < 100 && ['channel', 'server'].includes(rule.scope)
                && id(rule.target) && Number.isSafeInteger(rule.hours) && rule.hours >= 1 && rule.hours <= 8760
                && Number.isFinite(rule.since) && typeof rule.attachmentsOnly === 'boolean';
        }
        persist() {
            try { this.save({ owner: this.owner, ...this.state }); this.storageError = false; }
            catch (error) { this.storageError = true; this.lastError = 'Could not save expiry state. Cleanup is paused.'; throw error; }
            this.changed();
        }
        addRule(rule) {
            const next = { ...rule, since: this.now(), attachmentsOnly: rule.attachmentsOnly === true };
            if (!this.validRule(next) || this.state.rules.length >= 100) throw new Error('Invalid expiry rule or too many rules');
            this.state.rules = [...this.state.rules.filter(r => r.id !== next.id), next]; this.persist(); return next;
        }
        removeRule(ruleId) {
            this.state.rules = this.state.rules.filter(r => r.id !== ruleId);
            this.state.messages = this.state.messages.filter(m => m.rule !== ruleId); this.persist();
        }
        observe(message) {
            if (message?.author?.id !== this.owner || !id(message.id) || !id(message.channel_id) || this.state.messages.some(m => m.id === message.id)) return false;
            // A channel rule takes precedence over a server rule, even when it
            // doesn't match the attachment filter. Never fall back unexpectedly.
            const rule = this.state.rules.find(r => r.scope === 'channel' && r.target === message.channel_id)
                ?? this.state.rules.find(r => r.scope === 'server' && r.target === message.guild_id);
            const created = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp);
            if (!rule || !Number.isFinite(created) || created < rule.since || rule.attachmentsOnly && !message.attachments?.length) return false;
            if (this.state.messages.length >= 10_000) throw new Error('Expiry tracking is full. Review queued messages before adding more.');
            this.state.messages.push({ id: message.id, channel: message.channel_id, created,
                deadline: created + rule.hours * 3600_000, rule: rule.id, preserved: false, retryAt: 0 });
            this.persist(); return true;
        }
        preserve(messageId, value = true) {
            const message = this.state.messages.find(m => m.id === messageId);
            if (!message) return false;
            message.preserved = Boolean(value); this.persist(); return true;
        }
        activeRules() { return new Set(this.state.rules.map(r => r.id)); }
        nextDelay() {
            const rules = this.activeRules();
            const times = this.state.messages.filter(m => !m.preserved && rules.has(m.rule))
                .map(m => Math.max(m.deadline, m.retryAt ?? 0));
            return times.length ? Math.max(1000, Math.min(60_000, Math.min(...times) - this.now())) : 60_000;
        }
        async tick() {
            if (this.running) return;
            if (this.storageError) throw new Error('Expiry storage is unavailable');
            this.running = true;
            try {
                // One delete per wake: no history crawls or bursts on startup.
                const rules = this.activeRules(), now = this.now();
                const message = this.state.messages.find(m => !m.preserved && m.deadline <= now && (m.retryAt ?? 0) <= now && rules.has(m.rule));
                if (!message) return;
                try {
                    await this.remove(message, this.owner, this.state.rules.find(r => r.id === message.rule));
                    this.state.messages = this.state.messages.filter(m => m !== message); this.lastError = '';
                } catch (error) {
                    const status = error?.status;
                    if (status === 404) this.state.messages = this.state.messages.filter(m => m !== message);
                    else {
                        const retry = Number(error?.body?.retry_after);
                        const delay = status === 429 && Number.isFinite(retry) ? Math.max(1000, retry * 1000) : 60_000;
                        message.retryAt = this.now() + delay;
                        if (status === 429 && error?.body?.global) {
                            for (const queued of this.state.messages) queued.retryAt = Math.max(queued.retryAt ?? 0, message.retryAt);
                        }
                        if (status === 403 || error?.code === 'ownership') message.preserved = true;
                        this.lastError = status === 403 || error?.code === 'ownership'
                            ? 'A message could not be verified or deleted and has been preserved.' : 'Expiry cleanup will retry when Discord is available.';
                    }
                }
                this.persist();
            } finally { this.running = false; }
        }
    }
    // Totals only: never names, links or message text. Saved in batches, because
    // some of these count every analytics request.
    const reportKeys = ['analytics', 'typing', 'links', 'images', 'videos', 'files', 'expired', 'covered', 'downloads', 'walkAway'];
    class PrivacyReport {
        constructor({ load = () => null, save, now = Date.now, delay = 30_000 }) {
            Object.assign(this, { save, now, delay });
            const saved = load();
            this.since = Number.isSafeInteger(saved?.since) ? saved.since : now();
            this.totals = Object.fromEntries(reportKeys.map(key => [key, Number.isSafeInteger(saved?.totals?.[key]) ? Math.max(0, saved.totals[key]) : 0]));
            this.timer = null;
        }
        add(key, amount = 1) {
            if (!reportKeys.includes(key) || !Number.isSafeInteger(amount) || amount < 1) return;
            this.totals[key] += amount;
            this.timer ??= setTimeout(() => this.flush(), this.delay);
        }
        flush() {
            clearTimeout(this.timer); this.timer = null;
            this.save({ since: this.since, totals: this.totals });
        }
        reset() {
            for (const key of reportKeys) this.totals[key] = 0;
            this.since = this.now(); this.flush();
        }
    }
    const api = { ExpiryQueue, PrivacyReport };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else window.LowcordPrivacyCore = api;
})();
