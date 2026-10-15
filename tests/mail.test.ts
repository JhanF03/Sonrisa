/**
 * Correos automáticos con Gmail, comprobantes de pago, recordatorios,
 * recuperación de contraseña y textos legales. El servidor SMTP se simula.
 */
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import type { MailSocket, OpenSocket } from '../src/modules/mail/smtpClient.js';
import { buildMessage } from '../src/modules/mail/smtpClient.js';
import { addDays, todayLocal } from '../src/utils/time.js';
import { createTestEnvironment, PLATFORM_KEY, TEST_PASSWORD } from './helpers.js';

type TestEnvironment = Awaited<ReturnType<typeof createTestEnvironment>>;

interface CapturedMail {
  to: string;
  subject: string;
  text: string;
  html: string;
  raw: string;
}

const APP_PASSWORD = 'abcdefghijklmnop';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Servidor SMTP falso: acepta solo la contraseña de aplicación correcta y guarda los mensajes. */
function fakeGmail() {
  const inbox: CapturedMail[] = [];
  const connections: Array<{ host: string; port: number }> = [];
  const decodePart = (raw: string, type: string) => {
    const match = raw.match(new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`));
    return match ? Buffer.from((match[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
  };
  const decodeSubject = (raw: string) => {
    const header = raw.match(/^Subject: (.*)$/m)?.[1] ?? '';
    const encoded = header.match(/^=\?UTF-8\?B\?(.+)\?=$/);
    return encoded ? Buffer.from(encoded[1] ?? '', 'base64').toString('utf8') : header;
  };

  const openSocket: OpenSocket = async (host, port) => {
    connections.push({ host, port });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start: (value) => void (controller = value) });
    const reply = (line: string) => { if (process.env.SMTP_DEBUG) console.log('S:', line); controller.enqueue(encoder.encode(`${line}\r\n`)); };
    let buffer = '';
    let inData = false;
    let recipient = '';
    const handle = () => {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          inData = false;
          inbox.push({ to: recipient, subject: decodeSubject(raw), text: decodePart(raw, 'text/plain'), html: decodePart(raw, 'text/html'), raw });
          reply('250 2.0.0 OK');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (process.env.SMTP_DEBUG) console.log('C:', line.slice(0, 50));
        if (line.startsWith('EHLO')) {
          reply('250-smtp.gmail.com at your service');
          reply('250 AUTH LOGIN PLAIN');
        } else if (line.startsWith('AUTH PLAIN ')) {
          const [, , password] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          // eslint-disable-next-line security/detect-possible-timing-attacks -- servidor falso de pruebas
          if (password === APP_PASSWORD) reply('235 2.7.0 Accepted');
          else {
            reply('535-5.7.8 Username and Password not accepted.');
            reply('535 5.7.8 https://support.google.com/mail/?p=BadCredentials');
          }
        } else if (line.startsWith('MAIL FROM:')) reply('250 2.1.0 OK');
        else if (line.startsWith('RCPT TO:')) {
          recipient = line.slice(9).replace(/[<>]/g, '');
          reply('250 2.1.5 OK');
        } else if (line === 'DATA') {
          inData = true;
          reply('354 Go ahead');
        } else if (line === 'QUIT') reply('221 2.0.0 closing connection');
      }
    };
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        buffer += decoder.decode(chunk);
        handle();
      },
    });
    reply('220 smtp.gmail.com ESMTP ready');
    const socket: MailSocket = { readable, writable, close: async () => { try { controller.close(); } catch { /* ya cerrado */ } } };
    return socket;
  };
  return { inbox, connections, openSocket };
}

describe('Correo automático, comprobantes y datos legales', () => {
  let env: TestEnvironment;
  let platformCookie = '';
  const gmail = fakeGmail();
  let ipCounter = 0;
  const fresh = () => ({ 'X-Real-IP': `correo-${++ipCounter}` });
  const cookieOf = (response: { headers: Headers }) => (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const platform = (method: string, path: string, body?: unknown) => env.request(method, path, { cookie: platformCookie, body });
  const flush = () => env.app.services.mail.flush();
  const mailsTo = (address: string) => gmail.inbox.filter((mail) => mail.to === address);

  let clinic = { tenantId: '', cookie: '' };

  before(async () => {
    env = await createTestEnvironment({ openSocket: gmail.openSocket });
    await env.request('POST', '/api/platform/setup', { body: { masterKey: PLATFORM_KEY, fullName: 'Jhan', email: 'dueno-correo@agenda.co', password: TEST_PASSWORD }, headers: fresh() });
    platformCookie = cookieOf(await env.request('POST', '/api/platform/login', { body: { email: 'dueno-correo@agenda.co', password: TEST_PASSWORD }, headers: fresh() }));
  });

  it('sin Gmail configurado, el registro funciona y el correo queda como "omitido"', async () => {
    const signup = await env.request('POST', '/api/public/signup', {
      headers: fresh(),
      body: { clinicName: 'Sin Correo', fullName: 'Ana', email: 'ana@sincorreo.co', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true },
    });
    assert.equal(signup.status, 201, signup.text);
    await flush();
    assert.equal(gmail.connections.length, 0);
    const log = (await platform('GET', '/api/platform/email-log')).json;
    assert.ok(log.some((entry: { kind: string; status: string }) => entry.kind === 'bienvenida' && entry.status === 'omitido'));
  });

  it('el dueño guarda su Gmail; la contraseña de aplicación queda cifrada y nunca se devuelve', async () => {
    const invalid = await platform('PUT', '/api/platform/settings/mail', { smtpUser: 'dueno@gmail.com', smtpPassword: 'corta', smtpFromName: 'Agenda Sonrisa', notifyOwner: true });
    assert.equal(invalid.status, 400, 'La contraseña de aplicación de Google tiene 16 letras');
    const saved = await platform('PUT', '/api/platform/settings/mail', { smtpUser: 'Dueno@Gmail.com', smtpPassword: 'abcd efgh ijkl mnop', smtpFromName: 'Agenda Sonrisa', notifyOwner: true });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.configured, true);
    assert.equal(saved.json.smtpUser, 'dueno@gmail.com');
    assert.doesNotMatch(JSON.stringify(saved.json), new RegExp(APP_PASSWORD));
    const stored = await env.db.prepare('SELECT smtp_password_enc FROM platform_settings WHERE id = 1').first<{ smtp_password_enc: string }>();
    assert.ok(stored?.smtp_password_enc && !stored.smtp_password_enc.includes(APP_PASSWORD), 'Cifrada en la base');

    // Cambiar el nombre sin reescribir la contraseña la conserva.
    const kept = await platform('PUT', '/api/platform/settings/mail', { smtpUser: 'dueno@gmail.com', smtpPassword: null, smtpFromName: 'Mi Software', notifyOwner: true });
    assert.equal(kept.json.configured, true);
    assert.equal((await env.request('GET', '/api/platform/settings/mail')).status, 401, 'Solo el dueño');
  });

  it('el correo de prueba llega por smtp.gmail.com:465 y un error se explica', async () => {
    const test = await platform('POST', '/api/platform/settings/mail/test', { to: 'yo@gmail.com' });
    assert.equal(test.status, 200, test.text);
    assert.deepEqual(gmail.connections.at(-1), { host: 'smtp.gmail.com', port: 465 });
    assert.equal(mailsTo('yo@gmail.com').length, 1);

    await platform('PUT', '/api/platform/settings/mail', { smtpUser: 'dueno@gmail.com', smtpPassword: 'zzzzyyyyxxxxwwww', smtpFromName: 'Mi Software', notifyOwner: true });
    const failed = await platform('POST', '/api/platform/settings/mail/test', { to: 'yo@gmail.com' });
    assert.equal(failed.status, 422);
    assert.match(failed.json.error.message, /contraseña de aplicación/);
    await platform('PUT', '/api/platform/settings/mail', { smtpUser: 'dueno@gmail.com', smtpPassword: APP_PASSWORD, smtpFromName: 'Mi Software', notifyOwner: true });
  });

  it('los datos legales y el aviso de IVA se publican para el sitio y el consultorio', async () => {
    const saved = await platform('PUT', '/api/platform/settings/legal', {
      legalName: 'Jhan Pérez', legalId: 'CC 1.000.000', legalCity: 'Medellín', legalEmail: 'datos@agenda.co',
      taxRegime: 'no_responsable_iva', uvtValue: 52374, publicUrl: 'https://agenda.example.co/',
    });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.publicUrl, 'https://agenda.example.co');
    const legal = await env.request('GET', '/api/public/legal');
    assert.equal(legal.status, 200);
    assert.equal(legal.json.providerName, 'Jhan Pérez');
    assert.match(legal.json.taxNotice, /no responsable de IVA/);
    assert.match(legal.json.termsVersion, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('registro en línea: bienvenida al consultorio y aviso al dueño, con enlaces a la dirección pública', async () => {
    const signup = await env.request('POST', '/api/public/signup', {
      headers: fresh(),
      body: { clinicName: 'Sonrisa Feliz', fullName: 'Laura Gómez', email: 'laura@feliz.co', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true },
    });
    assert.equal(signup.status, 201, signup.text);
    clinic = { tenantId: (await env.db.prepare("SELECT id FROM tenants WHERE name = 'Sonrisa Feliz'").first<{ id: string }>())!.id, cookie: cookieOf(signup) };
    await flush();
    const [welcome] = mailsTo('laura@feliz.co');
    assert.ok(welcome, 'Llega la bienvenida');
    assert.match(welcome.subject, /Sonrisa Feliz/);
    assert.match(welcome.html, /https:\/\/agenda\.example\.co\/app/);
    assert.match(welcome.html, /legal\/terminos/);
    assert.ok(mailsTo('datos@agenda.co').some((mail) => /Nuevo consultorio/.test(mail.subject)), 'El dueño se entera');
    const terms = await env.db.prepare('SELECT terms_version, terms_accepted_at FROM tenants WHERE id = ?').bind(clinic.tenantId).first<{ terms_version: string; terms_accepted_at: string }>();
    assert.ok(terms?.terms_version && terms.terms_accepted_at, 'Queda registrada la aceptación de los términos');
  });

  it('cada pago aplicado envía un comprobante con número consecutivo', async () => {
    const before = gmail.inbox.length;
    const first = await platform('POST', `/api/platform/tenants/${clinic.tenantId}/payments`, { amount: 59000, months: 1, method: 'nequi', reference: 'NQ-1', notes: null });
    assert.equal(first.status, 201, first.text);
    const second = await platform('POST', `/api/platform/tenants/${clinic.tenantId}/payments`, { amount: 590000, months: 12, method: 'transferencia', reference: null, notes: null });
    assert.equal(second.status, 201, second.text);
    await flush();
    const receipts = gmail.inbox.slice(before).filter((mail) => mail.to === 'laura@feliz.co');
    assert.equal(receipts.length, 2);
    assert.match(receipts[0]!.subject, /N\.º 000001/);
    assert.match(receipts[1]!.subject, /N\.º 000002/);
    assert.match(receipts[0]!.text, /No es factura electrónica/);
    assert.match(receipts[0]!.html, /\$\s?59\.000/);

    const view = (await env.request('GET', '/api/subscription', { cookie: clinic.cookie })).json;
    assert.deepEqual(view.payments.map((payment: { receiptNumber: number }) => payment.receiptNumber).sort(), [1, 2]);
    assert.match(view.legal.providerName, /Jhan/);
    const paymentId = view.payments[0].id as string;
    const receipt = await env.request('GET', `/api/subscription/payments/${paymentId}/receipt`, { cookie: clinic.cookie });
    assert.equal(receipt.status, 200, receipt.text);
    assert.equal(receipt.json.customer.clinicName, 'Sonrisa Feliz');

    // Otro consultorio no puede ver el comprobante ajeno.
    const other = await env.request('POST', '/api/public/signup', {
      headers: fresh(),
      body: { clinicName: 'Ajena', fullName: 'Pedro', email: 'pedro@ajena.co', password: TEST_PASSWORD, planId: 'basico', acceptTerms: true },
    });
    assert.equal((await env.request('GET', `/api/subscription/payments/${paymentId}/receipt`, { cookie: cookieOf(other) })).status, 404);

    const summary = (await platform('GET', '/api/platform/summary')).json;
    assert.equal(summary.yearCollected, 649000);
    assert.equal(summary.ivaThreshold, 3500 * 52374);
  });

  it('recordatorios de vencimiento: se envían una sola vez por periodo', async () => {
    await env.db.prepare('UPDATE tenants SET paid_until = ?, on_trial = 0 WHERE id = ?').bind(addDays(todayLocal(-300), 1), clinic.tenantId).run();
    const before = mailsTo('laura@feliz.co').length;
    const sent = await env.app.services.notifications.sendReminders();
    await flush();
    assert.ok(sent >= 1);
    const reminders = mailsTo('laura@feliz.co').slice(before);
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!.subject, /vence/i);
    assert.equal(await env.app.services.notifications.sendReminders(), 0, 'No se repite');
  });

  it('recuperar contraseña: respuesta neutra, enlace de un solo uso y cierre de sesiones', async () => {
    const unknown = await env.request('POST', '/api/auth/forgot', { headers: fresh(), body: { email: 'nadie@x.co' } });
    const known = await env.request('POST', '/api/auth/forgot', { headers: fresh(), body: { email: 'LAURA@feliz.co' } });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.json, known.json, 'No revela qué correos tienen cuenta');
    await flush();
    const resetMail = mailsTo('laura@feliz.co').at(-1)!;
    assert.match(resetMail.subject, /contraseña/i);
    const token = decodeURIComponent(resetMail.text.match(/#\/restablecer\/(\S+)/)?.[1] ?? '');
    assert.ok(token.length > 30);
    const stored = await env.db.prepare('SELECT token_hash FROM password_resets').first<{ token_hash: string }>();
    assert.notEqual(stored?.token_hash, token, 'En la base solo queda la huella');

    assert.equal((await env.request('POST', '/api/auth/reset', { headers: fresh(), body: { token, password: 'corta' } })).status, 400);
    const reset = await env.request('POST', '/api/auth/reset', { headers: fresh(), body: { token, password: 'NuevaClave2026x' } });
    assert.equal(reset.status, 200, reset.text);
    assert.equal((await env.request('GET', '/api/auth/me', { cookie: clinic.cookie })).status, 401, 'Se cierran las sesiones abiertas');
    assert.ok(await env.login('laura@feliz.co', 'NuevaClave2026x'));
    const reused = await env.request('POST', '/api/auth/reset', { headers: fresh(), body: { token, password: 'OtraClave2026y' } });
    assert.equal(reused.json.error.code, 'RESET_INVALID');
    const audit = await env.db.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE action = 'clave_recuperada'").first<{ total: number }>();
    assert.equal(audit?.total, 1);
  });

  it('el mensaje SMTP no permite inyectar cabeceras y codifica tildes', () => {
    const raw = buildMessage(
      { host: 'h', port: 465, user: 'a@gmail.com', password: 'x', fromName: 'Agenda Sonrisa' },
      { to: 'b@x.co\r\nBcc: victima@x.co', subject: 'Año nuevo\r\nBcc: otra@x.co', html: '<p>ñ</p>', text: 'ñ' },
    );
    assert.doesNotMatch(raw, /^Bcc:/m);
    assert.match(raw, /^Subject: =\?UTF-8\?B\?/m);
  });
});
