/**
 * Restaurant Excellence — Cloudflare Worker
 * Routes:
 *   POST /         → Anthropic API proxy
 *   POST /places   → Google Places lookup (rating, reviews, address, etc.)
 *   POST /search   → Google Custom Search (community mentions, partnerships)
 */

export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/places')     return handlePlaces(request, env);
    if (url.pathname === '/search')     return handleSearch(request, env);
    if (url.pathname === '/contact')    return handleContact(request, env);
    if (url.pathname === '/send-audit') return handleSendAudit(request, env);
    return handleAnthropic(request, env);
  },
};

/* ─── ANTHROPIC PROXY ─── */
async function handleAnthropic(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: { message: 'ANTHROPIC_API_KEY secret not set in Worker' } }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: { message: 'Invalid JSON body' } }, 400); }

  console.log('Calling Anthropic with model:', body.model);

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Fetch to Anthropic failed:', err.message);
    return json({ error: { message: 'Failed to reach Anthropic: ' + err.message } }, 502);
  }

  const data = await resp.json();
  console.log('Anthropic status:', resp.status, JSON.stringify(data).slice(0, 200));
  return json(data, resp.status);
}

/* ─── GOOGLE PLACES LOOKUP ─── */
async function handlePlaces(request, env) {
  if (!env.GOOGLE_API_KEY) {
    return json({ error: 'GOOGLE_API_KEY not configured in Worker secrets' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { name, location } = body;
  if (!name) return json({ error: 'Restaurant name is required' }, 400);

  const query = encodeURIComponent(`${name} ${location || ''} restaurant`);
  const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&type=restaurant&key=${env.GOOGLE_API_KEY}`;

  console.log('Places search:', name, location);

  let searchResp, searchData;
  try {
    searchResp = await fetch(searchUrl);
    searchData = await searchResp.json();
  } catch (err) {
    return json({ error: 'Failed to reach Google Places: ' + err.message }, 502);
  }

  if (searchData.status === 'REQUEST_DENIED') {
    console.error('Places API denied:', searchData.error_message);
    return json({ error: 'Google API key issue: ' + searchData.error_message }, 403);
  }

  if (!searchData.results || searchData.results.length === 0) {
    return json({ found: false, message: 'Restaurant not found on Google Maps' });
  }

  // Use the top result
  const place = searchData.results[0];

  // Fetch additional details
  const fields = 'name,rating,user_ratings_total,formatted_address,website,opening_hours,price_level,formatted_phone_number,business_status';
  const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=${fields}&key=${env.GOOGLE_API_KEY}`;

  let details = {};
  try {
    const detailsResp = await fetch(detailsUrl);
    const detailsData = await detailsResp.json();
    details = detailsData.result || {};
  } catch (err) {
    console.warn('Place details fetch failed, using text search data:', err.message);
  }

  const rating      = details.rating            ?? place.rating            ?? null;
  const reviewCount = details.user_ratings_total ?? place.user_ratings_total ?? null;
  const address     = details.formatted_address  ?? place.formatted_address  ?? null;

  return json({
    found:       true,
    name:        details.name    || place.name,
    rating:      rating,
    reviewCount: reviewCount,
    address:     address,
    hasWebsite:  !!details.website,
    website:     details.website || null,
    hasHours:    !!(details.opening_hours),
    isOpenNow:   details.opening_hours?.open_now ?? null,
    priceLevel:  details.price_level ?? null,
    phone:       details.formatted_phone_number || null,
    operational: details.business_status === 'OPERATIONAL',
  });
}

/* ─── GOOGLE CUSTOM SEARCH ─── */
async function handleSearch(request, env) {
  if (!env.GOOGLE_API_KEY || !env.GOOGLE_CX) {
    return json({ error: 'GOOGLE_API_KEY and GOOGLE_CX must both be set in Worker secrets' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { query } = body;
  if (!query) return json({ error: 'Search query is required' }, 400);

  const searchUrl = `https://www.googleapis.com/customsearch/v1?key=${env.GOOGLE_API_KEY}&cx=${env.GOOGLE_CX}&q=${encodeURIComponent(query)}&num=5`;

  console.log('Custom search:', query);

  let resp, data;
  try {
    resp  = await fetch(searchUrl);
    data  = await resp.json();
  } catch (err) {
    return json({ error: 'Failed to reach Google Search: ' + err.message }, 502);
  }

  if (data.error) {
    console.error('Search API error:', data.error.message);
    return json({ error: data.error.message }, data.error.code || 500);
  }

  return json({
    totalResults: data.searchInformation?.totalResults || '0',
    results: (data.items || []).map(item => ({
      title:   item.title,
      snippet: item.snippet,
      link:    item.link,
    })),
  });
}

/* ─── SEND AUDIT → EMAIL + NEWSLETTER (Resend) ─── */
async function handleSendAudit(request, env) {
  if (!env.RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY not configured' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { name, email, category, score, headline, fileName, fileBase64 } = body;
  if (!name || !email || !fileBase64) {
    return json({ error: 'name, email, and fileBase64 are required' }, 400);
  }

  const level     = score < 40 ? 'CRITICAL' : score < 70 ? 'DEVELOPING' : 'STRONG';
  const levelColor = score < 40 ? '#ef4444'  : score < 70 ? '#f59e0b'   : '#22c55e';
  const scoreBar   = Math.round(score);

  /* ── Email to the operator (with Excel attached) ── */
  const userHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0edf8;font-family:Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0edf8;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 28px rgba(76,29,149,0.12);">

      <!-- Header -->
      <tr>
        <td style="background:linear-gradient(135deg,#1e0a3c 0%,#4c1d95 100%);padding:40px 48px 36px;">
          <div style="font-family:Georgia,serif;font-size:24px;font-weight:700;color:#ffffff;margin-bottom:4px;">Restaurant<span style="color:#c9a84c;">Excellence</span></div>
          <div style="font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.45);">Your Audit Results</div>
        </td>
      </tr>

      <!-- Score banner -->
      <tr>
        <td style="background:#0d0014;padding:28px 48px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <div style="font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.4);margin-bottom:6px;">${category}</div>
                <div style="font-family:Georgia,serif;font-size:52px;font-weight:700;color:#ffffff;line-height:1;">${scoreBar}<span style="font-size:22px;color:rgba(255,255,255,0.4);font-weight:400;"> / 100</span></div>
                <div style="display:inline-block;margin-top:8px;padding:4px 14px;background:${levelColor}22;border:1px solid ${levelColor}66;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:2px;color:${levelColor};">${level}</div>
              </td>
              <td width="180" align="right">
                <!-- Score bar -->
                <table cellpadding="0" cellspacing="0">
                  <tr><td style="background:rgba(255,255,255,0.08);border-radius:99px;width:140px;height:10px;overflow:hidden;">
                    <div style="background:${levelColor};width:${scoreBar}%;height:10px;border-radius:99px;"></div>
                  </td></tr>
                  <tr><td style="font-size:10px;color:rgba(255,255,255,0.3);padding-top:6px;text-align:right;">Industry avg: 42</td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td style="padding:40px 48px;">
          <p style="margin:0 0 10px;font-family:Georgia,serif;font-size:20px;font-weight:700;color:#1e0a3c;line-height:1.35;">Hi ${name},</p>
          <p style="margin:0 0 24px;font-size:14px;color:#374151;line-height:1.75;">Your <strong>${category}</strong> is attached as an Excel tracker — it includes your action plan, a 12-week progress log, and monthly KPI targets. Open it, save it somewhere you'll see it, and start with Step 1 this week.</p>

          ${headline ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
            <tr>
              <td style="background:#faf7ff;border-left:4px solid #7c3aed;border-radius:4px;padding:16px 20px;">
                <div style="font-size:10px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#9f7aea;margin-bottom:6px;">The Real Problem</div>
                <div style="font-size:14px;color:#1e0a3c;line-height:1.65;font-style:italic;">"${headline}"</div>
              </td>
            </tr>
          </table>` : ''}

          <p style="margin:0 0 24px;font-size:14px;color:#374151;line-height:1.75;">The tracker inside shows you exactly what to do in the next 7 days, this month, and over 90 days. Fill in your baselines, check things off as you go, and revisit your score in 30 days.</p>

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
            <tr>
              <td style="background:linear-gradient(135deg,#6b21a8,#7c3aed);border-radius:4px;padding:14px 30px;">
                <a href="https://restaurantexcellence.com/#contact" style="font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#ffffff;text-decoration:none;">Book a Free Strategy Call →</a>
              </td>
            </tr>
          </table>

          <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.65;">Questions? Just reply to this email — we read every one.<br><br>— The Restaurant Excellence Team</p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="background:#f9f7ff;border-top:1px solid #e8e0f5;padding:20px 48px;">
          <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.6;">You received this because you completed a Restaurant Excellence audit at restaurantexcellence.com.<br>This email was sent to ${email}.</p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  /* ── Lead notification to pierce ── */
  const leadHtml = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:32px 20px;background:#f5f5f5;font-family:Helvetica,Arial,sans-serif;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;margin:0 auto;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:linear-gradient(135deg,#1e0a3c,#4c1d95);padding:28px 36px;">
    <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#fff;">Restaurant<span style="color:#c9a84c;">Excellence</span></div>
    <div style="font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,.45);margin-top:4px;">New Audit Lead</div>
  </td></tr>
  <tr><td style="padding:28px 36px;">
    <p style="margin:0 0 20px;font-size:14px;color:#374151;">Someone just completed an audit and requested their results.</p>
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:10px 14px;background:#faf7ff;border-left:3px solid #7c3aed;border-radius:3px;margin-bottom:10px;">
        <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f7aea;">Name</div>
        <div style="font-size:15px;font-weight:600;color:#111;">${name}</div>
      </td></tr>
      <tr><td style="height:8px;"></td></tr>
      <tr><td style="padding:10px 14px;background:#faf7ff;border-left:3px solid #7c3aed;border-radius:3px;">
        <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f7aea;">Email</div>
        <div style="font-size:15px;color:#111;"><a href="mailto:${email}" style="color:#7c3aed;">${email}</a></div>
      </td></tr>
      <tr><td style="height:8px;"></td></tr>
      <tr><td style="padding:10px 14px;background:#faf7ff;border-left:3px solid #c9a84c;border-radius:3px;">
        <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#b8860b;">Audit / Score</div>
        <div style="font-size:15px;color:#111;">${category} &nbsp;·&nbsp; <strong style="color:${levelColor};">${scoreBar}/100 (${level})</strong></div>
      </td></tr>
    </table>
    <table cellpadding="0" cellspacing="0" style="margin-top:24px;">
      <tr><td style="background:#7c3aed;border-radius:4px;padding:11px 22px;">
        <a href="mailto:${email}?subject=Following up on your Restaurant Excellence audit" style="font-size:12px;font-weight:600;letter-spacing:.8px;text-transform:uppercase;color:#fff;text-decoration:none;">Follow Up →</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const resendHeaders = {
    'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    'Content-Type':  'application/json',
  };

  const results = await Promise.allSettled([

    // 1. Email the Excel to the operator
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: resendHeaders,
      body: JSON.stringify({
        from:    'Restaurant Excellence <onboarding@resend.dev>',
        to:      [email],
        subject: `Your ${category} — Score: ${scoreBar}/100`,
        html:    userHtml,
        attachments: [{
          filename: fileName || 'excellence-tracker.xlsx',
          content:  fileBase64,
        }],
      }),
    }),

    // 2. Lead notification to pierce
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: resendHeaders,
      body: JSON.stringify({
        from:     'Restaurant Excellence <onboarding@resend.dev>',
        to:       ['pierce@traditioco.com'],
        reply_to: email,
        subject:  `New Audit Lead: ${name} — ${category} (${scoreBar}/100)`,
        html:     leadHtml,
      }),
    }),

    // 3. Add to newsletter audience (optional — only fires if RESEND_AUDIENCE_ID is set)
    ...(env.RESEND_AUDIENCE_ID ? [
      fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
        method: 'POST',
        headers: resendHeaders,
        body: JSON.stringify({
          email,
          first_name: name.split(' ')[0],
          last_name:  name.split(' ').slice(1).join(' ') || '',
          unsubscribed: false,
        }),
      }),
    ] : []),

  ]);

  // Check if the user email (most important) succeeded
  const userEmailResult = results[0];
  if (userEmailResult.status === 'rejected') {
    console.error('User email failed:', userEmailResult.reason);
    return json({ error: 'Failed to send email. Please try again.' }, 502);
  }
  const userEmailResp = userEmailResult.value;
  if (!userEmailResp.ok) {
    const errData = await userEmailResp.json().catch(() => ({}));
    console.error('Resend error:', JSON.stringify(errData));
    return json({ error: errData.message || 'Email send failed' }, userEmailResp.status);
  }

  return json({ success: true });
}

/* ─── CONTACT FORM → EMAIL (Resend) ─── */
async function handleContact(request, env) {
  if (!env.RESEND_API_KEY) {
    return json({ error: 'RESEND_API_KEY not configured in Worker secrets' }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { firstName, lastName, email, role, message } = body;
  if (!firstName || !email || !message) {
    return json({ error: 'First name, email, and message are required' }, 400);
  }

  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  const roleLabel = role || 'Not specified';

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'DM Sans',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e0a3c,#4c1d95);padding:36px 44px;">
            <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Restaurant<span style="color:#c9a84c;">Excellence</span></div>
            <div style="font-size:11px;font-weight:600;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-top:6px;">New Contact Form Submission</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:40px 44px;">
            <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.6;">You have a new message from the Restaurant Excellence website.</p>
            <!-- Name -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
              <tr>
                <td style="background:#f9f7ff;border-left:3px solid #7c3aed;border-radius:4px;padding:14px 18px;">
                  <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f7aea;margin-bottom:4px;">Name</div>
                  <div style="font-size:15px;font-weight:600;color:#111827;">${fullName}</div>
                </td>
              </tr>
            </table>
            <!-- Email -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
              <tr>
                <td style="background:#f9f7ff;border-left:3px solid #7c3aed;border-radius:4px;padding:14px 18px;">
                  <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f7aea;margin-bottom:4px;">Email</div>
                  <div style="font-size:15px;color:#111827;"><a href="mailto:${email}" style="color:#7c3aed;text-decoration:none;">${email}</a></div>
                </td>
              </tr>
            </table>
            <!-- Role -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
              <tr>
                <td style="background:#f9f7ff;border-left:3px solid #7c3aed;border-radius:4px;padding:14px 18px;">
                  <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#9f7aea;margin-bottom:4px;">Role</div>
                  <div style="font-size:15px;color:#111827;">${roleLabel}</div>
                </td>
              </tr>
            </table>
            <!-- Message -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
              <tr>
                <td style="background:#f9f7ff;border-left:3px solid #c9a84c;border-radius:4px;padding:14px 18px;">
                  <div style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#b8860b;margin-bottom:8px;">Message</div>
                  <div style="font-size:14px;color:#374151;line-height:1.75;white-space:pre-wrap;">${message.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
                </td>
              </tr>
            </table>
            <!-- Reply CTA -->
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td style="background:linear-gradient(135deg,#6b21a8,#7c3aed);border-radius:4px;padding:13px 28px;">
                  <a href="mailto:${email}?subject=Re: Restaurant Excellence Inquiry" style="font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#ffffff;text-decoration:none;">Reply to ${firstName} →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f3f4f6;padding:20px 44px;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:11px;color:#9ca3af;">Sent from the contact form at restaurantexcellence.com</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  let resp;
  try {
    resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Restaurant Excellence <onboarding@resend.dev>',
        to: ['pierce@traditioco.com'],
        reply_to: email,
        subject: `New Inquiry from ${fullName} — Restaurant Excellence`,
        html: htmlBody,
      }),
    });
  } catch(err) {
    console.error('Resend fetch failed:', err.message);
    return json({ error: 'Failed to send email: ' + err.message }, 502);
  }

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    console.error('Resend error:', JSON.stringify(errData));
    return json({ error: errData.message || 'Email send failed' }, resp.status);
  }

  return json({ success: true });
}

/* ─── HELPERS ─── */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
