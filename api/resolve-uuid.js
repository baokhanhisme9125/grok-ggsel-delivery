/**
 * /api/resolve-uuid?uuid=XXX — Resolve GGSEL unique code/UUID to numeric order ID
 * Uses GGSEL Seller API: GET /purchases/unique-code/:unique_code
 */
const { getToken } = require('../lib/ggsel');

const GGSEL_API = 'https://seller.ggsel.com/api_sellers/api';

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const uuid = (req.query.uuid || '').trim();
  if (!uuid) return res.status(400).json({ success: false, error: 'Missing uuid.' });

  try {
    const token = await getToken();
    
    // GGSEL API: resolve unique code → numeric order ID
    const apiRes = await fetch(`${GGSEL_API}/purchases/unique-code/${encodeURIComponent(uuid)}?token=${token}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    
    const data = await apiRes.json();
    
    if (data.retval !== 0 || !data.inv) {
      return res.status(404).json({ 
        success: false, 
        error: 'Could not resolve UUID.', 
        debug: { retval: data.retval, retdesc: data.retdesc } 
      });
    }

    return res.status(200).json({ 
      success: true, 
      orderId: String(data.inv), 
      uuid,
      productId: data.id_goods,
    });
  } catch (err) {
    console.error('[resolve-uuid] Error:', err.message);
    return res.status(500).json({ success: false, error: 'Server error.' });
  }
};
