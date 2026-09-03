export class SseBroker {
    constructor() {
        this.clientsByJobId = new Map();
    }

    /**
     * Registers a new SSE client for a specific job.
     *
     * @param {string} jobId
     * @param {import('node:http').ServerResponse} res
     */
    addClient(jobId, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });

        // Send initial heartbeat comment
        res.write(': connected\n\n');

        if (!this.clientsByJobId.has(jobId)) {
            this.clientsByJobId.set(jobId, new Set());
        }

        const clients = this.clientsByJobId.get(jobId);
        clients.add(res);

        res.on('close', () => {
            clients.delete(res);
            if (clients.size === 0) {
                this.clientsByJobId.delete(jobId);
            }
        });
    }

    /**
     * Broadcasts an event to all clients watching a given job.
     *
     * @param {string} jobId
     * @param {string} eventType
     * @param {Object} payload
     */
    broadcast(jobId, eventType, payload) {
        const clients = this.clientsByJobId.get(jobId);
        if (!clients || clients.size === 0) return;

        const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
        for (const client of clients) {
            client.write(message);
        }
    }
}
