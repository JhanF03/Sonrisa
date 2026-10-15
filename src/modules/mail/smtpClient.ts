/**
 * Cliente SMTP mínimo (sin dependencias) para enviar correos con una cuenta
 * de Gmail usando una "contraseña de aplicación".
 *
 *   smtp.gmail.com:465 con TLS directo → EHLO → AUTH PLAIN → MAIL/RCPT → DATA → QUIT
 *
 * Funciona igual en Cloudflare Workers (sockets TCP de `cloudflare:sockets`)
 * y en Node (`node:tls`): cada entorno entrega un `OpenSocket` con streams web.
 * El cuerpo va en base64 (UTF-8), así tildes y eñes llegan bien.
 */

export interface MailSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => Promise<void>;
}

export type OpenSocket = (host: string, port: number) => Promise<MailSocket>;

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromName: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
}

export class SmtpError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TIMEOUT_MS = 20_000;

function base64Utf8(value: string): string {
  const bytes = encoder.encode(value);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

const wrap76 = (value: string) => value.replace(/(.{76})/g, '$1\r\n');
const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64Utf8(value)}?=`);
/** Evita inyectar cabeceras con saltos de línea en asuntos o direcciones. */
const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function buildMessage(config: SmtpConfig, mail: OutgoingMail, now = new Date()): string {
  const boundary = `=_as_${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = [
    `From: ${encodeHeader(singleLine(config.fromName))} <${singleLine(config.user)}>`,
    `To: <${singleLine(mail.to)}>`,
    ...(mail.replyTo ? [`Reply-To: <${singleLine(mail.replyTo)}>`] : []),
    `Subject: ${encodeHeader(singleLine(mail.subject))}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@agenda-sonrisa>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    ...headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(mail.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(base64Utf8(mail.html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

class SmtpSession {
  private buffer = '';
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;

  constructor(socket: MailSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** Lee una respuesta completa (varias líneas "250-…" hasta "250 …"). */
  async read(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const newline = this.buffer.indexOf('\r\n');
      if (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 2);
        lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        continue;
      }
      const { value, done } = await withTimeout(this.reader.read());
      if (done) throw new SmtpError('El servidor de correo cerró la conexión.');
      this.buffer += decoder.decode(value, { stream: true });
    }
  }

  async send(line: string, expected: number[], label: string): Promise<string> {
    await this.writer.write(encoder.encode(`${line}\r\n`));
    const response = await this.read();
    if (!expected.includes(response.code)) throw new SmtpError(`${label}: ${response.code} ${response.text.slice(0, 160)}`);
    return response.text;
  }

  async expect(expected: number[], label: string): Promise<void> {
    const response = await this.read();
    if (!expected.includes(response.code)) throw new SmtpError(`${label}: ${response.code} ${response.text.slice(0, 160)}`);
  }

  async release(): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError('El servidor de correo no respondió a tiempo.')), TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new SmtpError(String(error)));
      },
    );
  });
}

export async function sendSmtp(openSocket: OpenSocket, config: SmtpConfig, mail: OutgoingMail): Promise<void> {
  const socket = await openSocket(config.host, config.port);
  const session = new SmtpSession(socket);
  try {
    await session.expect([220], 'Saludo');
    await session.send('EHLO agenda-sonrisa', [250], 'EHLO');
    await session.send(`AUTH PLAIN ${base64Utf8(`\u0000${config.user}\u0000${config.password}`)}`, [235], 'Autenticación (revisa el correo y la contraseña de aplicación)');
    await session.send(`MAIL FROM:<${singleLine(config.user)}>`, [250], 'Remitente');
    await session.send(`RCPT TO:<${singleLine(mail.to)}>`, [250, 251], 'Destinatario');
    await session.send('DATA', [354], 'DATA');
    // Las líneas en base64 nunca empiezan con ".", así que no hace falta "dot-stuffing" en el cuerpo.
    await session.send(`${buildMessage(config, mail)}\r\n.`, [250], 'Envío');
    await session.send('QUIT', [221], 'QUIT').catch(() => undefined);
  } finally {
    await session.release().catch(() => undefined);
    await socket.close().catch(() => undefined);
  }
}
