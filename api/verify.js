/**
 * /api/verify?orderid=XXX[&email=YYY]
 * GGSEL Grok delivery — single product (Grok Account)
 */
const { verifyOrder } = require('../lib/ggsel');
const {
  getNextAvailableAccount, deleteAccountRow, revertClaimedRow, saveOrder, savePendingOrder,
  findOrderByCode, findAllOrdersByCode, deleteOrderRow,
  isAccountAlreadyDelivered, findCompletedOrderByOrderId, SHEET_NAME,
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

    // Block old orders (> 7 days) — prevents stale/test orders from creating pending entries
    function parseDigiDate(str) {
      if (!str) return NaN;
      const d1 = new Date(str).getTime();
      if (!isNaN(d1)) return d1;
      const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
      if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`).getTime();
      const m2 = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
      if (m2) return new Date(`${m2[3]}-${m2[2]}-${m2[1]}T00:00:00Z`).getTime();
      return NaN;
    }
    const MAX_ORDER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const orderDate = parseDigiDate(orderInfo.datePay);
    // Only block if date is confirmed too old — unknown dates are allowed through
    if (!isNaN(orderDate) && Date.now() - orderDate > MAX_ORDER_AGE_MS) {
      return res.status(400).json({ success: false, error: 'This order has expired. Delivery is only available within 7 days of purchase.' });
    }

    const uniqueCode = ggselUUID || orderInfo.uniqueCode || '';
    const orderKey = uniqueCode || `ggsel-grok-${orderId}`;

    /* ── 2. Idempotency check ── */
    let hasPendingOrder = false;
    const existing = await findOrderByCode(orderKey);
    if (existing) {
      if (emailParam && emailParam !== (existing.buyerEmail || '').toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Email does not match.' });
      }
      if (!existing.isPending) return alreadyDeliveredResponse(res, existing, uniqueCode);
      // isPending: true — fall through and retry delivery from stock
      hasPendingOrder = true;
      console.log(`[grok-ggsel] Pending order found for key=${orderKey} — retrying delivery from stock`);
    }

    /* ── 3. Email match ── */
    if (emailParam && orderInfo.buyerEmail && orderInfo.buyerEmail !== emailParam) {
      return res.status(403).json({ success: false, error: 'Email does not match.' });
    }

    /* ── 3b. OrderId dedup — same order already delivered with different uniqueCode? ── */
    if (orderId && !hasPendingOrder) {
      const existingByOrderId = await findCompletedOrderByOrderId(orderId);
      if (existingByOrderId && existingByOrderId.uniqueCode !== orderKey) {
        console.warn(`[grok-ggsel] OrderId ${orderId} already delivered (code=${existingByOrderId.uniqueCode}), blocking duplicate`);
        return alreadyDeliveredResponse(res, existingByOrderId, uniqueCode);
      }
    }

    /* ── 4. Claim account atomically ── */
    const account = await getNextAvailableAccount(SHEET_NAME, orderKey);
    if (!account) {
      // Still OOS — if pending order already exists, don't save duplicate
      if (hasPendingOrder) {
        console.log(`[grok-ggsel] Still OOS for pending orderKey=${orderKey}`);
        return res.status(503).json({
          success: false, outOfStock: true, isPending: true,
          productName: 'Grok Account', ggselUUID: uniqueCode,
          error: 'Out of stock — your order is saved. Please refresh (F5) periodically to receive your account.',
        });
      }
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
      console.warn(`[grok-ggsel] Race detected for orderKey=${orderKey} — reverting claim`);
      try { await revertClaimedRow(SHEET_NAME, account.claimMark); } catch (e) { console.warn('[grok-ggsel] revert failed:', e.message); }
      return alreadyDeliveredResponse(res, raceCheck, uniqueCode);
    }

    /* ── 5b. Duplicate account check — uses cached deliveredSet (no extra API call) ── */
    const normalizedAccKey = `${account.email}:${account.password}`.toLowerCase().replace(/\s*:\s*/, ':');
    const accountDup = account._deliveredSet ? account._deliveredSet.has(normalizedAccKey) : await isAccountAlreadyDelivered(account.email, account.password);
    if (accountDup) {
      console.warn(`[grok-ggsel] DUPLICATE ACCOUNT BLOCKED: ${account.email} already delivered`);
      try { await revertClaimedRow(SHEET_NAME, account.claimMark); } catch (e) { console.warn('[grok-ggsel] revert failed:', e.message); }
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

    /* ── 7. Post-save: dedup + clean up pending rows ── */
    try {
      const allOrders = await findAllOrdersByCode(orderKey);
      if (allOrders.length > 1) {
        console.warn(`[grok-ggsel] ${allOrders.length} rows for key=${orderKey} — keeping last (completed), deleting earlier`);
        for (let i = 0; i < allOrders.length - 1; i++) {
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
