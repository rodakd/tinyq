const { spawn } = require('child_process');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { TinyQ } = require('./tinyq.js');

const PORT = 17000 + Math.floor(Math.random() * 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = () => new TinyQ({ port: PORT });

let server,
    q,
    testId = 0;

const queue = () => `q${++testId}`;

before(async () => {
    server = spawn('./tinyq-server', [PORT.toString()], { stdio: 'pipe' });
    await sleep(100);
    q = client();
});

after(() => {
    q?.close();
    try {
        server?.kill();
    } catch {}
});

const roundtrip = async (msg) => {
    const name = queue();
    await q.enqueue(name, msg);
    assert.strictEqual(await q.dequeue(name), msg);
};

describe('enqueue', () => {
    test('adds message', () => roundtrip('hello'));
    test('handles unicode', () => roundtrip('日本語 🚀 émojis'));
    test('handles special chars', () => roundtrip('line1\nline2\ttab\r\n\0null'));
    test('handles large messages', () => roundtrip('x'.repeat(100000)));

    test('rejects empty string', async () => {
        await assert.rejects(() => q.enqueue(queue(), ''), /Invalid message length/);
    });
});

describe('dequeue', () => {
    test('returns null on empty', async () => {
        assert.strictEqual(await q.dequeue(queue()), null);
    });

    test('FIFO order', async () => {
        const name = queue();
        await q.enqueue(name, 'a');
        await q.enqueue(name, 'b');
        await q.enqueue(name, 'c');
        assert.strictEqual(await q.dequeue(name), 'a');
        assert.strictEqual(await q.dequeue(name), 'b');
        assert.strictEqual(await q.dequeue(name), 'c');
        assert.strictEqual(await q.dequeue(name), null);
    });
});

describe('list', () => {
    test('empty queue returns []', async () => {
        assert.deepStrictEqual(await q.list(queue()), []);
    });

    test('returns all messages', async () => {
        const name = queue();
        await q.enqueue(name, 'a');
        await q.enqueue(name, 'b');
        assert.deepStrictEqual(await q.list(name), ['a', 'b']);
    });

    test('respects limit', async () => {
        const name = queue();
        await q.enqueue(name, '1');
        await q.enqueue(name, '2');
        await q.enqueue(name, '3');
        assert.deepStrictEqual(await q.list(name, 2), ['1', '2']);
    });

    test('does not consume', async () => {
        const name = queue();
        await q.enqueue(name, 'peek');
        await q.list(name);
        assert.strictEqual(await q.dequeue(name), 'peek');
    });
});

describe('isolation', () => {
    test('queues are separate', async () => {
        const [a, b] = [queue(), queue()];
        await q.enqueue(a, 'A');
        await q.enqueue(b, 'B');
        assert.strictEqual(await q.dequeue(a), 'A');
        assert.strictEqual(await q.dequeue(b), 'B');
    });
});

describe('concurrency', () => {
    test('parallel enqueue', async () => {
        const name = queue();
        const clients = Array(20).fill().map(client);
        await Promise.all(clients.map((c, i) => c.enqueue(name, `${i}`)));
        clients.forEach((c) => c.close());
        assert.strictEqual((await q.list(name)).length, 20);
    });

    test('parallel dequeue', async () => {
        const name = queue();
        for (let i = 0; i < 10; i++) await q.enqueue(name, `${i}`);
        const clients = Array(10).fill().map(client);
        await Promise.all(clients.map((c) => c.dequeue(name)));
        clients.forEach((c) => c.close());
        assert.strictEqual(await q.dequeue(name), null);
    });
});

describe('listen', () => {
    test('receives messages in order', async () => {
        const name = queue();
        const received = [];
        const listener = client();

        const stop = listener.listen({
            queue: name,
            interval: 10,
            onMessage: async (msg) => received.push(msg),
        });

        await q.enqueue(name, 'a');
        await q.enqueue(name, 'b');
        await q.enqueue(name, 'c');
        await sleep(150);

        stop();
        listener.close();
        assert.deepStrictEqual(received, ['a', 'b', 'c']);
    });

    test('stop halts processing', async () => {
        const name = queue();
        const received = [];
        const listener = client();

        const stop = listener.listen({
            queue: name,
            interval: 10,
            onMessage: async (msg) => received.push(msg),
        });

        await q.enqueue(name, 'before');
        await sleep(100);
        stop();
        await q.enqueue(name, 'after');
        await sleep(50);

        listener.close();
        assert.deepStrictEqual(received, ['before']);
        assert.strictEqual(await q.dequeue(name), 'after');
    });

    test('concurrency limits parallel callbacks', async () => {
        const name = queue();
        let active = 0;
        let maxActive = 0;
        const listener = client();

        const stop = listener.listen({
            queue: name,
            interval: 10,
            concurrency: 3,
            onMessage: async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await sleep(50);
                active--;
            },
        });

        for (let i = 0; i < 6; i++) await q.enqueue(name, `${i}`);
        await sleep(400);

        stop();
        listener.close();
        assert.ok(maxActive > 1 && maxActive <= 3, `maxActive=${maxActive}`);
    });
});
