/**
 * FuelBunk Pro — PostgreSQL Database Schema & Init
 * AUTO-FIX VERSION: Automatically fixes tenants.id type from INTEGER to TEXT
 */
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

async function verifyPassword(plain, stored) {
  if (stored && stored.startsWith('$2')) {
    return bcrypt.compare(String(plain), stored);
  }
  const sha = crypto.createHash('sha256').update(String(plain)).digest('hex');
  return sha === stored;
}

function _sha256Legacy(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl && !process.env.PGHOST) {
  console.error('[WARN] No DATABASE_URL found');
}

let poolConfig;
if (dbUrl) {
  console.log('[DB] Using DATABASE_URL:', dbUrl.replace(/:([^:@]+)@/, ':****@'));
  const isInternal = dbUrl.includes('railway.internal') || dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
  poolConfig = {
    connectionString: dbUrl,
    ssl: isInternal ? false : { rejectUnauthorized: false },
    max: 150,
    min: 20,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    allowExitOnIdle: false,
  };
} else {
  poolConfig = {
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl: false,
    max: 150,
    min: 20,
    idleTimeoutMillis: 15000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    allowExitOnIdle: false,
  };
}

const pool = new Pool(poolConfig);
pool.on('error', (err) => {
  console.error('[PG Pool] Unexpected error:', err.message);
});

function convertSql(sql, mode) {
  let i = 0;
  sql = sql.replace(/\?/g, () => `$${++i}`);
  sql = sql.replace(/datetime\('now'\)/gi, 'NOW()');
  sql = sql.replace(/datetime\("now"\)/gi, 'NOW()');
  sql = sql.replace(/INSERT OR REPLACE INTO (\w+)/gi, 'INSERT INTO $1');
  sql = sql.replace(/INSERT OR IGNORE INTO (\w+)/gi, 'INSERT INTO $1');

  if (mode === 'run' && /^\s*INSERT\s+INTO\s+(\w+)/i.test(sql) && !/\bRETURNING\b/i.test(sql)) {
    const m = sql.match(/^\s*INSERT\s+INTO\s+(\w+)/i);
    const table = m[1].toLowerCase();
    const isSessionsTable = table === 'sessions';
    const returningClause = isSessionsTable ? 'RETURNING token' : 'RETURNING id';
    const insertMatch = /\bINSERT\s+INTO\s+\S+\s+\(([^)]+)\)/i.exec(sql);
    if (insertMatch) {
      const columns = insertMatch[1].split(',').map(c => c.trim().replace(/["`]/g, ''));
      if (isSessionsTable && columns.includes('token')) {
        sql = sql.replace(/;?\s*$/, ` ${returningClause};`);
      } else if (!isSessionsTable && columns.includes('id')) {
        sql = sql.replace(/;?\s*$/, ` ${returningClause};`);
      }
    }
  }
  return sql;
}

class Database {
  constructor(pool) {
    this.pool = pool;
  }

  prepare(sql) {
    const self = this;
    return {
      async run(...params) {
        const pgSql = convertSql(sql, 'run');
        try {
          const result = await self.pool.query(pgSql, params);
          const ret = { lastID: result.rows[0]?.id || result.rows[0]?.token || undefined };
          return ret;
        } catch (e) {
          console.error('[DB run]', e.message);
          throw e;
        }
      },
      async get(...params) {
        const pgSql = convertSql(sql, 'get');
        try {
          const result = await self.pool.query(pgSql, params);
          return result.rows[0] || undefined;
        } catch (e) {
          console.error('[DB get]', e.message);
          return undefined;
        }
      },
      async all(...params) {
        const pgSql = convertSql(sql, 'all');
        try {
          const result = await self.pool.query(pgSql, params);
          return result.rows;
        } catch (e) {
          console.error('[DB all]', e.message);
          return [];
        }
      }
    };
  }

  async exec(sql) {
    try { await this.pool.query(convertSql(sql, 'exec')); }
    catch (e) { console.warn('[DB exec]', e.message); }
  }

  pragma() {}

  transaction(fn) {
    const pool = this.pool;
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client, ...args);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
  }

  async getTableColumns(table) {
    const result = await this.pool.query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1`,
      [table]
    );
    return result.rows.map(r => r.name);
  }
}

async function initDatabase() {
  console.log('[DB] Connecting to PostgreSQL...');
  
  async function connectWithRetry(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await pool.query('SELECT 1');
        console.log('[DB] Connection successful');
        return true;
      } catch (e) {
        const delay = Math.min(1000 * Math.pow(2, i), 30000);
        console.error(`[DB] Connection failed (attempt ${i + 1}/${maxRetries}): ${e.message}`);
        if (i < maxRetries - 1) {
          console.log(`[DB] Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw new Error(`Database connection failed after ${maxRetries} attempts: ${e.message}`);
        }
      }
    }
  }
  
  try {
    await connectWithRetry(5);
  } catch (e) {
    console.error('[DB] Fatal connection error:', e.message);
    throw e;
  }

  // ═══════════════════════════════════════════════════════════════
  // AUTO-FIX: Check and fix tenants.id type if it's INTEGER
  // ═══════════════════════════════════════════════════════════════
  console.log('[Schema] Checking tenants table schema...');
  try {
    const typeCheck = await pool.query(`
      SELECT data_type 
      FROM information_schema.columns 
      WHERE table_name = 'tenants' AND column_name = 'id'
    `);
    
    if (typeCheck.rows.length > 0) {
      const currentType = typeCheck.rows[0].data_type;
      if (currentType === 'integer' || currentType === 'bigint') {
        console.log('[Schema] ⚠️  FIXING: tenants.id is ' + currentType.toUpperCase() + ', converting to TEXT...');
        
        // Check if table is empty
        const countResult = await pool.query('SELECT COUNT(*) as count FROM tenants');
        const isEmpty = parseInt(countResult.rows[0].count) === 0;
        
        if (isEmpty) {
          // Safe to alter
          await pool.query('ALTER TABLE tenants ALTER COLUMN id TYPE TEXT');
          console.log('[Schema] ✅ FIXED: tenants.id is now TEXT (table was empty)');
        } else {
          console.log('[Schema] ⚠️  WARNING: tenants table has data. Manual migration required.');
          console.log('[Schema] Run: ALTER TABLE tenants ALTER COLUMN id TYPE TEXT;');
        }
      } else {
        console.log('[Schema] ✓ tenants.id type is correct: ' + currentType.toUpperCase());
      }
    }
  } catch (e) {
    console.log('[Schema] tenants table does not exist yet, will create with correct type');
  }

  const TABLES = [
    `CREATE TABLE IF NOT EXISTS super_admin (
      id INTEGER PRIMARY KEY CHECK(id=1),
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT DEFAULT '',
      owner_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      icon TEXT DEFAULT '⛽',
      color TEXT DEFAULT '#d4940f',
      color_light TEXT DEFAULT '#f0b429',
      station_code TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      owner_phone TEXT DEFAULT '',
      manager_phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      state TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      username TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      role TEXT DEFAULT 'Manager',
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, username)
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      tenant_id TEXT DEFAULT '',
      user_id INTEGER DEFAULT 0,
      user_type TEXT NOT NULL,
      user_name TEXT DEFAULT '',
      role TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      ip_address TEXT DEFAULT '',
      user_agent TEXT DEFAULT ''
    )`,
    `CREATE TABLE IF NOT EXISTS tanks (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      fuel_type TEXT DEFAULT '',
      name TEXT DEFAULT '',
      capacity REAL DEFAULT 0,
      current_level REAL DEFAULT 0,
      low_alert REAL DEFAULT 500,
      last_dip TEXT DEFAULT '',
      unit TEXT DEFAULT 'L',
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      active BOOLEAN DEFAULT TRUE,
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS pumps (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      fuel_type TEXT DEFAULT '',
      tank_id TEXT DEFAULT '',
      nozzle_count INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      active BOOLEAN DEFAULT TRUE,
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      employee_id INTEGER DEFAULT 0,
      employee_name TEXT DEFAULT '',
      fuel_type TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      pump_id TEXT DEFAULT '',
      vehicle_number TEXT DEFAULT '',
      customer_name TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      shift_id TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      idempotency_key TEXT DEFAULT ''
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idem ON sales(tenant_id, idempotency_key) WHERE idempotency_key != ''`,
    `CREATE TABLE IF NOT EXISTS meter_readings (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      pump_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      opening REAL DEFAULT 0,
      closing REAL DEFAULT 0,
      sale REAL DEFAULT 0,
      employee_id INTEGER DEFAULT 0,
      employee_name TEXT DEFAULT '',
      shift_id TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS pump_readings (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      pump_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      recorded_at TIMESTAMPTZ DEFAULT NOW(),
      reading REAL DEFAULT 0,
      fuel_type TEXT DEFAULT '',
      employee_id INTEGER DEFAULT 0,
      shift_id TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}'
    )`,
    `CREATE TABLE IF NOT EXISTS dip_readings (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      tank_id TEXT DEFAULT '',
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      level REAL DEFAULT 0,
      temperature REAL DEFAULT 0,
      density REAL DEFAULT 0,
      employee_id INTEGER DEFAULT 0,
      employee_name TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS fuel_purchases (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      tank_id TEXT DEFAULT '',
      fuel_type TEXT DEFAULT '',
      quantity REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      supplier TEXT DEFAULT '',
      bill_no TEXT DEFAULT '',
      employee_id INTEGER DEFAULT 0,
      employee_name TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      category TEXT DEFAULT '',
      description TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'cash',
      employee_id INTEGER DEFAULT 0,
      employee_name TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      idempotency_key TEXT DEFAULT ''
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_idem ON expenses(tenant_id, idempotency_key) WHERE idempotency_key != ''`,
    `CREATE TABLE IF NOT EXISTS credit_customers (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      credit_limit REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      active INTEGER DEFAULT 1,
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      customer_id INTEGER DEFAULT 0,
      date TEXT DEFAULT '',
      type TEXT DEFAULT 'sale',
      amount REAL DEFAULT 0,
      description TEXT DEFAULT '',
      sale_id INTEGER DEFAULT 0,
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      role TEXT DEFAULT 'attendant',
      shift TEXT DEFAULT '',
      pin_hash TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      salary REAL DEFAULT 0,
      join_date TEXT DEFAULT '',
      color TEXT DEFAULT '',
      emp_id TEXT DEFAULT '',
      aadhar TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_empid ON employees(tenant_id, emp_id) WHERE emp_id != ''`,
    `CREATE TABLE IF NOT EXISTS shifts (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      employee_id INTEGER,
      shift_type TEXT DEFAULT '',
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      date TEXT DEFAULT '',
      total_sales REAL DEFAULT 0,
      total_transactions INTEGER DEFAULT 0,
      cash_amount REAL DEFAULT 0,
      card_amount REAL DEFAULT 0,
      upi_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'open',
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(key, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS lubes_products (
      id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      name TEXT DEFAULT '',
      brand TEXT DEFAULT '',
      category TEXT DEFAULT '',
      hsn TEXT DEFAULT '',
      gst_pct REAL DEFAULT 18,
      unit TEXT DEFAULT 'L',
      selling_price REAL DEFAULT 0,
      cost_price REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      min_stock REAL DEFAULT 5,
      expiry_date TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      data_json TEXT DEFAULT '{}',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(id, tenant_id)
    )`,
    `CREATE TABLE IF NOT EXISTS lubes_sales (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      date TEXT DEFAULT '',
      time TEXT DEFAULT '',
      product_id TEXT DEFAULT '',
      product_name TEXT DEFAULT '',
      qty REAL DEFAULT 0,
      unit TEXT DEFAULT '',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      customer TEXT DEFAULT '',
      mode TEXT DEFAULT 'cash',
      employee TEXT DEFAULT '',
      data_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_lubes_sales_tenant ON lubes_sales(tenant_id, date DESC)`,
    `CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT DEFAULT '',
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_name TEXT DEFAULT '',
      user_type TEXT DEFAULT '',
      action TEXT DEFAULT '',
      entity TEXT DEFAULT '',
      entity_id TEXT DEFAULT '',
      details TEXT DEFAULT '',
      ip_address TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS login_attempts (
      id SERIAL PRIMARY KEY,
      ip_address TEXT DEFAULT '',
      username TEXT DEFAULT '',
      tenant_id TEXT DEFAULT '',
      success INTEGER DEFAULT 0,
      attempted_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT DEFAULT '',
      user_id INTEGER DEFAULT 0,
      user_type TEXT DEFAULT '',
      endpoint TEXT NOT NULL,
      keys_json TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(endpoint)
    )`,
    `CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT DEFAULT '{}',
      acknowledged BOOLEAN DEFAULT FALSE,
      acknowledged_by INTEGER,
      acknowledged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
    // ── SUBSCRIPTIONS ───────────────────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE,
      plan TEXT DEFAULT 'trial',
      status TEXT DEFAULT 'trial',
      trial_days INTEGER DEFAULT 30,
      trial_start TIMESTAMPTZ DEFAULT NOW(),
      sub_start TIMESTAMPTZ,
      sub_end TIMESTAMPTZ,
      price_monthly REAL DEFAULT 0,
      grace_days INTEGER DEFAULT 3,
      owner_phone TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS subscription_payments (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      plan TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_date TIMESTAMPTZ DEFAULT NOW(),
      payment_mode TEXT DEFAULT 'upi',
      reference TEXT DEFAULT '',
      months INTEGER DEFAULT 1,
      period_start TIMESTAMPTZ,
      period_end TIMESTAMPTZ,
      recorded_by TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sub_payments_tenant ON subscription_payments(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
    `CREATE INDEX IF NOT EXISTS idx_sales_tenant_date ON sales(tenant_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address, attempted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_credit_tx_customer ON credit_transactions(customer_id, tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_employees_tenant ON employees(tenant_id, active)`,
    `CREATE INDEX IF NOT EXISTS idx_shifts_tenant_date ON shifts(tenant_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_expenses_tenant_date ON expenses(tenant_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_dip_tenant_date ON dip_readings(tenant_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_purchases_tenant_date ON fuel_purchases(tenant_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON alerts(tenant_id, acknowledged, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(tenant_id, type, created_at DESC)`,
  ];

  for (const stmt of TABLES) {
    try { await pool.query(stmt); }
    catch (e) { console.warn('[Schema]', e.message.substring(0, 120)); }
  }

  const existing = await pool.query('SELECT id FROM super_admin WHERE id = 1');
  if (existing.rows.length === 0) {
    // No row yet — insert fresh
    const initPass = process.env.SUPER_ADMIN_INIT_PASS || crypto.randomBytes(16).toString('hex');
    const initHash = await hashPassword(initPass);
    await pool.query(
      'INSERT INTO super_admin (id, username, pass_hash) VALUES ($1, $2, $3)',
      [1, process.env.SUPER_ADMIN_USERNAME || 'superadmin', initHash]
    );
    if (!process.env.SUPER_ADMIN_INIT_PASS) {
      console.log('╔══════════════════════════════════════════════════════╗');
      console.log('║  SUPER ADMIN PASSWORD (shown once — save this now!) ║');
      console.log(`║  Username : ${(process.env.SUPER_ADMIN_USERNAME || 'superadmin').padEnd(40)}║`);
      console.log(`║  Password : ${initPass.padEnd(40)}║`);
      console.log('╚══════════════════════════════════════════════════════╝');
    }
  } else if (process.env.SUPER_ADMIN_USERNAME && process.env.SUPER_ADMIN_INIT_PASS) {
    // Row exists — if env vars are explicitly set, sync them to the DB
    // This ensures Railway env var changes always take effect on redeploy
    const envUser = process.env.SUPER_ADMIN_USERNAME;
    const envPass = process.env.SUPER_ADMIN_INIT_PASS;
    const currentRow = existing.rows[0];
    const usernameChanged = currentRow.username !== envUser;
    // Always re-hash and update when env vars are present, so credentials stay in sync
    const syncHash = await hashPassword(envPass);
    await pool.query(
      'UPDATE super_admin SET username = $1, pass_hash = $2, updated_at = NOW() WHERE id = 1',
      [envUser, syncHash]
    );
    if (usernameChanged) {
      console.log(`[Schema] Super admin username updated to: ${envUser}`);
    }
    console.log('[Schema] Super admin credentials synced from environment variables');
  }

  console.log('[Schema] Database schema initialized successfully');
  return new Database(pool);
}

module.exports = {
  initDatabase,
  pool,
  hashPassword,
  verifyPassword
};
