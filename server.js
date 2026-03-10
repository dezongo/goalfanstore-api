// ============================================================
// Goal Fan Store - API Stripe + Resend (Render.com)
// Serveur backend pour les paiements et notifications email
// ============================================================

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ============ CONFIGURATION ============

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const STORE_EMAIL = process.env.STORE_EMAIL || 'goalfanstore@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'Goal Fan Store <noreply@goalfanstore.com>';

if (!STRIPE_SECRET_KEY) {
  console.error('ERREUR FATALE: STRIPE_SECRET_KEY non définie');
  process.exit(1);
}

const stripe = require('stripe')(STRIPE_SECRET_KEY);

// ============ MIDDLEWARE ============

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, true);
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

// ============ FONCTION EMAIL VIA RESEND API ============

async function sendEmail(to, subject, htmlContent) {
  if (!RESEND_API_KEY) {
    console.log('Email non envoye: RESEND_API_KEY non configuree');
    return { success: false, error: 'API key manquante' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [to],
        subject: subject,
        html: htmlContent
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log('Email envoye via Resend: ' + data.id);
      return { success: true, id: data.id };
    } else {
      console.log('Erreur Resend: ' + JSON.stringify(data));
      return { success: false, error: data.message || 'Erreur Resend' };
    }
  } catch (err) {
    console.log('Erreur envoi email: ' + err.message);
    return { success: false, error: err.message };
  }
}

// ============ DEVISES SUPPORTEES PAR STRIPE ============

const SUPPORTED_CURRENCIES = ['usd', 'eur', 'cad', 'gbp', 'mxn', 'brl', 'aud', 'jpy', 'chf', 'sek', 'dkk', 'nok', 'pln', 'czk'];

const EXCHANGE_RATES = {
  eur: 1, usd: 1.08, cad: 1.47, gbp: 0.86,
  mxn: 18.50, brl: 5.30, aud: 1.65, jpy: 162,
  chf: 0.95, sek: 11.20, dkk: 7.46, nok: 11.50,
  pln: 4.35, czk: 25.20
};

// ============ ROUTE : STATUS ============

app.get('/', function(req, res) {
  res.json({
    service: 'Goal Fan Store - API Paiement',
    status: 'actif',
    stripe: 'Configure',
    email: RESEND_API_KEY ? 'Actif (Resend)' : 'Non configure',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', function(req, res) {
  res.json({ status: 'ok', stripe: true, email: !!RESEND_API_KEY });
});

// ============ ROUTE : PING (pour reveiller le serveur) ============

app.get('/api/ping', function(req, res) {
  res.json({ pong: true, time: Date.now() });
});

// ============ ROUTE : CREER UN PAYMENTINTENT ============

app.post('/api/create-payment-intent', async function(req, res) {
  try {
    const { amount, currency, customer_email, customer_name, order_description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    let stripeCurrency = (currency || 'eur').toLowerCase();
    if (!SUPPORTED_CURRENCIES.includes(stripeCurrency)) {
      stripeCurrency = 'eur';
    }

    let amountInCents;
    if (stripeCurrency === 'jpy') {
      amountInCents = Math.round(amount);
    } else {
      amountInCents = Math.round(amount * 100);
    }

    if (stripeCurrency !== 'jpy' && amountInCents < 50) {
      return res.status(400).json({ error: 'Le montant minimum est de 0.50 ' + stripeCurrency.toUpperCase() });
    }

    console.log('Creation PaymentIntent: ' + amountInCents + ' ' + stripeCurrency + ' pour ' + (customer_email || 'N/A'));

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: stripeCurrency,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never'
      },
      description: order_description || 'Commande Goal Fan Store',
      receipt_email: customer_email || undefined,
      metadata: {
        customer_name: customer_name || '',
        customer_email: customer_email || '',
        store: 'Goal Fan Store'
      }
    });

    console.log('PaymentIntent cree: ' + paymentIntent.id);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });

  } catch (error) {
    console.error('Erreur creation PaymentIntent:', error.message);

    let userMessage = 'Erreur lors de la creation du paiement.';
    if (error.type === 'StripeCardError') {
      userMessage = error.message;
    } else if (error.type === 'StripeInvalidRequestError') {
      userMessage = 'Parametres de paiement invalides.';
    }

    res.status(400).json({ error: userMessage });
  }
});

// ============ ROUTE : NOTIFICATION DE COMMANDE PAR EMAIL ============

app.post('/api/notify-order', async function(req, res) {
  var order = req.body;
  console.log('Notification commande recue:', JSON.stringify(order).substring(0, 500));

  // ---- PARSER L ADRESSE DE LIVRAISON ----
  // Le frontend envoie shippingAddress comme un OBJET {line1, line2, city, zip, country}
  // Mais on gere aussi le cas ou c est une string (ancien format)
  var addressLine1 = '';
  var addressLine2 = '';
  var addressCity = '';
  var addressZip = '';
  var addressCountry = '';

  if (order.shippingAddress && typeof order.shippingAddress === 'object') {
    // Nouveau format : objet
    addressLine1 = order.shippingAddress.line1 || '';
    addressLine2 = order.shippingAddress.line2 || '';
    addressCity = order.shippingAddress.city || '';
    addressZip = order.shippingAddress.zip || '';
    addressCountry = order.shippingAddress.country || '';
  } else {
    // Ancien format : champs separes ou string
    addressLine1 = order.shippingAddress || '';
    addressLine2 = order.shippingApartment || '';
    addressCity = order.shippingCity || '';
    addressZip = order.shippingZip || '';
    addressCountry = order.shippingCountry || '';
  }

  var fullAddress = addressLine1 +
    (addressLine2 ? ', ' + addressLine2 : '') +
    '<br>' + addressZip + ' ' + addressCity +
    '<br><strong>' + addressCountry + '</strong>';

  // ---- CONSTRUIRE LA LISTE DES ARTICLES ----
  var itemsHtml = (order.items || []).map(function(item) {
    var itemName = typeof item.name === 'object' ? item.name.fr : (item.name || '');
    var itemPrice = item.price || item.displayTotal || '';
    return '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;">' + itemName + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">' + (item.size || '-') + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">' + (item.quantity || 1) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">' + itemPrice + '</td>' +
      '</tr>';
  }).join('');

  // ---- CONSTRUIRE L EMAIL HTML ----
  var emailHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">' +
    '<div style="background:#dc2626;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">' +
    '<h1 style="margin:0;">Nouvelle Commande!</h1>' +
    '<p style="margin:5px 0 0;font-size:18px;">' + (order.orderId || 'N/A') + '</p>' +
    '</div>' +
    '<div style="padding:20px;background:#f9fafb;border:1px solid #e5e7eb;">' +

    // Section Client
    '<h2 style="color:#dc2626;margin-top:0;">Client</h2>' +
    '<table style="width:100%;">' +
    '<tr><td style="padding:4px 0;"><strong>Nom:</strong></td><td>' + (order.customerName || '') + '</td></tr>' +
    '<tr><td style="padding:4px 0;"><strong>Email:</strong></td><td>' + (order.customerEmail || '') + '</td></tr>' +
    '<tr><td style="padding:4px 0;"><strong>Telephone:</strong></td><td>' + (order.customerPhone || 'Non fourni') + '</td></tr>' +
    '</table>' +

    // Section Adresse
    '<h2 style="color:#dc2626;">Adresse de livraison</h2>' +
    '<p style="background:white;padding:12px;border-radius:8px;border:1px solid #e5e7eb;">' +
    fullAddress +
    '</p>' +

    // Section Articles
    '<h2 style="color:#dc2626;">Articles commandes</h2>' +
    '<table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;">' +
    '<thead><tr style="background:#f3f4f6;">' +
    '<th style="padding:8px;text-align:left;">Article</th>' +
    '<th style="padding:8px;text-align:center;">Taille</th>' +
    '<th style="padding:8px;text-align:center;">Qte</th>' +
    '<th style="padding:8px;text-align:right;">Prix</th>' +
    '</tr></thead>' +
    '<tbody>' + itemsHtml + '</tbody>' +
    '</table>' +

    // Section Total
    '<div style="margin-top:15px;padding:15px;background:#dc2626;color:white;border-radius:8px;text-align:center;">' +
    '<h2 style="margin:0;">Total: ' + (order.total || '') + '</h2>' +
    '<p style="margin:5px 0 0;">Paiement: ' + (order.paymentMethod || '') + '</p>' +
    (order.paypalOrderId ? '<p style="margin:5px 0 0;font-size:12px;">PayPal ID: ' + order.paypalOrderId + '</p>' : '') +
    (order.paymentIntentId ? '<p style="margin:5px 0 0;font-size:12px;">Stripe ID: ' + order.paymentIntentId + '</p>' : '') +
    '</div>' +

    '</div>' +
    '<div style="padding:15px;text-align:center;color:#6b7280;font-size:12px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">' +
    'Goal Fan Store - ' + new Date().toLocaleString('fr-FR', { timeZone: 'America/Toronto' }) +
    '</div>' +
    '</div>';

  var subject = 'Nouvelle commande ' + (order.orderId || '') + ' - ' + (order.customerName || '') + ' (' + (order.total || '') + ')';

  // Envoyer l email via Resend
  console.log('Envoi email a ' + STORE_EMAIL + '...');
  var result = await sendEmail(STORE_EMAIL, subject, emailHtml);
  console.log('Resultat envoi:', JSON.stringify(result));

  res.json({
    success: true,
    emailSent: result.success,
    emailId: result.id || null,
    message: result.success ? 'Commande enregistree et email envoye' : 'Commande enregistree, email non envoye: ' + (result.error || '')
  });
});

// ============ ROUTE : NOTIFICATION VIA BEACON (POST texte) ============
// Fallback pour navigator.sendBeacon qui envoie du text/plain

app.post('/api/notify-order-beacon', async function(req, res) {
  try {
    // sendBeacon envoie le body en text/plain, il faut le parser
    var order;
    if (typeof req.body === 'string') {
      order = JSON.parse(req.body);
    } else {
      order = req.body;
    }

    console.log('[BEACON] Notification commande recue:', (order.orderId || 'N/A'));

    // Parser l adresse
    var addressLine1 = '';
    var addressLine2 = '';
    var addressCity = '';
    var addressZip = '';
    var addressCountry = '';

    if (order.shippingAddress && typeof order.shippingAddress === 'object') {
      addressLine1 = order.shippingAddress.line1 || '';
      addressLine2 = order.shippingAddress.line2 || '';
      addressCity = order.shippingAddress.city || '';
      addressZip = order.shippingAddress.zip || '';
      addressCountry = order.shippingAddress.country || '';
    } else {
      addressLine1 = order.shippingAddress || '';
      addressLine2 = order.shippingApartment || '';
      addressCity = order.shippingCity || '';
      addressZip = order.shippingZip || '';
      addressCountry = order.shippingCountry || '';
    }

    var fullAddress = addressLine1 +
      (addressLine2 ? ', ' + addressLine2 : '') +
      '<br>' + addressZip + ' ' + addressCity +
      '<br><strong>' + addressCountry + '</strong>';

    var itemsHtml = (order.items || []).map(function(item) {
      var itemName = typeof item.name === 'object' ? item.name.fr : (item.name || '');
      var itemPrice = item.price || item.displayTotal || '';
      return '<tr>' +
        '<td style="padding:8px;border-bottom:1px solid #eee;">' + itemName + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">' + (item.size || '-') + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">' + (item.quantity || 1) + '</td>' +
        '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">' + itemPrice + '</td>' +
        '</tr>';
    }).join('');

    var emailHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">' +
      '<div style="background:#dc2626;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">' +
      '<h1 style="margin:0;">[BEACON] Nouvelle Commande!</h1>' +
      '<p style="margin:5px 0 0;font-size:18px;">' + (order.orderId || 'N/A') + '</p>' +
      '</div>' +
      '<div style="padding:20px;background:#f9fafb;border:1px solid #e5e7eb;">' +
      '<h2 style="color:#dc2626;margin-top:0;">Client</h2>' +
      '<table style="width:100%;">' +
      '<tr><td><strong>Nom:</strong></td><td>' + (order.customerName || '') + '</td></tr>' +
      '<tr><td><strong>Email:</strong></td><td>' + (order.customerEmail || '') + '</td></tr>' +
      '<tr><td><strong>Telephone:</strong></td><td>' + (order.customerPhone || 'Non fourni') + '</td></tr>' +
      '</table>' +
      '<h2 style="color:#dc2626;">Adresse de livraison</h2>' +
      '<p style="background:white;padding:12px;border-radius:8px;border:1px solid #e5e7eb;">' + fullAddress + '</p>' +
      '<h2 style="color:#dc2626;">Articles commandes</h2>' +
      '<table style="width:100%;border-collapse:collapse;background:white;">' +
      '<thead><tr style="background:#f3f4f6;">' +
      '<th style="padding:8px;text-align:left;">Article</th>' +
      '<th style="padding:8px;text-align:center;">Taille</th>' +
      '<th style="padding:8px;text-align:center;">Qte</th>' +
      '<th style="padding:8px;text-align:right;">Prix</th>' +
      '</tr></thead>' +
      '<tbody>' + itemsHtml + '</tbody></table>' +
      '<div style="margin-top:15px;padding:15px;background:#dc2626;color:white;border-radius:8px;text-align:center;">' +
      '<h2 style="margin:0;">Total: ' + (order.total || '') + '</h2>' +
      '<p style="margin:5px 0 0;">Paiement: ' + (order.paymentMethod || '') + '</p>' +
      '</div></div></div>';

    var subject = '[BEACON] Nouvelle commande ' + (order.orderId || '') + ' - ' + (order.customerName || '');
    var result = await sendEmail(STORE_EMAIL, subject, emailHtml);
    console.log('[BEACON] Resultat:', JSON.stringify(result));
    res.json({ success: true, emailSent: result.success });

  } catch (err) {
    console.error('[BEACON] Erreur:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ DEMARRER LE SERVEUR ============

app.listen(PORT, function() {
  console.log('Goal Fan Store API demarre sur le port ' + PORT);
  console.log('Stripe: Configure');
  console.log('Email: ' + (RESEND_API_KEY ? 'Actif (Resend)' : 'Non configure'));
});
