/**
 * /api/verify?orderid=XXX[&email=YYY]
 * GGSEL Grok delivery — single product (Grok Account)
 */
const { verifyOrder } = require('../lib/ggsel');
const { getNextAvailableAccount, deleteAccountRow, saveOrder, findOrderByCode, SHEET_NAME } = require('../lib/sheets');

const _pending = new Map();
const PENDING_TTL = 30_000;

function cleanPending() {
  const now = Date.now();
  for (const [k, t] of _pending) { if (now - t > PENDING_TTL) _pending.delete(k); }
}

function alreadyDeliveredResponse(res, order) {
  return res.status(200).json({
    success: true, alreadyDelivered: true,
    account: { email: order.accountEmail, password: order.accountPassword },
    order: { orderId: order.orderId, buyerEmail: order.buyerEmail, soldAt: order.soldAt, productType: order.productType, productName: order.productName },
  });
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const orderId    = (req.query.orderid || '').trim();
  const emailParam = (req.query.email   || '').trim().toLowerCase();
  const ggselUUID  = (req.query.ggsel_uuid || '').trim();

  if (!orderId) return res.status(400).json({ success: false, error: 'Missing Order ID.' });

  const orderKey = `ggsel-grok-${orderId}`;

  try {
    cleanPending();
    if (_pending.has(orderKey)) {
      await new Promise(r => setTimeout(r, 3000));
      const existing = await findOrderByCode(orderKey);
      if (existing) return alreadyDeliveredResponse(res, existing);
      return res.status(429).json({ success: false, error: 'Order being processed. Wait and refresh.' });
    }
    _pending.set(orderKey, Date.now());

    // Idempotency
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam && emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Email does not match.' });
      }
      return alreadyDeliveredResponse(res, existing);
    }

    // Verify via GGSEL API
    let orderInfo;
    try { orderInfo = await verifyOrder(orderId); }
    catch (err) { return res.status(404).json({ success: false, error: err.message }); }

    if (!orderInfo.isPaid) return res.status(400).json({ success: false, error: 'Order not paid.' });

    // Email match
    if (emailParam && orderInfo.buyerEmail && orderInfo.buyerEmail !== emailParam) {
      return res.status(403).json({ success: false, error: 'Email does not match.' });
    }

    // Get account from Grok Account sheet
    const account = await getNextAvailableAccount(SHEET_NAME);
    if (!account) {
      return res.status(503).json({ success: false, outOfStock: true, productName: 'Grok Account', error: 'Out of stock. Contact support.' });
    }

    // Race-condition guard
    const raceCheck = await findOrderByCode(orderKey);
    if (raceCheck) return alreadyDeliveredResponse(res, raceCheck);

    // Deliver
    await deleteAccountRow(SHEET_NAME, account.rowIndex);
    await saveOrder({
      uniqueCode: orderKey, buyerEmail: orderInfo.buyerEmail,
      accountEmail: account.email, accountPassword: account.password,
      orderId, productType: 'grok', productName: 'Grok Account (GGSEL)', ggselUUID,
    });

    console.log(`[grok-ggsel] Delivered for order ${orderId}`);

    return res.status(200).json({
      success: true, alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: { orderId, buyerEmail: orderInfo.buyerEmail, soldAt: new Date().toISOString(), productType: 'grok', productName: 'Grok Account (GGSEL)' },
    });
  } catch (err) {
    console.error('[grok-ggsel-verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error.' });
  } finally { _pending.delete(orderKey); }
};
