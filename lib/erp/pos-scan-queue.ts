export const POS_SCAN_QUEUE_LIMIT = 32;

export type PosScanQueueItem = {
  captureId: string;
  code: string;
};

export type PosScanEnqueueResult = {
  accepted: boolean;
  reason: "accepted" | "duplicate" | "empty" | "full";
  depth: number;
};

export class PosScanQueue {
  readonly limit: number;
  private readonly pending: PosScanQueueItem[] = [];
  private readonly recentCaptureIds = new Set<string>();
  private readonly recentCaptureOrder: string[] = [];

  constructor(limit = POS_SCAN_QUEUE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("O limite da fila de leituras deve ser um inteiro positivo.");
    this.limit = limit;
  }

  get depth() {
    return this.pending.length;
  }

  enqueue(item: PosScanQueueItem): PosScanEnqueueResult {
    const captureId = item.captureId.trim();
    const code = item.code.trim();
    if (!captureId || !code) return { accepted: false, reason: "empty", depth: this.depth };
    if (this.recentCaptureIds.has(captureId)) return { accepted: false, reason: "duplicate", depth: this.depth };
    if (this.depth >= this.limit) return { accepted: false, reason: "full", depth: this.depth };

    this.pending.push({ captureId, code });
    this.rememberCapture(captureId);
    return { accepted: true, reason: "accepted", depth: this.depth };
  }

  shift() {
    return this.pending.shift() ?? null;
  }

  private rememberCapture(captureId: string) {
    this.recentCaptureIds.add(captureId);
    this.recentCaptureOrder.push(captureId);
    const historyLimit = this.limit * 4;
    while (this.recentCaptureOrder.length > historyLimit) {
      const expired = this.recentCaptureOrder.shift();
      if (expired) this.recentCaptureIds.delete(expired);
    }
  }
}

export async function drainPosScanQueue(
  queue: PosScanQueue,
  process: (item: PosScanQueueItem) => Promise<void>,
) {
  let item = queue.shift();
  while (item) {
    await process(item);
    item = queue.shift();
  }
}
