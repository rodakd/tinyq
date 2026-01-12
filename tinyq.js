const net = require('net');

class TinyQ {
    #host;
    #port;
    #socket = null;
    #buffer = Buffer.alloc(0);
    #pending = null;

    constructor(options = {}) {
        this.#host = options.host || 'localhost';
        this.#port = options.port || 7878;
    }

    enqueue(queue, message) {
        const msgBuf = Buffer.from(message);
        return this.#request(
            (socket) => {
                socket.write(`ENQUEUE ${queue}\n${msgBuf.length}\n`);
                socket.write(msgBuf);
            },
            (buf) => {
                const str = buf.toString();
                const idx = str.indexOf('\n');
                if (idx === -1) return undefined;
                const line = str.slice(0, idx);
                if (line.startsWith('OK')) return true;
                return new Error(line.replace('ERR ', ''));
            }
        );
    }

    dequeue(queue) {
        return this.#request(
            (socket) => socket.write(`DEQUEUE ${queue}\n`),
            (buf) => {
                const str = buf.toString();
                const idx = str.indexOf('\n');
                if (idx === -1) return undefined;
                const line = str.slice(0, idx);
                if (line === 'ERR Queue empty') return null;
                if (line.startsWith('ERR')) return new Error(line.replace('ERR ', ''));
                const len = parseInt(line.split(' ')[1], 10);
                if (buf.length < idx + 1 + len) return undefined;
                return buf.slice(idx + 1, idx + 1 + len).toString();
            }
        );
    }

    list(queue, limit) {
        const cmd = limit ? `LIST ${queue} ${limit}\n` : `LIST ${queue}\n`;
        return this.#request(
            (socket) => socket.write(cmd),
            (buf) => {
                const str = buf.toString();
                const firstNl = str.indexOf('\n');
                if (firstNl === -1) return undefined;

                const firstLine = str.slice(0, firstNl);
                if (firstLine.startsWith('ERR')) return new Error(firstLine.replace('ERR ', ''));

                const count = parseInt(firstLine.split(' ')[1], 10);
                if (count === 0) return [];

                const messages = [];
                let pos = firstNl + 1;

                for (let i = 0; i < count; i++) {
                    const nlPos = str.indexOf('\n', pos);
                    if (nlPos === -1) return undefined;
                    const len = parseInt(str.slice(pos, nlPos), 10);
                    const dataStart = nlPos + 1;
                    if (buf.length < dataStart + len) return undefined;
                    messages.push(buf.slice(dataStart, dataStart + len).toString());
                    pos = dataStart + len;
                }

                return messages;
            }
        );
    }

    listen({ queue, onMessage, interval = 100, concurrency = 1 }) {
        let running = true;
        let active = 0;

        const poll = async () => {
            while (running) {
                if (active >= concurrency) {
                    await new Promise((r) => setTimeout(r, 10));
                    continue;
                }

                try {
                    const msg = await this.dequeue(queue);
                    if (msg !== null) {
                        active++;
                        onMessage(msg)
                            .catch((err) => console.error('[TinyQ] listen error:', err))
                            .finally(() => active--);
                    } else {
                        await new Promise((r) => setTimeout(r, interval));
                    }
                } catch (err) {
                    if (running) {
                        console.error('[TinyQ] listen dequeue error:', err);
                        await new Promise((r) => setTimeout(r, interval));
                    }
                }
            }
        };

        poll();

        return () => {
            running = false;
        };
    }

    close() {
        if (this.#socket) {
            this.#socket.end();
            this.#socket = null;
        }
    }

    #connect() {
        if (this.#socket) return Promise.resolve();

        return new Promise((resolve, reject) => {
            this.#socket = net.createConnection({ host: this.#host, port: this.#port });
            this.#socket.on('connect', resolve);

            this.#socket.on('error', (err) => {
                this.#socket = null;
                if (this.#pending) {
                    this.#pending.reject(err);
                    this.#pending = null;
                }
                reject(err);
            });

            this.#socket.on('close', () => {
                this.#socket = null;
                if (this.#pending) {
                    this.#pending.reject(new Error('Connection closed'));
                    this.#pending = null;
                }
            });

            this.#socket.on('data', (chunk) => {
                this.#buffer = Buffer.concat([this.#buffer, chunk]);
                this.#tryParse();
            });
        });
    }

    #tryParse() {
        if (!this.#pending) return;
        const result = this.#pending.parse(this.#buffer);
        if (result !== undefined) {
            const { resolve, reject } = this.#pending;
            this.#pending = null;
            this.#buffer = Buffer.alloc(0);
            if (result instanceof Error) reject(result);
            else resolve(result);
        }
    }

    async #request(write, parse) {
        await this.#connect();
        return new Promise((resolve, reject) => {
            this.#pending = { resolve, reject, parse };
            write(this.#socket);
        });
    }
}

module.exports = { TinyQ };
