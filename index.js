const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.raw({ type: 'application/json' }));

// Airtable configuration
const AIRTABLE_BASE_ID = 'appUNIsu8KgvOlmi0'; // Growth AI base
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_TABLE_NAME = 'Failed Payments';

// Gmail configuration
const gmail = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// Logs storage
let logs = [];
const MAX_LOGS = 100;

function addLog(level, message, data = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data
  };
  logs.unshift(logEntry);
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(0, MAX_LOGS);
  }
  console.log(`[${level}] ${message}`, data || '');
}

// Add failed payment to Airtable (will create table manually first)
async function logToAirtable(paymentData) {
  try {
    const record = {
      fields: {
        'Payment Intent ID': paymentData.id,
        'Customer Email': paymentData.customer_email,
        'Amount': paymentData.amount / 100, // Convert from cents
        'Currency': paymentData.currency.toUpperCase(),
        'Failure Code': paymentData.failure_code || 'unknown',
        'Failure Message': paymentData.failure_message || 'No message provided',
        'Failed At': new Date().toISOString(),
        'Customer ID': paymentData.customer_id,
        'Status': 'Failed'
      }
    };

    const response = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`,
      { records: [record] },
      {
        headers: {
          'Authorization': `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    addLog('info', 'Successfully logged failed payment to Airtable', paymentData.id);
    return true;
  } catch (error) {
    addLog('error', 'Error logging to Airtable', error.response?.data || error.message);
    return false;
  }
}

// Send Gmail alert
async function sendEmailAlert(paymentData) {
  try {
    const mailOptions = {
      from: process.env.GMAIL_USER,
      to: process.env.ALERT_EMAIL || process.env.GMAIL_USER,
      subject: `🚨 Payment Failed - ${paymentData.customer_email}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #e74c3c;">⚠️ Payment Failed Alert</h2>
          
          <div style="background: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h3>Payment Details:</h3>
            <ul style="list-style: none; padding: 0;">
              <li><strong>Payment Intent ID:</strong> ${paymentData.id}</li>
              <li><strong>Customer Email:</strong> ${paymentData.customer_email}</li>
              <li><strong>Amount:</strong> ${paymentData.currency.toUpperCase()} ${(paymentData.amount / 100).toFixed(2)}</li>
              <li><strong>Failure Code:</strong> ${paymentData.failure_code || 'Not provided'}</li>
              <li><strong>Failure Message:</strong> ${paymentData.failure_message || 'No message provided'}</li>
              <li><strong>Failed At:</strong> ${new Date().toLocaleString()}</li>
            </ul>
          </div>
          
          <div style="background: #e8f5e8; padding: 15px; border-radius: 8px;">
            <p><strong>Next Steps:</strong></p>
            <ul>
              <li>Check the customer's payment method</li>
              <li>Contact the customer if necessary</li>
              <li>Retry the payment if appropriate</li>
              <li>Update the status in Airtable when resolved</li>
            </ul>
          </div>
          
          <p style="color: #7f8c8d; font-size: 12px; margin-top: 30px;">
            This alert was sent by your Stripe Payment Monitor agent.
          </p>
        </div>
      `
    };

    await gmail.sendMail(mailOptions);
    addLog('info', 'Email alert sent successfully', paymentData.customer_email);
    return true;
  } catch (error) {
    addLog('error', 'Error sending email alert', error.message);
    return false;
  }
}

// Process failed payment
async function processFailedPayment(paymentIntent) {
  try {
    // Get customer details if available
    let customerEmail = 'unknown@example.com';
    let customerId = 'unknown';
    
    if (paymentIntent.customer) {
      try {
        const customer = await stripe.customers.retrieve(paymentIntent.customer);
        customerEmail = customer.email || customerEmail;
        customerId = customer.id;
      } catch (error) {
        addLog('warn', 'Could not retrieve customer details', error.message);
      }
    }

    const paymentData = {
      id: paymentIntent.id,
      customer_email: customerEmail,
      customer_id: customerId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      failure_code: paymentIntent.last_payment_error?.code,
      failure_message: paymentIntent.last_payment_error?.message
    };

    addLog('info', 'Processing failed payment', paymentIntent.id);

    // Log to Airtable
    const airtableSuccess = await logToAirtable(paymentData);
    
    // Send email alert
    const emailSuccess = await sendEmailAlert(paymentData);

    if (airtableSuccess && emailSuccess) {
      addLog('info', 'Failed payment processed successfully', paymentIntent.id);
    } else {
      addLog('warn', 'Failed payment processed with some errors', paymentIntent.id);
    }

  } catch (error) {
    addLog('error', 'Error processing failed payment', error.message);
  }
}

// Standard endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'Stripe Payment Monitor Agent',
    description: 'Monitors Stripe for failed payments and sends alerts via Gmail while logging to Airtable',
    status: 'active',
    endpoints: {
      'GET /': 'This status page',
      'GET /health': 'Health check endpoint',
      'GET /logs': 'View recent logs',
      'POST /test': 'Test the monitoring system',
      'POST /webhook/stripe': 'Stripe webhook endpoint for payment failures',
      'GET /webhook/setup': 'Get webhook setup instructions',
      'GET /airtable/setup': 'Instructions for setting up the Airtable table'
    },
    lastStarted: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      stripe: process.env.STRIPE_SECRET_KEY ? 'configured' : 'missing',
      gmail: process.env.GMAIL_USER ? 'configured' : 'missing',
      airtable: process.env.AIRTABLE_API_KEY ? 'configured' : 'missing'
    }
  });
});

app.get('/logs', (req, res) => {
  res.json({
    logs: logs.slice(0, 50), // Return last 50 logs
    total: logs.length
  });
});

app.post('/test', async (req, res) => {
  try {
    addLog('info', 'Test endpoint called');
    
    // Test with sample data
    const testPaymentData = {
      id: 'test_payment_intent_' + Date.now(),
      customer_email: 'test@example.com',
      customer_id: 'test_customer',
      amount: 2000, // $20.00
      currency: 'usd',
      failure_code: 'card_declined',
      failure_message: 'Your card was declined (test)'
    };

    // Test Airtable logging
    const airtableResult = await logToAirtable(testPaymentData);
    
    // Test email alert
    const emailResult = await sendEmailAlert(testPaymentData);

    res.json({
      success: true,
      message: 'Test completed',
      results: {
        airtable: airtableResult ? 'success' : 'failed',
        email: emailResult ? 'success' : 'failed'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    addLog('error', 'Test failed', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Airtable setup instructions
app.get('/airtable/setup', (req, res) => {
  res.json({
    message: 'Create a table named "Failed Payments" in your Growth AI Airtable base',
    baseId: AIRTABLE_BASE_ID,
    tableName: AIRTABLE_TABLE_NAME,
    requiredFields: [
      { name: 'Payment Intent ID', type: 'Single line text' },
      { name: 'Customer Email', type: 'Email' },
      { name: 'Amount', type: 'Currency' },
      { name: 'Currency', type: 'Single line text' },
      { name: 'Failure Code', type: 'Single line text' },
      { name: 'Failure Message', type: 'Long text' },
      { name: 'Failed At', type: 'Date and time' },
      { name: 'Customer ID', type: 'Single line text' },
      { name: 'Status', type: 'Single select', options: ['Failed', 'Notified', 'Resolved'] }
    ],
    instructions: [
      '1. Go to your Growth AI base in Airtable',
      '2. Create a new table called "Failed Payments"',
      '3. Add the fields listed above with the specified types',
      '4. Test the agent with POST /test endpoint'
    ]
  });
});

// Stripe webhook endpoint
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    addLog('error', 'Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  addLog('info', 'Received Stripe webhook', event.type);

  // Handle the event
  switch (event.type) {
    case 'payment_intent.payment_failed':
      await processFailedPayment(event.data.object);
      break;
    case 'invoice.payment_failed':
      // Handle invoice payment failures
      const invoice = event.data.object;
      if (invoice.payment_intent) {
        try {
          const paymentIntent = await stripe.paymentIntents.retrieve(invoice.payment_intent);
          await processFailedPayment(paymentIntent);
        } catch (error) {
          addLog('error', 'Error retrieving payment intent from failed invoice', error.message);
        }
      }
      break;
    default:
      addLog('info', 'Unhandled event type', event.type);
  }

  res.json({ received: true });
});

// Webhook setup instructions
app.get('/webhook/setup', (req, res) => {
  const baseUrl = req.get('host');
  const webhookUrl = `https://${baseUrl}/webhook/stripe`;
  
  res.json({
    instructions: 'To complete setup, register this webhook URL in your Stripe dashboard',
    webhookUrl: webhookUrl,
    events: [
      'payment_intent.payment_failed',
      'invoice.payment_failed'
    ],
    steps: [
      '1. Go to https://dashboard.stripe.com/webhooks',
      '2. Click "Add endpoint"',
      `3. Enter URL: ${webhookUrl}`,
      '4. Select events: payment_intent.payment_failed, invoice.payment_failed',
      '5. Add the webhook secret to your environment variables as STRIPE_WEBHOOK_SECRET'
    ]
  });
});

// Initialize
function initialize() {
  addLog('info', 'Stripe Payment Monitor Agent started');
  addLog('info', 'Ready to monitor failed payments');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stripe Payment Monitor Agent running on port ${PORT}`);
  initialize();
});

module.exports = app;