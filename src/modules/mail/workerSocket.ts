/** Socket TCP con TLS para Cloudflare Workers (solo se importa desde worker.ts). */
import { connect } from 'cloudflare:sockets';
import type { OpenSocket } from './smtpClient.js';

export const openWorkerSocket: OpenSocket = async (host, port) => {
  const socket = connect({ hostname: host, port }, { secureTransport: 'on', allowHalfOpen: false });
  await socket.opened;
  return { readable: socket.readable, writable: socket.writable, close: () => socket.close() };
};
