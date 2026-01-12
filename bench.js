const { TinyQ } = require('./tinyq.js');

const HOST = process.env.HOST || 'localhost';
const PORT = parseInt(process.env.PORT || '7878');
const CLIENTS = parseInt(process.env.CLIENTS || '10');
const MESSAGES = parseInt(process.env.MESSAGES || '1000');

async function runClient(id) {
    const q = new TinyQ({ host: HOST, port: PORT });
    const queue = `bench-${id}`;

    for (let i = 0; i < MESSAGES; i++) {
        await q.enqueue(queue, `msg-${i}`);
    }

    for (let i = 0; i < MESSAGES; i++) {
        await q.dequeue(queue);
    }

    q.close();
    return MESSAGES * 2;
}

async function main() {
    console.log(`\nTinyQ Benchmark`);
    console.log(`═══════════════════════════════════`);
    console.log(`Host:     ${HOST}:${PORT}`);
    console.log(`Clients:  ${CLIENTS}`);
    console.log(`Messages: ${MESSAGES} per client`);
    console.log(`Total:    ${CLIENTS * MESSAGES * 2} operations`);
    console.log(`───────────────────────────────────\n`);

    const start = performance.now();

    const results = await Promise.all(
        Array(CLIENTS)
            .fill()
            .map((_, i) => runClient(i))
    );

    const elapsed = (performance.now() - start) / 1000;
    const totalOps = results.reduce((a, b) => a + b, 0);
    const opsPerSec = Math.round(totalOps / elapsed);

    console.log(`Time:       ${elapsed.toFixed(2)}s`);
    console.log(`Throughput: ${opsPerSec.toLocaleString()} ops/sec`);
    console.log(`\n═══════════════════════════════════\n`);
}

main().catch(console.error);
