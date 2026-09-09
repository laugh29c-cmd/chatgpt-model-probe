import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
const core = readFileSync(new URL('./src/core.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const browser = readFileSync(new URL('./src/browser.js', import.meta.url), 'utf8').replace('/* PROBE_CORE */', `const Probe = (() => {\n${core}\nreturn {requestedModel, surfaceFor, extractEvidence, evidenceState, StreamDecoder, inspectShape};\n})();`);
writeFileSync(new URL('./ChatGPT_Model_Slug_Probe.user.js', import.meta.url), browser);
mkdirSync(new URL('./extension/', import.meta.url), {recursive:true});
writeFileSync(new URL('./extension/probe.js', import.meta.url), browser);
console.log('Built userscript and Chromium extension.');
