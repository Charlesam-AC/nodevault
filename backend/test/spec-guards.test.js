const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');

test('compose reaches the database service and the healthcheck is valid YAML', () => {
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /DB_HOST:\s*nodevault-db/);
  assert.doesNotMatch(compose, /nodevault-secure-db/);
  assert.doesNotMatch(compose, /interval:\s*10s;/);
  assert.match(compose, /interval:\s*10s\n/);
  assert.match(compose, /timeout:\s*5s\n/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.env\n') ? 'tracked' : 'missing', /missing/);
  assert.equal(fs.existsSync(path.join(root, '.env.example')), true);
});

test('closing PINs are not stored in the directory password column', () => {
  const sql = fs.readFileSync(path.join(root, 'database', 'init.sql'), 'utf8');
  assert.match(sql, /closing_pin_hash/);
  assert.doesNotMatch(sql, /password_hash/);
  assert.doesNotMatch(sql, /ON DELETE CASCADE/i);
  assert.match(sql, /ledger is append-only/);
  assert.match(sql, /in_grand/);
});

test('the closing path does not compare money with parseFloat', () => {
  const source = ['closing.js', 'money.js', 'corebank.js', 'ledger.js']
    .map((name) => fs.readFileSync(path.join(__dirname, '..', 'services', name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /parseFloat|Number\.parseFloat/);
  const closing = fs.readFileSync(path.join(__dirname, '..', 'services', 'closing.js'), 'utf8');
  const commitAt = closing.indexOf("await client.query('COMMIT')");
  const dispatchAt = closing.indexOf('dispatchClosing(');
  assert.ok(commitAt > 0 && dispatchAt > commitAt);
});

test('the ledger page keeps values on one line and scales the type', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const scaler = fs.readFileSync(path.join(__dirname, '..', 'public', 'layout-scale.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(css, /white-space:\s*nowrap/);
  assert.match(scaler, /synchronizeHorizontalMatrixLayout/);
  assert.match(scaler, /9\.5px/);
  assert.match(app, /Kwacha Treasury Book/);
  assert.match(app, /Foreign Currency Treasury Book/);
  assert.match(app, /Bancs Treasury Book/);
});
