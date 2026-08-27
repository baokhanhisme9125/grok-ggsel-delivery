/**
 * /api/resolve-uuid?uuid=XXX — Resolve GGSEL payment UUID to numeric order ID
 * Fetches the GGSEL payment page and extracts the numeric order number
 */
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const uuid = (req.query.uuid || '').trim();
  if (!uuid) return res.status(400).json({ success: false, error: 'Missing uuid.' });

  try {
    // Fetch the GGSEL payment page to extract numeric order ID
    const pageRes = await fetch(`https://payment.ggsel.com/en/order/${uuid}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!pageRes.ok) {
      return res.status(404).json({ success: false, error: 'Order page not found.' });
    }

    const html = await pageRes.text();

    // Look for "Order № 46655977" or "Заказ № 46655977" pattern
    const match = html.match(/(?:Order|Заказ)\s*[№#]\s*(\d+)/i)
               || html.match(/"order_id"\s*:\s*(\d+)/i)
               || html.match(/"id_i"\s*:\s*(\d+)/i)
               || html.match(/id_i=(\d+)/i);

    if (!match) {
      return res.status(404).json({ success: false, error: 'Could not extract order ID from page.' });
    }

    return res.status(200).json({ success: true, orderId: match[1], uuid });
  } catch (err) {
    console.error('[resolve-uuid] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
};
