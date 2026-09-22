const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');

const scryptAsync = promisify(crypto.scrypt);
const hasDatabase = Boolean(process.env.DATABASE_URL);
const pool = hasDatabase
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    })
  : null;

const memoryUsers = new Map();
const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_MAX_LENGTH = 64;

function normalizeUsername(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (username.length < 3) return { ok: false, message: 'El usuario debe tener al menos 3 caracteres.' };
  if (username.length > 24) return { ok: false, message: 'El usuario es demasiado largo.' };
  return { ok: true, username };
}

function validatePassword(value) {
  const password = String(value ?? '');
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, message: 'La contraseña debe tener al menos 4 caracteres.' };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, message: 'La contraseña es demasiado larga.' };
  return { ok: true, password };
}

function defaultProfile(username) {
  return {
    version: 1,
    username,
    display_name: username,
    player_variant: 0,
    money: 100,
    job_levels: {
      fishing: 0,
      bus: 0,
      garbage: 0,
      paramedic: 0,
      trailero: 0
    },
    experience: {
      fishing: 0,
      bus: 0,
      garbage: 0,
      paramedic: 0,
      trailero: 0
    },
    agriculture: null,
    owned_vehicles: []
  };
}

function mergeProfile(base, incoming) {
  const source = incoming && typeof incoming === 'object' ? incoming : {};
  const result = { ...base, ...source };
  result.version = 1;
  result.username = base.username;
  result.display_name = String(source.display_name ?? base.display_name).slice(0, 24);
  result.player_variant = Math.max(0, Math.min(4, Number.parseInt(source.player_variant ?? base.player_variant, 10) || 0));
  result.money = Math.max(0, Math.floor(Number(source.money ?? base.money) || 0));

  result.job_levels = { ...base.job_levels, ...(source.job_levels || {}) };
  for (const key of Object.keys(result.job_levels)) {
    result.job_levels[key] = Math.max(0, Math.floor(Number(result.job_levels[key]) || 0));
  }

  if (source.agriculture && typeof source.agriculture === 'object') {
    result.agriculture = source.agriculture;
  } else if (source.agriculture === null) {
    result.agriculture = null;
  }

  if (Array.isArray(source.owned_vehicles)) {
    result.owned_vehicles = source.owned_vehicles
      .filter(v => typeof v === 'string')
      .map(v => v.slice(0, 64))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 32);
  }
  return result;
}

async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return { salt: salt.toString('hex'), hash: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, saltHex, hashHex) {
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  const actual = Buffer.from(derived);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function init() {
  if (!pool) {
    console.warn('[accounts] DATABASE_URL no está configurada. Se usará almacenamiento temporal en memoria.');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mh_rp_accounts (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(24) NOT NULL UNIQUE,
      password_salt VARCHAR(64) NOT NULL,
      password_hash VARCHAR(256) NOT NULL,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[accounts] PostgreSQL listo.');
}

async function authenticate(rawUsername, rawPassword) {
  const userCheck = validateUsername(rawUsername);
  if (!userCheck.ok) return { ok: false, message: userCheck.message };
  const passwordCheck = validatePassword(rawPassword);
  if (!passwordCheck.ok) return { ok: false, message: passwordCheck.message };

  const username = userCheck.username;
  const password = passwordCheck.password;

  if (!pool) {
    let account = memoryUsers.get(username);
    if (!account) {
      const credentials = await hashPassword(password);
      const profile = defaultProfile(username);
      account = { username, password_salt: credentials.salt, password_hash: credentials.hash, profile };
      memoryUsers.set(username, account);
      return { ok: true, created: true, username, profile };
    }
    const valid = await verifyPassword(password, account.password_salt, account.password_hash);
    if (!valid) return { ok: false, message: 'Usuario o contraseña incorrectos.' };
    account.profile = mergeProfile(defaultProfile(username), account.profile);
    return { ok: true, created: false, username, profile: account.profile };
  }

  const found = await pool.query(
    'SELECT username, password_salt, password_hash, profile FROM mh_rp_accounts WHERE username = $1 LIMIT 1',
    [username]
  );

  if (found.rowCount === 0) {
    const credentials = await hashPassword(password);
    const profile = defaultProfile(username);
    await pool.query(
      'INSERT INTO mh_rp_accounts (username, password_salt, password_hash, profile) VALUES ($1, $2, $3, $4::jsonb)',
      [username, credentials.salt, credentials.hash, JSON.stringify(profile)]
    );
    return { ok: true, created: true, username, profile };
  }

  const row = found.rows[0];
  const valid = await verifyPassword(password, row.password_salt, row.password_hash);
  if (!valid) return { ok: false, message: 'Usuario o contraseña incorrectos.' };

  const profile = mergeProfile(defaultProfile(username), row.profile);
  await pool.query('UPDATE mh_rp_accounts SET profile = $2::jsonb, updated_at = NOW() WHERE username = $1', [username, JSON.stringify(profile)]);
  return { ok: true, created: false, username, profile };
}

async function saveProfile(username, profile) {
  const userCheck = validateUsername(username);
  if (!userCheck.ok) return false;
  const normalized = userCheck.username;
  const safeProfile = mergeProfile(defaultProfile(normalized), profile);

  if (!pool) {
    const account = memoryUsers.get(normalized);
    if (!account) return false;
    account.profile = safeProfile;
    return true;
  }

  await pool.query(
    'UPDATE mh_rp_accounts SET profile = $2::jsonb, updated_at = NOW() WHERE username = $1',
    [normalized, JSON.stringify(safeProfile)]
  );
  return true;
}

module.exports = {
  init,
  authenticate,
  saveProfile,
  normalizeUsername,
  validateUsername,
  validatePassword,
  defaultProfile
};
