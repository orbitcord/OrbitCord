const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

class NativeBackend {
    constructor(executable, dataDir) {
        this.pending = new Map();
        this.nextId = 0;
        this.child = spawn(executable, ['--data-dir', dataDir], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
        this.child.on('error', error => this.fail(error));
        this.child.on('exit', (code, signal) => this.fail(new Error(`Rust backend exited (${code ?? signal})`)));
        this.child.stdin.on('error', error => this.fail(error));
        this.lines = createInterface({ input: this.child.stdout });
        this.lines.on('line', line => {
            let response;
            try { response = JSON.parse(line); } catch { this.fail(new Error('Invalid Rust response')); return; }
            const request = this.pending.get(response.id);
            if (!request) return;
            this.pending.delete(response.id);
            clearTimeout(request.timer);
            if (response.error) request.reject(new Error(response.error));
            else request.resolve(response.result);
        });
    }

    call(command, args = null) {
        if (this.error) return Promise.reject(this.error);
        if (this.pending.size >= 100) return Promise.reject(new Error('Too many native requests'));
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Rust request timed out: ${command}`));
            }, 8000);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
        });
    }

    fail(error) {
        this.error = error;
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
    }

    close() {
        this.child.stdin.end();
        this.lines.close();
        this.child.kill();
    }
}

module.exports = { NativeBackend };
