require('dotenv').config();
const mariadb = require('mariadb');

/**
 * Builds one pool from env vars: <PREFIX>_HOST, _PORT, _USER, _PASSWORD, _NAME
 * e.g. MRG_HOST=10.0.0.5  MRG_NAME=mrg_db ...
 */
function createPool(prefix, connectionLimit = 5) {
    return mariadb.createPool({
        host: process.env[`${prefix}_HOST`],
        port: Number(process.env[`${prefix}_PORT`] || 3306),
        user: process.env[`${prefix}_USER`],
        password: process.env[`${prefix}_PASSWORD`],
        database: process.env[`${prefix}_NAME`],
        connectionLimit,
        connectTimeout: 10000,
        acquireTimeout: 15000,
        // Return plain JS numbers for SUM()/ROUND()/BIGINT instead of string/BigInt.
        // Without this, `total += row.Lot` would concatenate strings or throw on BigInt.
        decimalAsNumber: true,
        bigIntAsNumber: true,
        insertIdAsNumber: true,
    });
}

const pools = {
    // db: createPool('DB'),
    dbMaenMeta: createPool('MAEN_META'),
    dbMrg: createPool('MRG'),
    dbMmb: createPool('MMB'),
    dbMT4Mrg: createPool('MT4_MRG'),
    dbMT4Mmb: createPool('MT4_MMB'),
};

async function closeAll() {
    await Promise.allSettled(Object.values(pools).map((p) => p.end()));
}

module.exports = { ...pools, closeAll };