/**
 * Pruebas de seguridad del frontend: escape de HTML (XSS) y URLs seguras.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, html, raw, safeUrl } from '../frontend/core/dom.js';
import { formatMoney, whatsappNumber } from '../frontend/core/format.js';

describe('Frontend: protección XSS', () => {
  it('escapa todo valor interpolado en las plantillas', () => {
    const attack = '<img src=x onerror="alert(1)">';
    const rendered = html`<p>${attack}</p>`.value;
    assert.equal(rendered, '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
    assert.doesNotMatch(rendered, /<img/);
  });

  it('escapa comillas para que no se rompan los atributos', () => {
    const rendered = html`<input value="${'" autofocus onfocus="alert(1)'}" />`.value;
    assert.doesNotMatch(rendered, /" autofocus/);
  });

  it('solo inserta HTML sin escapar cuando se marca explícitamente', () => {
    const nested = html`<b>${'<i>'}</b>`;
    assert.equal(html`<div>${nested}</div>`.value, '<div><b>&lt;i&gt;</b></div>');
    assert.equal(html`${raw('<hr />')}`.value, '<hr />');
  });

  it('escapa el acento grave usado en algunos ataques', () => {
    assert.equal(escapeHtml('`'), '&#96;');
  });

  it('descarta URLs peligrosas (javascript:, data:)', () => {
    assert.equal(safeUrl('javascript:alert(1)'), '#');
    assert.equal(safeUrl('data:text/html,<script>'), '#');
    assert.equal(safeUrl('//sitio-malicioso.com'), '#');
    assert.equal(safeUrl('https://ejemplo.co/logo.png'), 'https://ejemplo.co/logo.png');
    assert.equal(safeUrl('/app'), '/app');
    assert.equal(safeUrl('http://ejemplo.co', ['https:']), '#');
  });
});

describe('Frontend: formatos colombianos', () => {
  it('formatea pesos sin decimales', () => {
    assert.match(formatMoney(120000), /120\.000/);
  });

  it('agrega el indicativo 57 a celulares para WhatsApp', () => {
    assert.equal(whatsappNumber('300 123 4567'), '573001234567');
    assert.equal(whatsappNumber('+57 300 123 4567'), '573001234567');
  });
});
