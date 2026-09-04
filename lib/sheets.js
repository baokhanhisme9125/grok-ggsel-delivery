const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON'); }
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

/* ── ORDERS SHEET name constant (declared early so getDeliveredAccountSet can use it) ── */
const ORDERS_SHEET = 'Grok Orders';

/* ── PRODUCT SHEET ("Grok Account") ─── Column A: Email:Password (also Email;Password) ──── */
const SHEET_NAME = 'Grok Account';

function parseAccountCell(cell) {
  if (!cell || cell.startsWith('CLAIMED:') || cell.startsWith('FORMAT_ERROR:')) return null;
  const atIdx = cell.indexOf('@');
  let sepIdx = -1, sep = null;
  if (atIdx >= 0) {
    const c = cell.indexOf(':', atIdx + 1), s = cell.indexOf(';', atIdx + 1);
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; } else if (s >= 0) { sepIdx = s; sep = ';'; }
  } else {
    const c = cell.indexOf(':'), s = cell.indexOf(';');
    if (c >= 0 && (s < 0 || c <= s)) { sepIdx = c; sep = ':'; } else if (s >= 0) { sepIdx = s; sep = ';'; }
  }
  if (sepIdx < 0 || !sep) return null;
  const email = cell.slice(0, sepIdx).trim(), password = cell.slice(sepIdx + 1).trim();
  if (!email || !password || !email.includes('@')) return null;
  return { email, password };
}


/**
 * Build a Set of account strings (email:password) already present in Column C
 * of the Orders sheet, so we never re-deliver the same account.
 */
async function getDeliveredAccountSet(sheets) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${ORDERS_SHEET}'!C:C`,
    });
    const rows = res.data.values || [];
    const used = new Set();
    for (const row of rows) {
      const cell = (row[0] || '').trim().toLowerCase();
      if (cell && cell.includes(':')) used.add(cell);
    }
    return used;
  } catch {
    return new Set();
  }
}

/**
 * Atomically claim the next available account using optimistic locking
 * + duplicate-account guard.
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;

  const [stockRes, deliveredSet] = await Promise.all([
    sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:A`,
    }),
    getDeliveredAccountSet(sheets),
  ]);

  const rows = stockRes.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell || cell.startsWith('CLAIMED:') || cell.startsWith('FORMAT_ERROR:')) continue;
    const parsed = parseAccountCell(cell);
    if (!parsed) {
      if (cell.includes(':') || cell.includes(';') || cell.includes('@')) {
        console.warn(`[sheets] FORMAT_ERROR row ${i + 1}`);
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${sheetTab}'!A${i + 1}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[`FORMAT_ERROR: ${cell}`]] },
          });
        } catch (e) { console.warn('[sheets] Could not write FORMAT_ERROR:', e.message); }
      }
      continue;
    }
    const { email, password } = parsed;

    // ── Duplicate guard ──
    const normalized = `${email}:${password}`.toLowerCase();
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Skipping already-delivered account at row ${i + 1}: ${email}`);
      continue;
    }

    // ── Optimistic lock: claim this row ──
    const claimMark = `CLAIMED:${uniqueCode || Date.now()}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetTab}'!A${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark]] },
      });
    } catch (writeErr) {
      console.warn(`[sheets] Claim write failed row ${i + 1}:`, writeErr.message);
      continue;
    }

    await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 250)));

    let verifyCell = '';
    try {
      const vRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetTab}'!A${i + 1}`,
      });
      verifyCell = (vRes.data.values?.[0]?.[0] || '').trim();
    } catch {
      continue;
    }

    if (verifyCell === claimMark) {
      return { rowIndex: i + 1, email, password };
    }
    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null;
}

async function deleteAccountRow(sheetName, rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] },
  });
}


/* ── ORDERS SHEET ("Grok Orders") ── H: DeliveryLink ───────────────── */


async function saveOrder({ uniqueCode, buyerEmail, accountEmail, accountPassword, orderId, productType, productName, ggselUUID }) {
  const sheets = await getSheetsClient();
  const deliveryLink = ggselUUID
    ? `https://grok-ggsel-delivery.vercel.app/delivery.html?uniquecode=${encodeURIComponent(ggselUUID)}`
    : `https://grok-ggsel-delivery.vercel.app/delivery.html?orderid=${encodeURIComponent(orderId)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ uniqueCode, buyerEmail, `${accountEmail}:${accountPassword}`, new Date().toISOString(), orderId, productType, productName, deliveryLink ]] },
  });
}

async function savePendingOrder({ uniqueCode, buyerEmail, orderId, productType, productName, ggselUUID }) {
  const sheets = await getSheetsClient();
  const deliveryLink = ggselUUID
    ? `https://grok-ggsel-delivery.vercel.app/delivery.html?uniquecode=${encodeURIComponent(ggselUUID)}`
    : `https://grok-ggsel-delivery.vercel.app/delivery.html?orderid=${encodeURIComponent(orderId)}&email=${encodeURIComponent(buyerEmail)}`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[ uniqueCode, buyerEmail, '', new Date().toISOString(), orderId, productType, productName, deliveryLink ]] },
  });
}

async function findOrderByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${ORDERS_SHEET}'!A:G` });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const ac = rows[i][2] || '', ci = ac.indexOf(':');
      return {
        uniqueCode: rows[i][0]||'', buyerEmail: rows[i][1]||'',
        accountEmail: ci>=0?ac.slice(0,ci).trim():ac, accountPassword: ci>=0?ac.slice(ci+1).trim():'',
        soldAt: rows[i][3]||'', orderId: rows[i][4]||'', productType: rows[i][5]||'', productName: rows[i][6]||'Grok Account',
        isPending: !ac.includes(':'),
      };
    }
  }
  return null;
}

async function findRecentOrderByEmail(buyerEmail, windowMs = 10 * 60 * 1000) {
  if (!buyerEmail || buyerEmail === 'unknown') return null;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${ORDERS_SHEET}'!A:G` });
  const rows = res.data.values || [];
  const now = Date.now();
  const email = buyerEmail.trim().toLowerCase();
  let bestMatch = null;
  for (let i = 0; i < rows.length; i++) {
    const rowEmail = (rows[i][1] || '').trim().toLowerCase();
    if (rowEmail !== email) continue;
    const soldAt = rows[i][3] || '';
    const orderTime = new Date(soldAt).getTime();
    if (isNaN(orderTime) || now - orderTime > windowMs) continue;
    const ac = rows[i][2] || '', ci = ac.indexOf(':');
    bestMatch = {
      uniqueCode: rows[i][0]||'', buyerEmail: rows[i][1]||'',
      accountEmail: ci>=0?ac.slice(0,ci).trim():ac, accountPassword: ci>=0?ac.slice(ci+1).trim():'',
      soldAt, orderId: rows[i][4]||'', productType: rows[i][5]||'', productName: rows[i][6]||'Grok Account',
      isPending: !ac.includes(':'),
    };
  }
  return bestMatch;
}

async function getAllStock() {
  const sheets = await getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${SHEET_NAME}'!A:A` });
    const rows = (res.data.values||[]).filter(r=>(r[0]||'').trim().includes(':'));
    return [{ key:'grok', name:'Grok Account', available:rows.length, total:rows.length }];
  } catch { return [{ key:'grok', name:'Grok Account', available:0, total:0 }]; }
}

module.exports = { getNextAvailableAccount, deleteAccountRow, saveOrder, savePendingOrder, findOrderByCode, findRecentOrderByEmail, getAllStock, SHEET_NAME, ORDERS_SHEET };
