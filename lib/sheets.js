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

const ORDERS_SHEET = 'Grok Orders';
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

async function getDeliveredAccountSet(sheets) {
  // Throws on error — caller must handle with retry. Never return empty Set silently.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ORDERS_SHEET}'!C:C`,
  });
  const rows = res.data.values || [];
  const used = new Set();
  for (const row of rows) {
    const raw = (row[0] || '').trim();
    if (!raw || raw.startsWith('CLAIMED:')) continue;
    // Normalize: lowercase + remove spaces around colon separator
    const cell = raw.toLowerCase().replace(/\s*:\s*/, ':');
    if (cell.includes(':')) used.add(cell);
  }
  return used;
}

/**
 * Revert stale CLAIMED rows from Column B backup.
 */
async function cleanupClaimedRows(sheets, sheetTab) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:B`,
    });
    const rows = res.data.values || [];
    const STALE_MS = 5 * 60 * 1000;

    for (let i = 0; i < rows.length; i++) {
      const cell = (rows[i][0] || '').trim();
      if (!cell.startsWith('CLAIMED:')) continue;
      const backup = (rows[i][1] || '').trim();
      const rest = cell.slice('CLAIMED:'.length);
      const ts = parseInt(rest, 10);
      if (!isNaN(ts) && ts > 1700000000000 && Date.now() - ts > STALE_MS) {
        if (backup) {
          console.warn(`[sheets] Reverting stale CLAIMED row ${i + 1} from backup`);
          try {
            await sheets.spreadsheets.values.update({
              spreadsheetId: SPREADSHEET_ID,
              range: `'${sheetTab}'!A${i + 1}:B${i + 1}`,
              valueInputOption: 'RAW',
              requestBody: { values: [[backup, '']] },
            });
          } catch (e) { console.warn(`[sheets] Revert row ${i + 1} failed:`, e.message); }
        } else {
          console.warn(`[sheets] Stale CLAIMED row ${i + 1} has NO backup — account may be lost`);
        }
      }
    }
  } catch (e) {
    console.warn('[sheets] cleanupClaimedRows failed:', e.message);
  }
}

/**
 * Atomically claim the next available account.
 * Backs up original to Column B before claiming.
 */
async function getNextAvailableAccount(sheetName, uniqueCode) {
  if (!uniqueCode) throw new Error('[sheets] uniqueCode is required for claiming');
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;

  // Get sheet metadata for batchUpdate (needed to delete rows)
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheetTab);
  if (!sheetMeta) throw new Error(`Sheet "${sheetTab}" not found`);
  const sheetId = sheetMeta.properties.sheetId;

  // Cleanup stale CLAIMED rows in background
  cleanupClaimedRows(sheets, sheetTab).catch(() => {});

  // Fetch stock + delivered accounts — retry once on transient failure
  let stockRes, deliveredSet;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      [stockRes, deliveredSet] = await Promise.all([
        sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${sheetTab}'!A:B`,
        }),
        getDeliveredAccountSet(sheets),
      ]);
      break;
    } catch (fetchErr) {
      console.error(`[sheets] getNextAvailableAccount fetch attempt ${attempt} failed:`, fetchErr.message);
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.error('[sheets] ABORT — could not fetch stock or deliveredSet after retries');
        return null;
      }
    }
  }

  const rows = stockRes.data.values || [];

  // Guard: already claimed by same code
  const alreadyClaimed = rows.some(r => (r[0] || '').trim() === `CLAIMED:${uniqueCode}`);
  if (alreadyClaimed) {
    console.log(`[sheets] CLAIMED:${uniqueCode} already exists — waiting...`);
    await new Promise(r => setTimeout(r, 800));
    return null;
  }

  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i][0] || '').trim();
    if (!cell || cell.startsWith('CLAIMED:') || cell.startsWith('FORMAT_ERROR:')) continue;
    const parsed = parseAccountCell(cell);
    if (!parsed) {
      if (cell.includes(':') || cell.includes(';') || cell.includes('@')) {
        try {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `'${sheetTab}'!A${i + 1}`,
            valueInputOption: 'RAW',
            requestBody: { values: [[`FORMAT_ERROR: ${cell}`]] },
          });
        } catch (e) { /* ignore */ }
      }
      continue;
    }
    const { email, password } = parsed;

    // Duplicate guard — account already delivered to another buyer → delete ghost row
    const normalized = `${email}:${password}`.toLowerCase().replace(/\s*:\s*/, ':');
    if (deliveredSet.has(normalized)) {
      console.warn(`[sheets] Already-delivered account at row ${i + 1}: ${email} — deleting from stock`);
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 } } }] },
        });
        rows.splice(i, 1);
        i--;
      } catch (e) { console.warn(`[sheets] Could not delete ghost row ${i + 1}:`, e.message); }
      continue;
    }

    // ── Backup to Column B, then claim Column A ──
    const claimMark = `CLAIMED:${uniqueCode}`;
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetTab}'!A${i + 1}:B${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[claimMark, cell]] },  // A=CLAIMED, B=backup
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
      return { rowIndex: i + 1, email, password, claimMark };
    }
    console.warn(`[sheets] Row ${i + 1} race lost (got: ${verifyCell.slice(0, 40)}), trying next`);
  }

  return null;
}

async function deleteAccountRow(sheetName, rowIndex, claimMark) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  const sheetId = sheet.properties.sheetId;

  if (claimMark) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${sheetName}'!A:A` });
    const allRows = res.data.values || [];
    const indices = allRows.reduce((acc, r, i) => { if ((r[0] || '').trim() === claimMark) acc.push(i); return acc; }, []);
    for (let j = indices.length - 1; j >= 0; j--) {
      try {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: indices[j], endIndex: indices[j] + 1 } } }] },
        });
      } catch (e) { console.warn(`deleteAccountRow failed index ${indices[j]}:`, e.message); }
    }
    return;
  }

  if (rowIndex) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] },
    });
  }
}

/* ── ORDERS ── */

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

async function findAllOrdersByCode(uniqueCode) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${ORDERS_SHEET}'!A:G` });
  const rows = res.data.values || [];
  const matches = [];
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][0] || '').trim() === uniqueCode.trim()) {
      const ac = rows[i][2] || '', ci = ac.indexOf(':');
      matches.push({
        rowIndex: i + 1,
        uniqueCode: rows[i][0]||'', buyerEmail: rows[i][1]||'',
        accountEmail: ci>=0?ac.slice(0,ci).trim():ac, accountPassword: ci>=0?ac.slice(ci+1).trim():'',
        soldAt: rows[i][3]||'', orderId: rows[i][4]||'', productType: rows[i][5]||'', productName: rows[i][6]||'Grok Account',
        isPending: !ac.includes(':'),
      });
    }
  }
  return matches;
}

async function deleteOrderRow(rowIndex) {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = meta.data.sheets.find(s => s.properties.title === ORDERS_SHEET);
  if (!sheet) throw new Error('Orders sheet not found');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex } } }] },
  });
}

async function revertClaimedRow(sheetName, claimMark) {
  const sheets = await getSheetsClient();
  const sheetTab = sheetName || SHEET_NAME;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetTab}'!A:B`,
    });
    const rows = res.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i][0] || '').trim() !== claimMark) continue;
      const backup = (rows[i][1] || '').trim();
      if (backup) {
        console.warn(`[sheets] Reverting CLAIMED row ${i + 1} → backup: ${backup.slice(0, 40)}`);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `'${sheetTab}'!A${i + 1}:B${i + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[backup, '']] },
        });
      } else {
        console.warn(`[sheets] revertClaimedRow: no backup for row ${i + 1}, marker=${claimMark}`);
      }
      return;
    }
    console.warn(`[sheets] revertClaimedRow: marker not found: ${claimMark}`);
  } catch (e) {
    console.warn('[sheets] revertClaimedRow failed:', e.message);
  }
}

async function isAccountAlreadyDelivered(accountEmail, accountPassword) {
  const needle = `${accountEmail}:${accountPassword}`.toLowerCase().replace(/\s*:\s*/, ':');
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const sheets = await getSheetsClient();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${ORDERS_SHEET}'!C:C`,
      });
      const rows = res.data.values || [];
      for (const row of rows) {
        const cell = (row[0] || '').trim().toLowerCase().replace(/\s*:\s*/, ':');
        if (cell === needle) return true;
      }
      return false;
    } catch (e) {
      console.warn(`[sheets] isAccountAlreadyDelivered attempt ${attempt} failed:`, e.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 300));
    }
  }
  // Fail-open: account loss is worse than rare duplicate
  console.warn('[sheets] isAccountAlreadyDelivered: all retries failed — allowing delivery (fail-open)');
  return false;
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
    const rows = (res.data.values||[]).filter(r => {
      const c = (r[0]||'').trim();
      return parseAccountCell(c) !== null;
    });
    return [{ key:'grok', name:'Grok Account', available:rows.length, total:rows.length }];
  } catch { return [{ key:'grok', name:'Grok Account', available:0, total:0 }]; }
}

module.exports = {
  getNextAvailableAccount, deleteAccountRow, revertClaimedRow, saveOrder, savePendingOrder,
  findOrderByCode, findAllOrdersByCode, deleteOrderRow,
  isAccountAlreadyDelivered, findRecentOrderByEmail, getAllStock,
  SHEET_NAME, ORDERS_SHEET,
};
