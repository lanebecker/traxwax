// Build-time deploy marker (#144). Reads the repo's VERSION and writes public/version.json so
// Cloudflare Pages serves {"version":"<VERSION>"} from the SAME build as any push; the uptime
// probe (Probe 3) compares it to main's VERSION to confirm the last release actually deployed.
// Generated at build time (gitignored, NOT committed) so it always matches the deployed commit.
// If the Pages build command omits this step, /version.json 404s and Probe 3 goes RED — which
// doubles as a check that the build is wired. ESM (.mjs) so it runs regardless of package "type".
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
// Full-semver-ish: MAJOR.MINOR.PATCH with optional -prerelease and +build (audit #10).
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?(\+[0-9A-Za-z.]+)?$/.test(version)) {
  console.error(`write-version: VERSION content '${version}' is not valid semver; refusing.`);
  process.exit(1);
}
const out = join(root, 'public', 'version.json');
mkdirSync(dirname(out), { recursive: true });   // audit #10: don't ENOENT if public/ is absent
writeFileSync(out, JSON.stringify({ version }) + '\n');
console.log(`write-version: wrote ${out} = {"version":"${version}"}`);
