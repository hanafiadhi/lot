const path = require('path');
const ExcelJS = require('exceljs'); // npm install exceljs
const { dbMaenMeta, dbMrg, dbMmb, dbMT4Mrg, dbMT4Mmb } = require('./database');

// SQL tetap dipertahankan seperti aslinya
const CRM_SQL = `
    SELECT 
        a.id, 
        b.ims_id, 
        a.phone, 
        a.fullname,
        IF(c.codename = 'ASK', 'MMB', c.codename) AS codename,
        MIN(sd.nominal_idr) AS first_depo
    FROM customer a
    INNER JOIN srcims b ON a.id = b.crm_id
    INNER JOIN brokers c ON b.source = c.id
    LEFT JOIN srcims_deposit sd ON b.id = sd.srcims_id
    WHERE a.id IN (
        SELECT id 
        FROM customer 
        WHERE pool = 3 AND marketing IS NULL
    )
    GROUP BY a.id, b.ims_id, a.phone, a.fullname, c.codename;
`;

const MRG_ACCOUNT_SQL = `SELECT user_id, platform_id
    FROM open_account
    WHERE platform_id != '' AND user_id IN (?)`;

const MMB_ACCOUNT_SQL = `SELECT user_id, user_platid as platform_id
    FROM users_platid
    WHERE user_platid IS NOT NULL AND user_id IN (?)`;

const STATS_SQL = `SELECT LOGIN, ROUND(SUM(IF(CMD = 6, PROFIT, 0)), 2) as NMI, ROUND(SUM(IF(CMD != 6, VOLUME, 0)) / 100, 2) as Lot
    FROM mt4_trades
    WHERE LOGIN IN (?) AND (CMD IN (0, 1) OR (CMD = 6 AND COMMENT NOT LIKE '%Reb%' AND COMMENT NOT LIKE '%Cash%' AND COMMENT NOT LIKE '%Com%'))
    GROUP BY LOGIN`;

// ---------- helper log ----------
const log = (step, msg) => console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
const logWarn = (step, msg) => console.warn(`[${new Date().toISOString()}] [${step}] ⚠️  ${msg}`);

/**
 * Ambil total lot per ims_id (user_id di DB broker).
 * Return: Map<string(ims_id), number(lot)>
 */
async function getLotByImsId(broker, dbUser, dbMt4, accountSql, imsIds) {
    const result = new Map();
    if (!imsIds.length) {
        logWarn(broker, 'tidak ada ims_id, skip');
        return result; // hindari "IN ()" yang bikin SQL error
    }

    log(broker, `ambil akun platform untuk ${imsIds.length} ims_id...`);
    const accounts = await dbUser.query(accountSql, [imsIds]);
    const logins = [...new Set(accounts.map((x) => x.platform_id))];
    log(broker, `ditemukan ${accounts.length} akun (${logins.length} login unik)`);
    if (!logins.length) {
        logWarn(broker, 'tidak ada login MT4, skip hitung lot');
        return result;
    }

    log(broker, `hitung lot dari MT4 untuk ${logins.length} login...`);
    const stats = await dbMt4.query(STATS_SQL, [logins]);
    log(broker, `data trade ditemukan untuk ${stats.length}/${logins.length} login`);
    const lotByLogin = new Map(stats.map((s) => [String(s.LOGIN), Number(s.Lot) || 0]));

    // satu ims_id bisa punya beberapa akun MT4 -> jumlahkan lotnya
    const seen = new Set();
    for (const acc of accounts) {
        const key = String(acc.user_id);
        const pair = `${key}:${acc.platform_id}`;
        if (seen.has(pair)) continue; // cegah dobel hitung
        seen.add(pair);
        result.set(key, (result.get(key) ?? 0) + (lotByLogin.get(String(acc.platform_id)) ?? 0));
    }
    log(broker, `selesai, lot berhasil dihitung untuk ${result.size} ims_id`);
    return result;
}

async function countingLot() {
    const startAll = Date.now();
    log('START', 'countingLot dimulai');
    try {
        // 1. Data CRM
        log('CRM', 'ambil data customer dari dbMaenMeta...');
        const crmData = await dbMaenMeta.query(CRM_SQL);
        log('CRM', `dapat ${crmData.length} baris`);

        // 2. Pisah per broker
        const mrgRows = crmData.filter((x) => x.codename === 'MRG');
        const mmbRows = crmData.filter((x) => x.codename === 'MMB');
        const mrgIds = [...new Set(mrgRows.map((x) => x.ims_id))];
        const mmbIds = [...new Set(mmbRows.map((x) => x.ims_id))];
        log('SPLIT', `MRG: ${mrgRows.length} baris (${mrgIds.length} ims_id unik) | MMB: ${mmbRows.length} baris (${mmbIds.length} ims_id unik)`);

        const other = crmData.length - mrgRows.length - mmbRows.length;
        if (other > 0) logWarn('SPLIT', `${other} baris bukan MRG/MMB, lot akan null`);

        // 3. Hitung lot (paralel)
        log('LOT', 'proses MRG & MMB berjalan paralel...');
        const [mrgLot, mmbLot] = await Promise.all([
            getLotByImsId('MRG', dbMrg, dbMT4Mrg, MRG_ACCOUNT_SQL, mrgIds),
            getLotByImsId('MMB', dbMmb, dbMT4Mmb, MMB_ACCOUNT_SQL, mmbIds),
        ]);

        // 4. Gabungkan: id | ims_id | phone | fullname | broker | lot
        log('MERGE', 'gabungkan lot ke data CRM...');
        const result = crmData.map((row) => {
            const lotMap = row.codename === 'MRG' ? mrgLot : row.codename === 'MMB' ? mmbLot : null;
            const lot = lotMap?.get(String(row.ims_id));
            return {
                id: row.id,
                ims_id: row.ims_id,
                phone: row.phone,
                fullname: row.fullname,
                broker: row.codename,
                first_depo: row.first_depo,
                lot: lot === undefined ? null : lot, // null = tidak punya akun/trade
            };
        });

        const withLot = result.filter((r) => r.lot !== null).length;
        log('MERGE', `${withLot}/${result.length} baris punya data lot`);

        console.table(result);
        log('DONE', `selesai dalam ${((Date.now() - startAll) / 1000).toFixed(2)} detik`);
        return result;
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [ERROR] countingLot gagal setelah ${((Date.now() - startAll) / 1000).toFixed(2)} detik:`, error);
        throw error;
    }
}

/**
 * Gabungkan semua lot berdasarkan id (CRM id) lalu export ke Excel.
 * Kolom: id | phone | fullname | broker (digabung, mis. "MRG, MMB") | first_depo | total_lot
 * first_depo = angka TERKECIL dari semua baris milik id tersebut (null/kosong diabaikan)
 *
 * @param {Array} rows      hasil countingLot(): {id, ims_id, phone, fullname, broker, first_depo, lot}
 * @param {string} filePath lokasi file output (default: ./total_lot_by_id.xlsx)
 * @returns {Promise<Array>} data yang sudah digabung per id
 */
async function exportTotalLotToExcel(rows, filePath = path.join(process.cwd(), 'total_lot_by_id.xlsx')) {
    log('EXPORT', `gabungkan ${rows.length} baris berdasarkan id...`);

    // 1. Group per id
    const grouped = new Map();
    for (const r of rows) {
        const key = String(r.id);
        if (!grouped.has(key)) {
            grouped.set(key, { id: key, phone: r.phone, fullname: r.fullname, brokers: new Set(), first_depo: null, total_lot: 0 });
        }
        const g = grouped.get(key);
        if (r.broker) g.brokers.add(r.broker);
        g.total_lot += Number(r.lot) || 0; // lot null dianggap 0

        // first_depo: ambil angka paling kecil (abaikan null/kosong/bukan angka)
        if (r.first_depo !== null && r.first_depo !== undefined && r.first_depo !== '') {
            const depo = Number(r.first_depo);
            if (!Number.isNaN(depo) && (g.first_depo === null || depo < g.first_depo)) g.first_depo = depo;
        }
    }

    const data = [...grouped.values()].map((g) => ({
        id: g.id,
        phone: g.phone,
        fullname: g.fullname,
        broker: [...g.brokers].join(', '),
        first_depo: g.first_depo, // null = tidak ada data deposit
        total_lot: Math.round(g.total_lot * 100) / 100,
    }));
    log('EXPORT', `hasil gabungan: ${data.length} id unik`);

    // 2. Tulis Excel
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Total Lot');
    sheet.columns = [
        { header: 'id', key: 'id', width: 16, style: { numFmt: '@' } },          // teks, biar 0000 di depan aman
        { header: 'phone', key: 'phone', width: 18, style: { numFmt: '@' } },    // teks, biar 08xxx tidak jadi 8xxx
        { header: 'fullname', key: 'fullname', width: 30 },
        { header: 'broker', key: 'broker', width: 14 },
        { header: 'first_depo', key: 'first_depo', width: 16, style: { numFmt: '#,##0.00' } },
        { header: 'total_lot', key: 'total_lot', width: 12, style: { numFmt: '0.00' } },
    ];
    sheet.addRows(data);

    const header = sheet.getRow(1);
    header.font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: 'F1' };

    await workbook.xlsx.writeFile(filePath);
    log('EXPORT', `file Excel tersimpan: ${filePath}`);
    return data;
}

(async () => {
    const result = await countingLot();
    await exportTotalLotToExcel(result);
})().catch(() => process.exit(1));