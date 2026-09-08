'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '..', '..');

test('all five READMEs put concise features and first login before technical detail', () => {
  for (const [file, headings] of [
    ['README.md', ['What is AWG-Easy 3?', 'At a glance', 'Installation and first login', 'Update and management', 'Technical features']],
    ['README.ru.md', ['Что такое AWG-Easy 3', 'Кратко о возможностях', 'Установка и первый вход', 'Обновление и управление', 'Технические возможности']],
    ['README.es.md', ['Qué es AWG-Easy 3', 'Funciones principales', 'Instalación y primer acceso', 'Actualización y administración', 'Funciones técnicas']],
    ['README.fa.md', ['AWG-Easy 3 چیست؟', 'امکانات در یک نگاه', 'نصب و نخستین ورود', 'به‌روزرسانی و مدیریت', 'امکانات فنی']],
    ['README.zh-CN.md', ['AWG-Easy 3 是什么', '功能概览', '安装与首次登录', '更新与管理', '技术功能']],
  ]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
    const positions = headings.map(h => text.indexOf(`## ${h}\n`));
    positions.forEach((p, i) => assert(p >= 0 && (i === 0 || p > positions[i - 1]), `${file}: section order`));
    const brief = text.slice(positions[1], positions[2]);
    assert.equal((brief.match(/^- /gm) || []).length, 3, `${file}: brief features`);
    const install = text.slice(positions[2], positions[3]);
    for (const required of ['git clone', 'sudo ./install.sh', 'AmneziaVPN', 'vpn://', 'http://10.8.0.1:51821', 'export-client']) {
      assert(install.includes(required), `${file}: first login missing ${required}`);
    }
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(https?:|#)/.test(target)) continue;
      assert(fs.existsSync(path.join(root, target.split('#')[0])), `${file}: missing linked file ${target}`);
    }
  }
});
