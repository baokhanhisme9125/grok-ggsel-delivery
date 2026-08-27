/**
 * /api/lookup-code?code=UUID — Auto-deliver Grok via unique code mapping
 */
const { verifyOrder } = require('../lib/ggsel');
const { getNextAvailableAccount, deleteAccountRow, saveOrder, findOrderByCode, SHEET_NAME } = require('../lib/sheets');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth() {
  let credentials;
  try { credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}'); }
  catch { throw new Error('Invalid GOOGLE_SERVICE_ACCOUNT JSON'); }
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
}

async function findOrderIdByUniqueCode(uniqueCode) {
  const auth = await getAuth();
  const sheets = google.sheets({ version: 'v4', auth });
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'GrokCodeMap!A:B' });
    for (const row of (res.data.values || [])) {
      if ((row[0] || '').trim() === uniqueCode.trim()) return (row[1] || '').trim();
    }
  } catch (e) { console.log('[grok-lookup] GrokCodeMap not found:', e.message); }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const uniqueCode = (req.query.code || '').trim();
  if (!uniqueCode) return res.status(400).json({ success: false, error: 'Missing code.' });

  try {
    const orderId = await findOrderIdByUniqueCode(uniqueCode);
    if (!orderId) return res.status(404).json({ success: false, needOrderId: true, error: 'Code not mapped yet.' });

    const orderKey = `ggsel-grok-${orderId}`;
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      return res.status(200).json({
        success: true, alreadyDelivered: true,
        account: { email: existing.accountEmail, password: existing.accountPassword },
        order: { orderId: existing.orderId, buyerEmail: existing.buyerEmail, soldAt: existing.soldAt },
      });
    }

    const orderInfo = await verifyOrder(orderId);
    if (!orderInfo.isPaid) return res.status(400).json({ success: false, error: 'Order not paid.' });

    const account = await getNextAvailableAccount(SHEET_NAME);
    if (!account) return res.status(503).json({ success: false, outOfStock: true, error: 'Out of stock.' });

    await deleteAccountRow(SHEET_NAME, account.rowIndex);
    await saveOrder({
      uniqueCode: orderKey, buyerEmail: orderInfo.buyerEmail,
      accountEmail: account.email, accountPassword: account.password,
      orderId, productType: 'grok', productName: 'Grok Account (GGSEL)',
    });

    return res.status(200).json({
      success: true, alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: { orderId, buyerEmail: orderInfo.buyerEmail, soldAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[grok-lookup] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
};
