import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ps1 = readFileSync(join(__dirname, 'setup.ps1'), 'utf8');
const sh = readFileSync(join(__dirname, 'setup.sh'), 'utf8');

test('setup.ps1 contains -AtLogOn', () => {
  assert.match(ps1, /-AtLogOn/);
});

test('setup.ps1 contains PT2M', () => {
  assert.match(ps1, /PT2M/);
});

test('setup.ps1 contains Set-ScheduledTask', () => {
  assert.match(ps1, /Set-ScheduledTask/);
});

test('setup.ps1 does not contain $TaskName-boot', () => {
  assert.doesNotMatch(ps1, /\$TaskName-boot/);
});

test('setup.ps1 does not contain /SC ONSTART', () => {
  assert.doesNotMatch(ps1, /\/SC ONSTART/);
});

test('setup.sh contains @reboot sleep 120 && $HOURLY', () => {
  assert.match(sh, /@reboot sleep 120 && \$HOURLY/);
});