// Usage: node test-connection.js
const dbs = require('./database');

// Each pool + the tables the cron job needs from it.
const CHECKS = [
    { name: 'db',         prefix: 'DB',        pool: dbs.db,         tables: [] },
    { name: 'dbMaenMeta', prefix: 'MAEN_META', pool: dbs.dbMaenMeta, tables: ['customer', 'srcims', 'brokers'] },
    { name: 'dbMrg',      prefix: 'MRG',       pool: dbs.dbMrg,      tables: ['open_account'] },
    { name: 'dbMmb',      prefix: 'MMB',       pool: dbs.dbMmb,      tables: ['users_platid'] },
    { name: 'dbMT4Mrg',   prefix: 'MT4_MRG',   pool: dbs.dbMT4Mrg,   tables: ['mt4_trades'] },
    { name: 'dbMT4Mmb',   prefix: 'MT4_MMB',   pool: dbs.dbMT4Mmb,   tables: ['mt4_trades'] },
];

async function check({ name, prefix, pool, tables }) {
    if (!process.env[`${prefix}_HOST`]) {
        return { name, status: 'SKIP', detail: `${prefix}_HOST not set` };
    }

    const started = Date.now();
    let conn;
    try {
        conn = await pool.getConnection();
        const [info] = await conn.query('SELECT 1 AS ok, DATABASE() AS db, VERSION() AS version');

        const missing = [];
        for (const table of tables) {
            try {
                await conn.query(`SELECT 1 FROM \`${table}\` LIMIT 1`);
            } catch (err) {
                missing.push(`${table} (${err.code || err.message})`);
            }
        }

        const ms = Date.now() - started;
        if (missing.length) {
            return { name, status: 'FAIL', detail: `connected to ${info.db}, but cannot read: ${missing.join(', ')}` };
        }
        return { name, status: 'OK', detail: `${info.db} | ${info.version} | ${ms}ms` };
    } catch (err) {
        return { name, status: 'FAIL', detail: err.code ? `${err.code}: ${err.message}` : err.message };
    } finally {
        if (conn) conn.release();
    }
}

(async () => {
    const results = [];
    for (const c of CHECKS) results.push(await check(c));

    console.table(results);

    if (results.some((r) => r.status === 'FAIL')) process.exitCode = 1;
    await dbs.closeAll();
})();