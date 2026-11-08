import type { FastifyReply } from 'fastify';
import type { WebTurnEvent } from './web-types.js';

const HEARTBEAT_MS = 15_000;

export function createEventStream(reply: FastifyReply) {
  const response = reply.raw;
  let started = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let disconnect: (() => void) | undefined;

  const write = (frame: string) => {
    if (!response.destroyed && !response.writableEnded) response.write(frame);
  };
  return {
    open(onDisconnect: () => void) {
      reply.hijack();
      started = true;
      if (response.destroyed || response.writableEnded) {
        onDisconnect();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      disconnect = () => {
        if (!response.writableEnded) onDisconnect();
      };
      response.once('close', disconnect);
      heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
    },
    send(event: WebTurnEvent) {
      write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    },
    close() {
      if (heartbeat) clearInterval(heartbeat);
      if (disconnect) response.off('close', disconnect);
      if (started && !response.destroyed && !response.writableEnded) response.end();
    },
  };
}
