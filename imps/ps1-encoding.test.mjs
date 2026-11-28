// node --test imps/ps1-encoding.test.mjs   (no deps)
// Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a non-ASCII character
// (an em dash in a string) breaks quoting and the whole script fails to parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ps1'))) {
    test(`${f}: non-ASCII text needs a UTF-8 BOM`, () => {
        const b = readFileSync(join(DIR, f));
        const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
        assert.ok(bom || !b.some((x) => x > 127), `${f} has non-ASCII bytes and no BOM; Windows PowerShell 5.1 will misparse it`);
    });
}
