// ============================================================
// Goal Fan Store - API Stripe (Render.com)
// Serveur backend pour les paiements par carte bancaire
// ============================================================

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3001;

// ============ CONFIGURATION ============

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const GMAIL_USER = process.env.GMAIL_USER || 'goalfanstore@gmail.com';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

if (!STRIPE_SECRET_KEY) {
  console.error('ERREUR FATALE: STRIPE_SECRET_KEY non définie dans les variables d\'environnement');
  process.exit(1);
}

const stripe = require('stripe')(STRIPE_SECRET_KEY);

// ============ MIDDLEWARE ============

// CORS : autoriser les requêtes depuis Hostinger et localhost
app.use(cors({
  origin: function(origin, callback) {
    // Autoriser les requêtes sans origin (Postman, curl, etc.)
    if (!origin) return callback(null, true);
    // Autoriser tout domaine Hostinger, localhost, et le domaine personnalisé
    const allowed = [
      /\.hostingersite\.com$/,
      /\.hostinger\.com$/,
      /localhost/,
      /127\.0\.0\.1/,
      /goalfanstore/,
      /manus\.computer$/
    ];
    if (allowed.some(pattern => pattern.test(origin))) {
      return callback(null, true);
    }
    // En production, autoriser aussi votre domaine personnalisé
    return callback(null, true);
  },
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));

app.use(express.json());

// ============ CONFIGURATION EMAIL ============

let transporter = null;
if (GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000
  });
  transporter.verify(function(error) {
    if (error) {
      console.log('⚠️  Email: Configuration invalide -', error.message);
      // transporter reste actif malgré l'erreur verify (normal sur Render free tier)
    } else {
      console.log('✅ Email: Prêt à envoyer via', GMAIL_USER);
    }
  });
} else {
  console.log('⚠️  Email: GMAIL_APP_PASSWORD non configuré');
}

// Fonction utilitaire : envoyer un email avec timeout
function sendEmailWithTimeout(mailOptions, timeoutMs) {
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      reject(new Error('Email timeout après ' + timeoutMs + 'ms'));
    }, timeoutMs);
    transporter.sendMail(mailOptions).then(function(info) {
      clearTimeout(timer);
      resolve(info);
    }).catch(function(err) {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============ DEVISES SUPPORTÉES PAR STRIPE ============

const SUPPORTED_CURRENCIES = ['usd', 'eur', 'cad', 'gbp', 'mxn', 'brl', 'aud', 'jpy', 'chf', 'sek', 'dkk', 'nok', 'pln', 'czk'];

// Taux de change approximatifs (base EUR)
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
    stripe: '✅ Configuré',
    email: transporter ? '✅ Actif' : '⚠️ Non configuré',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/status', function(req, res) {
  res.json({ status: 'ok', stripe: true, email: !!transporter });
});

// ============ ROUTE : CRÉER UN PAYMENTINTENT ============

app.post('/api/create-payment-intent', async function(req, res) {
  try {
    const { amount, currency, customer_email, customer_name, order_description } = req.body;

    // Validation des paramètres
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Montant invalide' });
    }

    // Déterminer la devise (par défaut EUR)
    let stripeCurrency = (currency || 'eur').toLowerCase();
    if (!SUPPORTED_CURRENCIES.includes(stripeCurrency)) {
      stripeCurrency = 'eur';
    }

    // Convertir le montant en centimes (Stripe utilise les centimes)
    // Pour JPY, pas de centimes
    let amountInCents;
    if (stripeCurrency === 'jpy') {
      amountInCents = Math.round(amount);
    } else {
      amountInCents = Math.round(amount * 100);
    }

    // Montant minimum Stripe : 50 centimes (0.50 EUR/USD)
    if (stripeCurrency !== 'jpy' && amountInCents < 50) {
      return res.status(400).json({ error: 'Le montant minimum est de 0.50 ' + stripeCurrency.toUpperCase() });
    }

    console.log(`💳 Création PaymentIntent: ${amountInCents} ${stripeCurrency} pour ${customer_email}`);

    // Créer le PaymentIntent
    // Stripe vérifie automatiquement si le client a les fonds suffisants
    // lors de la confirmation du paiement
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

    console.log(`✅ PaymentIntent créé: ${paymentIntent.id} (${paymentIntent.status})`);

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });

  } catch (error) {
    console.error('❌ Erreur création PaymentIntent:', error.message);

    // Retourner un message d'erreur clair
    let userMessage = 'Erreur lors de la création du paiement.';
    if (error.type === 'StripeCardError') {
      userMessage = error.message;
    } else if (error.type === 'StripeInvalidRequestError') {
      userMessage = 'Paramètres de paiement invalides.';
    }

    res.status(400).json({ error: userMessage });
  }
});

// ============ ROUTE : NOTIFICATION DE COMMANDE PAR EMAIL ============

app.post('/api/notify-order', function(req, res) {
  var order = req.body;
    console.log('📧 Notification commande: ' + (order.orderId || 'N/A') + ' - ' + (order.customerName || '') + ' (' + (order.total || '') + ')');

  // Répondre IMMÉDIATEMENT au client - ne jamais bloquer
  res.json({ success: true, emailSent: 'pending', message: 'Commande enregistrée, email en cours d\'envoi' });

  // Envoyer l'email en arrière-plan (fire-and-forget)
  if (!transporter) {
    console.log('⚠️  Email non envoyé (transporter non configuré)');
    return;
  }

    // Construire la liste des articles en HTML
    const itemsHtml = (order.items || []).map(function(item) {
      const itemName = typeof item.name === 'object' ? item.name.fr : item.name;
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${itemName}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${item.size || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;">${item.displayTotal || ''}</td>
      </tr>`;
    }).join('');

    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:#dc2626;color:white;padding:20px;text-align:center;border-radius:8px 8px 0 0;">
          <h1 style="margin:0;">🛒 Nouvelle Commande!</h1>
          <p style="margin:5px 0 0;">${order.orderId || 'N/A'}</p>
        </div>
        
        <div style="padding:20px;background:#f9fafb;border:1px solid #e5e7eb;">
          <h2 style="color:#dc2626;margin-top:0;">👤 Client</h2>
          <table style="width:100%;">
            <tr><td><strong>Nom:</strong></td><td>${order.customerName || ''}</td></tr>
            <tr><td><strong>Email:</strong></td><td>${order.customerEmail || ''}</td></tr>
            <tr><td><strong>Téléphone:</strong></td><td>${order.customerPhone || 'Non fourni'}</td></tr>
          </table>
          
          <h2 style="color:#dc2626;">📦 Adresse de livraison</h2>
          <p style="background:white;padding:12px;border-radius:8px;border:1px solid #e5e7eb;">
            ${order.shippingAddress || ''}<br>
            ${order.shippingApartment ? 'Apt: ' + order.shippingApartment + '<br>' : ''}
            ${order.shippingCity || ''}, ${order.shippingZip || ''}<br>
            <strong>${order.shippingCountry || ''}</strong>
          </p>
          
          <h2 style="color:#dc2626;">🛍️ Articles commandés</h2>
          <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:8px;text-align:left;">Article</th>
                <th style="padding:8px;text-align:center;">Taille</th>
                <th style="padding:8px;text-align:center;">Qté</th>
                <th style="padding:8px;text-align:right;">Prix</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
          
          <div style="margin-top:15px;padding:15px;background:#dc2626;color:white;border-radius:8px;text-align:center;">
            <h2 style="margin:0;">Total: ${order.total || ''}</h2>
            <p style="margin:5px 0 0;">Paiement: ${order.paymentMethod || ''}</p>
          </div>
        </div>
        
        <div style="padding:15px;text-align:center;color:#6b7280;font-size:12px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          Goal Fan Store - ${new Date().toLocaleString('fr-FR')}
        </div>
      </div>
    `;

    var mailOptions = {
    from: '"Goal Fan Store" <' + GMAIL_USER + '>',
    to: GMAIL_USER,
    subject: '🛒 Nouvelle commande ' + (order.orderId || '') + ' - ' + (order.customerName || '') + ' (' + (order.total || '') + ')',
    html: emailHtml
  };

  // Envoyer avec timeout de 20 secondes
  sendEmailWithTimeout(mailOptions, 20000).then(function() {
    console.log('✅ Email de notification envoyé pour ' + (order.orderId || 'N/A'));
  }).catch(function(err) {
    console.log('⚠️  Email non envoyé pour ' + (order.orderId || 'N/A') + ': ' + err.message);
  });
});

// ============ DÉMARRAGE ============

app.listen(PORT, function() {
  console.log('');
  console.log('===========================================');
  console.log('  Goal Fan Store - API Paiement');
  console.log('===========================================');
  console.log('  Port     :', PORT);
  console.log('  Stripe   : ✅ Actif');
  console.log('  Email    :', transporter ? '✅ Actif (' + GMAIL_USER + ')' : '⚠️ Non configuré');
  console.log('===========================================');
  console.log('');
});
