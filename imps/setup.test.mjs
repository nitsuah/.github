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
test('setup.ps1 never hard-codes a backslash-quote in a task command (cmd.exe ignores it, so the task silently did nothing)', () => {
  const lines = ps1.split(/\r?\n/).filter((l) => !l.includes('Write-Hint') && /New-ScheduledTaskAction|schtasks .*\/Create/.test(l));
  assert.ok(lines.length >= 3, 'task registration lines not found');
  for (const l of lines) assert.doesNotMatch(l, /\\[`"]/, l);
});
test('setup.ps1 uses a finite repetition duration (TimeSpan.MaxValue is out of range for the task XML)', () => {
  assert.doesNotMatch(ps1, /\[TimeSpan\]::MaxValue/);
});
