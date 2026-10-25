const os = require('node:os');

// Discord's web gateway reconnects quickly only when the page sees an
// "online" event: it sends an expedited heartbeat, reconnects if the ACK does
// not arrive within 5 seconds, and resets its reconnect backoff. A VPN or
// network switch keeps the link up, so Chromium fires no such event and a
// socket left on the old route sits dead until heartbeats time out. Watching
// the machine's addresses (and waking from sleep, which only Discord's own
// desktop app handles) gives the page that signal.
function watchNetwork({ powerMonitor, onChange, interfaces = os.networkInterfaces, interval = 10_000 }) {
    let last;
    const fingerprint = () => {
        try {
            return Object.entries(interfaces()).flatMap(([name, addresses]) => (addresses ?? [])
                .filter(address => !address.internal).map(address => `${name} ${address.address}`)).sort().join();
        } catch { return last; }
    };
    last = fingerprint();
    const check = () => {
        const next = fingerprint();
        if (next === last) return false;
        last = next;
        onChange('network');
        return true;
    };
    const timer = setInterval(check, interval);
    timer.unref?.();
    const resumed = () => { last = fingerprint(); onChange('resume'); };
    powerMonitor?.on('resume', resumed);
    return {
        check,
        stop() {
            clearInterval(timer);
            powerMonitor?.removeListener('resume', resumed);
        },
    };
}

module.exports = { watchNetwork };
