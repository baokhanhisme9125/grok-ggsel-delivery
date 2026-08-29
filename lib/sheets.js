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

/* ── PRODUCT SHEET ("Grok Account") ─── Column A: Email:Password ──── */
const SHEET_NAME = 'Grok Account';

async function getNextAvailableAccount(sheetName) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName || SHEET_NAME}'!A:A`,
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell || !cell.includes(':')) continue;
    const colonIdx = cell.indexOf(':');
    const email = cell.slice(0, colonIdx).trim();
    const password = cell.slice(colonIdx + 1).trim();
    if (!email || !password) continue;
    return { rowIndex: i + 1, email, password };
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
const ORDERS_SHEET = 'Grok Orders';

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
