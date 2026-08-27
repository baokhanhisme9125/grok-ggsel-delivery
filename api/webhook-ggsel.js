/**
 * /api/webhook-ggsel — GGSEL notification webhook for Grok
 * Captures id_i → calls GGSEL API → stores uniqueCode→orderId mapping
 */
const { verifyOrder } = require('../lib/ggsel');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON'); }
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

async function ensureSheet(sheets, name) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (!meta.data.sheets.some(s => s.properties.title === name)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
    });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const query = req.query || {};
  const body = req.body || {};
  const orderId = String(query.id_i || body.id_i || '').trim();

  if (!orderId || !/^\d+$/.test(orderId)) {
    return res.status(200).json({ ok: true, note: 'no orderId' });
  }

  try {
    const orderInfo = await verifyOrder(orderId);
    const uniqueCode = (orderInfo.raw && orderInfo.raw.name) ? String(orderInfo.raw.name).trim() : '';

    if (uniqueCode) {
      const auth = await getAuth();
      const sheets = google.sheets({ version: 'v4', auth });
      await ensureSheet(sheets, 'GrokCodeMap');
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'GrokCodeMap!A:C',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[ uniqueCode, orderId, new Date().toISOString() ]] },
      });
      console.log(`[grok-webhook] Mapped ${uniqueCode} → ${orderId}`);
    }
  } catch (e) {
    console.error('[grok-webhook] Error:', e.message);
  }

  return res.status(200).json({ ok: true });
};
