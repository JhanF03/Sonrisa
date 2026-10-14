/**
 * El centro de aprendizaje no puede quedar desactualizado: cada guía debe
 * apuntar a un módulo real del menú y a permisos que existan.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { HELP_TOPICS } from '../frontend/admin/help/helpContent.js';
import { isPermission } from '../src/security/permissions.js';

const shellSource = readFileSync('frontend/admin/shell.ts', 'utf8');
const navPaths = new Set([...shellSource.matchAll(/\{ path: '([a-z-]+)'/g)].map((match) => match[1]));

describe('Centro de aprendizaje', () => {
  it('cada módulo del menú tiene su guía y cada guía apunta a un módulo real', () => {
    for (const topic of HELP_TOPICS) {
      if (topic.path) assert.ok(navPaths.has(topic.path), `La guía "${topic.title}" apunta a #/${topic.path}, que no existe`);
    }
    const documented = new Set(HELP_TOPICS.map((topic) => topic.path));
    for (const path of navPaths) {
      if (path === 'ayuda') continue;
      assert.ok(documented.has(path ?? ''), `El módulo #/${path} no tiene guía en el centro de aprendizaje`);
    }
  });

  it('usa permisos que existen y cada guía tiene contenido y recorrido', () => {
    for (const topic of HELP_TOPICS) {
      for (const permission of topic.permissions) assert.ok(isPermission(permission), `Permiso desconocido en "${topic.title}": ${permission}`);
      assert.ok(topic.sections.length > 0 && topic.sections.every((section) => section.items.length > 0), `"${topic.title}" sin contenido`);
      assert.ok(topic.tour.length > 0, `"${topic.title}" sin recorrido`);
    }
    assert.equal(new Set(HELP_TOPICS.map((topic) => topic.id)).size, HELP_TOPICS.length, 'Ids repetidos');
  });
});
