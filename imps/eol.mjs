// Add a missing final newline to text files an imp changed. Imps often leave the
// last line unterminated, and repos with pre-commit's end-of-file-fixer then fail
// CI on an otherwise green PR (motor-pool#205, #213, 2026-11-20). This is
// mechanical, so the runner does it in its formatter commit, not the model.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|svgz|pdf|zip|gz|tgz|bz2|xz|7z|woff2?|ttf|otf|eot|mp3|mp4|webm|mov|wav|ogg|wasm|bin|exe|dll|so|dylib|lockb|sqlite|db)$/i;

/** True when `buf` looks like text that should end with a newline. */
export function needsFinalNewline(buf) {
    if (!buf || buf.length === 0) return false;
    if (buf.subarray(0, 8000).includes(0)) return false; // binary
    const last = buf[buf.length - 1];
    return last !== 0x0a;
}

/** The newline style a file already uses: CRLF if any line ends in \r\n. */
export function newlineFor(buf) {
    return buf.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Append a final newline to each listed repo-relative file that lacks one.
 * Returns the paths changed. Missing, binary and empty files are left alone.
 */
export function ensureFinalNewlines(worktree, files = []) {
    const changed = [];
    for (const f of files) {
        if (!f || BINARY_EXT.test(f)) continue;
        const abs = join(worktree, f);
        let buf;
        try {
            if (!statSync(abs).isFile()) continue;
            buf = readFileSync(abs);
        } catch { continue; }
        if (!needsFinalNewline(buf)) continue;
        writeFileSync(abs, Buffer.concat([buf, Buffer.from(newlineFor(buf))]));
        changed.push(f);
    }
    return changed;
}
