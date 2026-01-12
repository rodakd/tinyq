# TinyQ

A blazing fast, in-memory message queue in **~400 lines of C**.

## Features

-   ⚡ **Fast** — 100,000+ ops/sec
-   🪶 **Tiny** — ~400 lines of C, ~5MB Docker image
-   🔒 **Thread-safe** — per-queue locking for concurrent access
-   🔌 **Simple protocol** — text-based TCP, easy to implement clients
-   📦 **No dependencies** — just libc and pthreads

## Quick Start

```bash
# Build & run
make && ./tinyq-server

# Or with Docker
docker build -t tinyq .
docker run -p 7878:7878 tinyq
```

## JavaScript Client

```javascript
const { TinyQ } = require('./tinyq.js');

const q = new TinyQ({ host: 'localhost', port: 7878 });

await q.enqueue('jobs', 'Process payment #1234');
await q.enqueue('jobs', 'Send confirmation email');

const messages = await q.list('jobs'); // ['Process payment #1234', 'Send confirmation email']
const first = await q.dequeue('jobs'); // 'Process payment #1234'

// Listen for messages (polling)
const stopListening = q.listen({
    queue: 'jobs',
    concurrency: 10,
    onMessage: async (msg) => {
        console.log('Received:', msg);
        await handle(msg);
        console.log('Done:', msg);
    },
});

stopListening();
```

## Protocol

Dead simple text protocol over TCP. Easy to implement in any language.

```
ENQUEUE <queue>\n<length>\n<payload>    →  OK\n
DEQUEUE <queue>\n                       →  OK <length>\n<payload>
LIST <queue> [limit]\n                  →  OK <count>\n[<len>\n<payload>]...
```

## Benchmarks

Tested on **MacBook Pro 2020 M1** (8-core, 16GB RAM):

| Clients | Operations | Time  | Throughput       |
| ------: | ---------: | ----- | ---------------- |
|      10 |     20,000 | 0.24s | ~84,000 ops/sec  |
|      25 |     50,000 | 0.50s | ~99,000 ops/sec  |
|      50 |    100,000 | 0.87s | ~115,000 ops/sec |
|     100 |    200,000 | 1.70s | ~117,000 ops/sec |

Run your own benchmark:

```bash
CLIENTS=50 MESSAGES=1000 node bench.js
```

## License

MIT
