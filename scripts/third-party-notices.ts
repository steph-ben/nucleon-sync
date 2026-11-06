// Prints the license text of every third-party package in the bundle. Usage: bun scripts/third-party-notices.ts <bun build metafile>
// Fails when a package has no license text, so a new dependency cannot slip in without one.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SDK_FOLDER = 'vendor/proton-sdk';

/** @protontech/crypto says ISC in its package.json but ships no license file. This is the standard ISC text. */
const ISC_FOR_PROTON_CRYPTO = `ISC License

Copyright (c) Proton AG

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;

/** The folder of the npm package a bundled file comes from: the deepest node_modules counts. */
function packageFolder(input: string): string | undefined {
    const match = /^(.*\/)?node_modules\/(@[^/]+\/)?[^/]+/.exec(input);
    return match?.[0];
}

function licenseFile(folder: string): string | undefined {
    if (!existsSync(folder)) return undefined;
    const name = readdirSync(folder).find((n) => /^licen[sc]e/i.test(n));
    return name ? path.join(folder, name) : undefined;
}

function notice(folder: string): string {
    const info = existsSync(path.join(folder, 'package.json')) ? JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')) : {};
    const file = licenseFile(folder);
    const text = file ? readFileSync(file, 'utf8') : info.name === '@protontech/crypto' ? ISC_FOR_PROTON_CRYPTO : undefined;
    if (!text) throw new Error(`no license text found for ${folder}: add one before bundling it`);
    return `${info.name} ${info.version} (${info.license})\n\n${text.trim()}\n`;
}

const metafile = process.argv[2];
if (!metafile) throw new Error('usage: bun scripts/third-party-notices.ts <metafile>');
const inputs = Object.keys(JSON.parse(readFileSync(metafile, 'utf8')).inputs);
const folders = [...new Set(inputs.flatMap((input) => packageFolder(input) ?? []))].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

const sections = folders.map(notice);
if (inputs.some((input) => input.startsWith(`${SDK_FOLDER}/`))) {
    sections.unshift(`Proton Drive SDK (MIT), in ${SDK_FOLDER}\n\n${readFileSync(path.join(SDK_FOLDER, 'LICENSE.md'), 'utf8').trim()}\n`);
}

const rule = `\n${'-'.repeat(72)}\n`;
console.log(`Third-party software in nucleon-sync

nucleon-sync.js is one bundled file that contains the packages below. They are
unchanged, except for two small edits: an import path in @protontech/crypto
(scripts/patch-crypto.sh) and the session name in the Proton Drive SDK.
Each keeps its own license. @protontech/openpgp is under the LGPL: its source code
is at https://github.com/ProtonMail/openpgpjs, and you may replace it by rebuilding
nucleon-sync from source with scripts/build-release.sh.
${rule}${['', ...sections].join(rule).slice(rule.length)}`);
