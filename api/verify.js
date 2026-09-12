/**
 * /api/verify?orderid=XXX[&email=YYY]
 * GGSEL Grok delivery — single product (Grok Account)
 */
const { verifyOrder } = require('../lib/ggsel');
const {
  getNextAvailableAccount, deleteAccountRow, saveOrder, savePendingOrder,
  findOrderByCode, findAllOrdersByCode, deleteOrderRow,
  isAccountAlreadyDelivered, SHEET_NAME,
} = require('../lib/sheets');

function alreadyDeliveredResponse(res, order, ggselUUID) {
  return res.status(200).json({
    success: true, alreadyDelivered: true,
    account: { email: order.accountEmail, password: order.accountPassword },
    order: { orderId: order.orderId, buyerEmail: order.buyerEmail, soldAt: order.soldAt, productType: order.productType, productName: order.productName, ggselUUID: ggselUUID || '' },
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

  try {
    /* ── 1. Verify via GGSEL API ── */
    let orderInfo;
    try { orderInfo = await verifyOrder(orderId); }
    catch (err) { return res.status(404).json({ success: false, error: err.message }); }

    if (!orderInfo.isPaid) return res.status(400).json({ success: false, error: 'Order not paid.' });

    const uniqueCode = ggselUUID || orderInfo.uniqueCode || '';
    const orderKey = uniqueCode || `ggsel-grok-${orderId}`;

    /* ── 2. Idempotency check ── */
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam && emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Email does not match.' });
      }
      if (existing.isPending) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: existing.productName, ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
      return alreadyDeliveredResponse(res, existing, uniqueCode);
    }

    /* ── 3. Email match ── */
    if (emailParam && orderInfo.buyerEmail && orderInfo.buyerEmail !== emailParam) {
      return res.status(403).json({ success: false, error: 'Email does not match.' });
    }

    /* ── 4. Claim account atomically ── */
    const account = await getNextAvailableAccount(SHEET_NAME, orderKey);
    if (!account) {
      const pendingCheck = await findOrderByCode(orderKey);
      if (pendingCheck) {
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: pendingCheck.productName, ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically.',
        });
      }
      await savePendingOrder({
        uniqueCode: orderKey, buyerEmail: orderInfo.buyerEmail,
        orderId, productType: 'grok', productName: 'Grok Account (GGSEL)', ggselUUID: uniqueCode,
      });
      console.log(`[grok-ggsel] OOS — saved pending for ${orderId}`);
      return res.status(503).json({
        success: false, outOfStock: true, isPending: true,
        productName: 'Grok Account', ggselUUID: uniqueCode,
        error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
      });
    }

    /* ── 5. Double-check Orders (cross-instance race) ── */
    const raceCheck = await findOrderByCode(orderKey);
    if (raceCheck && !raceCheck.isPending) {
      console.warn(`[grok-ggsel] Race detected for orderKey=${orderKey}`);
      // Claimed row will auto-revert from Column B backup
      return alreadyDeliveredResponse(res, raceCheck, uniqueCode);
    }

    /* ── 5b. FRESH duplicate account check ── */
    const accountDup = await isAccountAlreadyDelivered(account.email, account.password);
    if (accountDup) {
      console.warn(`[grok-ggsel] DUPLICATE ACCOUNT BLOCKED: ${account.email} already delivered`);
      return res.status(500).json({
        success: false,
        error: 'Account conflict detected. Please try again.',
      });
    }

    /* ── 6. Delete claimed row + save order ── */
    await deleteAccountRow(SHEET_NAME, account.rowIndex, account.claimMark);
    await saveOrder({
      uniqueCode: orderKey, buyerEmail: orderInfo.buyerEmail,
      accountEmail: account.email, accountPassword: account.password,
      orderId, productType: 'grok', productName: 'Grok Account (GGSEL)', ggselUUID: uniqueCode,
    });

    /* ── 7. Post-save duplicate detection ── */
    try {
      const allOrders = await findAllOrdersByCode(orderKey);
      if (allOrders.length > 1) {
        console.warn(`[grok-ggsel] DUPLICATE: ${allOrders.length} orders for key=${orderKey}. Cleaning...`);
        for (let i = 1; i < allOrders.length; i++) {
          await deleteOrderRow(allOrders[i].rowIndex);
        }
      }
    } catch (e) { console.warn('[grok-ggsel] Dedup error:', e.message); }

    console.log(`[grok-ggsel] Delivered for order ${orderId}`);

    return res.status(200).json({
      success: true, alreadyDelivered: false,
      account: { email: account.email, password: account.password },
      order: { orderId, buyerEmail: orderInfo.buyerEmail, soldAt: new Date().toISOString(), productType: 'grok', productName: 'Grok Account (GGSEL)', ggselUUID: uniqueCode },
    });
  } catch (err) {
    console.error('[grok-ggsel-verify] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
};
