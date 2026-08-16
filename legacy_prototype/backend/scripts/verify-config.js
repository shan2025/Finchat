/* Safe local verification: reads files and environment values only. */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const failures = [];
const warnings = [];

function check(label, condition, detail = '') {
  if (condition) console.log(`PASS  ${label}`);
  else { failures.push(label); console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
function warn(label) { warnings.push(label); console.log(`WARN  ${label}`); }
function exists(relativePath) { return fs.existsSync(path.join(backendRoot, relativePath)); }

console.log('FinChat safe verification (read-only)\n');
check('Backend entry point', exists('server.js'));
check('PostgreSQL connection module', exists('database.js'));
check('Cognitive memory engine', exists('services/cognitive/MemoryEngine.js'));
check('Community detection', exists('services/cognitive/Communities.js'));
check('Nightly dream digest', exists('services/cognitive/DreamDigest.js'));
check('Reports engine', exists('services/cognitive/ReportEngine.js'));
check('Knowledge API route', exists('routes/knowledge.js'));
check('Reports API route', exists('routes/reports.js'));
check('Knowledge Center page', fs.existsSync(path.join(projectRoot, 'frontend', 'finchat_knowledge.html')));
check('Reports page', fs.existsSync(path.join(projectRoot, 'frontend', 'finchat_reports.html')));

// Migrations are checked for shape, not for a fixed count. Pinning the number
// meant every migration added afterwards failed this script, so it reported a
// problem on the one occasion nothing was wrong. What actually breaks a
// deployment is two migrations sharing a numeric prefix — node-pg-migrate
// orders by filename, so duplicates apply in an undefined order.
const migrationsDir = path.join(backendRoot, 'migrations');
const migrations = fs.existsSync(migrationsDir)
  ? fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.js')).sort()
  : [];
check('Database migrations present', migrations.length > 0, `found ${migrations.length}`);

const prefixes = migrations.map((file) => file.split('_')[0]);
const duplicates = prefixes.filter((prefix, i) => prefixes.indexOf(prefix) !== i);
check('Migration prefixes are unique', duplicates.length === 0,
  duplicates.length ? `duplicated: ${[...new Set(duplicates)].join(', ')}` : '');

const examplePath = path.join(backendRoot, '.env.example');
check('Environment template', fs.existsSync(examplePath));
if (fs.existsSync(examplePath)) {
  const example = dotenv.parse(fs.readFileSync(examplePath));
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'GROQ_API_KEY']) check(`Environment template declares ${key}`, Object.hasOwn(example, key));
}

const envPath = path.join(backendRoot, '.env');
if (!fs.existsSync(envPath)) warn('.env is absent; copy .env.example and configure required values before starting the backend');
else {
  const env = dotenv.parse(fs.readFileSync(envPath));
  check('DATABASE_URL is configured', Boolean(env.DATABASE_URL && env.DATABASE_URL.trim()));
  check('JWT_SECRET is configured', Boolean(env.JWT_SECRET && env.JWT_SECRET.trim() && !env.JWT_SECRET.includes('change_this')));
  if (!env.GROQ_API_KEY && !env.OLLAMA_URL) warn('No Groq key or Ollama URL found; AI inference may be unavailable');
  if (!env.CRON_SECRET) warn('No CRON_SECRET found; /api/cron/* is disabled, so missions and briefings will never fire');
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) warn('Upstash REST is not configured; caching and working memory fall back to no-ops (correct, but slower)');
  if (!env.PINATA_API_KEY || !env.PINATA_SECRET_KEY) warn('Pinata is not fully configured; IPFS archival will use its fallback');
}
console.log(`\nResult: ${failures.length} failure(s), ${warnings.length} warning(s).`);
if (failures.length) process.exitCode = 1;