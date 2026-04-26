require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();

function validateTwilioRequest(req, res, next) {
  const signature = req.headers['x-twilio-signature'];

  const url = process.env.PUBLIC_URL + req.originalUrl;

  const params = req.body;

  const isValid = twilio.validateRequest(
    process.env.TWILIO_AUTH_TOKEN,
    signature,
    url,
    params
  );

  if (!isValid) {
    console.log('❌ Invalid Twilio request');
    return res.status(403).send('Forbidden');
  }

  next();
}

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('SUPABASE_SERVICE_ROLE_KEY loaded:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);

if (!accountSid || !authToken || !supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing environment variables');
}

const client = twilio(accountSid, authToken);
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

function cleanNumber(number) {
  if (!number) return '';
  return String(number).replace(/\s+/g, '');
}

function normaliseBusiness(row) {
  return {
    id: row.id,
    name: row.name,
    twilioNumber: row.twilio_number,
    autoReplyMessage: row.auto_reply_message,
    ownerMobile: row.owner_mobile,
    createdAt: row.created_at
  };
}

async function getBusinesses() {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getBusinesses error:', error.message);
    return [];
  }

  return (data || []).map(normaliseBusiness);
}

async function getBusinessByTwilioNumber(twilioNumber) {
  const cleanedNumber = cleanNumber(twilioNumber);

  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('twilio_number', cleanedNumber);

  if (error) {
    console.error('getBusinessByTwilioNumber error:', error.message);
    return null;
  }

  if (!data || data.length === 0) {
    return null;
  }

  return normaliseBusiness(data[0]);
}

async function hasDuplicateNumber(twilioNumber, excludeId = null) {
  const cleanedNumber = cleanNumber(twilioNumber);

  let query = supabase
    .from('businesses')
    .select('id')
    .eq('twilio_number', cleanedNumber);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('hasDuplicateNumber error:', error.message);
    return false;
  }

  return Array.isArray(data) && data.length > 0;
}

app.get('/', async (req, res) => {
  const businesses = await getBusinesses();

  const businessCards = businesses
    .map(
      (business) => `
      <div class="business-card">
        <div class="card-header">
          <div>
            <h3>${business.name}</h3>
            <span class="badge">Active</span>
          </div>
          <div class="actions">
            <button class="edit" onclick="editBusiness('${business.id}')">Edit</button>
            <button class="delete" onclick="deleteBusiness('${business.id}')">Delete</button>
          </div>
        </div>

        <div class="info-grid">
          <div class="info-box">
            <div class="label">Business Name</div>
            <div class="value">${business.name}</div>
          </div>

          <div class="info-box">
            <div class="label">Phone Number</div>
            <div class="value">${business.twilioNumber}</div>
          </div>
        </div>

        <div class="info-box">
  <div class="label">Owner Mobile</div>
  <div class="value">${business.ownerMobile || ''}</div>
</div>

        <div class="message-section">
          <div class="label">Auto Reply Message</div>
          <div class="message">${business.autoReplyMessage}</div>
        </div>
      </div>
    `
    )
    .join('');

  res.send(`
  <html>
    <head>
      <title>RingReply</title>
      <style>
        body {
          margin: 0;
          font-family: 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #dbeafe, #f8fafc);
          color: #0f172a;
        }

        .container {
          max-width: 1100px;
          margin: 30px auto 60px;
          padding: 20px;
        }

        .header {
          text-align: center;
          margin-bottom: 30px;
        }

        .logo {
          width: 220px;
          display: block;
          margin: 0 auto 14px;
        }

        .header p {
          color: #475569;
          margin: 0;
          font-size: 18px;
        }

        .card {
          background: rgba(255, 255, 255, 0.92);
          border-radius: 24px;
          padding: 32px;
          box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
          margin-bottom: 28px;
          border: 1px solid rgba(255,255,255,0.5);
          backdrop-filter: blur(8px);
        }

        h2 {
          margin: 0 0 10px;
          font-size: 28px;
        }

        .subtext {
          color: #64748b;
          margin-bottom: 26px;
          font-size: 16px;
        }

        label {
          display: block;
          margin-top: 16px;
          margin-bottom: 8px;
          font-weight: 700;
          font-size: 15px;
          color: #1e293b;
        }

        input, textarea {
          width: 100%;
          padding: 18px 20px;
          border-radius: 18px;
          border: 1px solid #dbe2ea;
          margin-bottom: 14px;
          box-sizing: border-box;
          font-size: 16px;
          background: rgba(255,255,255,0.9);
          color: #0f172a;
        }

        input::placeholder,
        textarea::placeholder {
          color: #94a3b8;
        }

        input:focus,
        textarea:focus {
          outline: none;
          border: 1px solid #4f46e5;
          box-shadow: 0 0 0 4px rgba(79,70,229,0.10);
        }

        textarea {
          min-height: 130px;
          resize: vertical;
        }

        .button-row {
          margin-top: 10px;
          display: flex;
          align-items: center;
          gap: 16px;
        }

        button {
          padding: 16px 26px;
          border: none;
          border-radius: 16px;
          cursor: pointer;
          font-weight: 700;
          font-size: 16px;
          transition: all 0.2s ease;
        }

        button:hover {
          transform: translateY(-1px);
          opacity: 0.96;
        }

        .primary {
          background: linear-gradient(135deg, #4f46e5, #2563eb);
          color: white;
          box-shadow: 0 10px 24px rgba(79, 70, 229, 0.28);
        }

        .secondary {
          background: transparent;
          color: #1e293b;
        }

        #status {
          margin-top: 16px;
          font-weight: 700;
          padding: 10px 14px;
          border-radius: 12px;
          display: inline-block;
          min-height: 20px;
        }

        .status-success {
          color: #166534;
          background: #dcfce7;
        }

        .status-error {
          color: #991b1b;
          background: #fee2e2;
        }

        .business-card {
          border: 1px solid #e2e8f0;
          border-radius: 20px;
          padding: 20px;
          margin-top: 16px;
          background: white;
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.05);
        }

        .card-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          margin-bottom: 16px;
        }

        .card-header h3 {
          margin: 0;
          font-size: 22px;
        }

        .badge {
          display: inline-block;
          margin-top: 8px;
          background: #dcfce7;
          padding: 5px 12px;
          border-radius: 999px;
          font-size: 12px;
          color: #166534;
          font-weight: 700;
        }

        .actions button {
          margin-left: 8px;
        }

        .edit {
          background: #0ea5e9;
          color: white;
          padding: 10px 16px;
          font-size: 14px;
          border-radius: 12px;
        }

        .delete {
          background: #dc2626;
          color: white;
          padding: 10px 16px;
          font-size: 14px;
          border-radius: 12px;
        }

        .info-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 14px;
          margin-bottom: 14px;
        }

        .info-box {
          background: #f8fafc;
          padding: 14px;
          border-radius: 14px;
          border: 1px solid #e2e8f0;
        }

        .label {
          font-size: 12px;
          color: #64748b;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          margin-bottom: 8px;
          font-weight: 700;
        }

        .value {
          font-size: 15px;
          color: #0f172a;
          word-break: break-word;
        }

        .message {
          background: #f8fafc;
          padding: 14px;
          border-radius: 14px;
          margin-top: 10px;
          border: 1px solid #e2e8f0;
          line-height: 1.5;
        }

        .empty {
          text-align: center;
          padding: 34px;
          color: #64748b;
        }

        @media (max-width: 700px) {
          .info-grid {
            grid-template-columns: 1fr;
          }

          .card-header {
            flex-direction: column;
          }

          .actions {
            width: 100%;
          }

          .actions button {
            width: 100%;
            margin: 8px 0 0 0;
          }

          .button-row {
            flex-direction: column;
            align-items: flex-start;
          }
        }
      </style>
    </head>

    <body>
      <div class="container">
        <div class="header">
          <img src="/logo.png" class="logo">
          <p>Auto-reply to missed calls instantly</p>
        </div>

        <div class="card">
          <h2>Business Setup</h2>
          <p class="subtext">Manage your businesses and auto-reply messages</p>

          <input type="hidden" id="businessId">

          <label>Business Name</label>
          <input id="businessName" placeholder="Business name" onblur="updateAutoMessage()">

          <label>Twilio Number</label>
<input id="twilioNumber" placeholder="+447...">

<label>Owner Mobile</label>
<input id="ownerMobile" placeholder="+447..." onblur="updateAutoMessage()">

<label>Auto Reply Message</label>
<textarea id="autoReplyMessage" placeholder="Hi, sorry we missed your call. This is [Business Name]. Please text us on 07XXXXXXXXX with your job details and we’ll get back to you shortly. You can also reply here if easier."></textarea>

          <div class="button-row">
            <button class="primary" onclick="saveBusiness()">Save Business</button>
            <button class="secondary" onclick="clearForm()">Clear</button>
          </div>

          <p id="status"></p>
        </div>

        <div class="card">
          <h2>Businesses</h2>
          <p class="subtext">Manage your connected numbers and messages</p>
          ${
            businessCards ||
            `<div class="empty">
              No businesses yet<br>
              <span>Add your first number to get started</span>
            </div>`
          }
        </div>
      </div>

      <script>
        const businesses = ${JSON.stringify(businesses)};

        async function saveBusiness() {
          const btn = document.querySelector('.primary');
          const status = document.getElementById('status');

          btn.innerText = 'Saving...';
          btn.disabled = true;
          status.className = '';
          status.innerText = '';

          const id = document.getElementById('businessId').value;
          const name = document.getElementById('businessName').value.trim();

          let twilioNumber = document.getElementById('twilioNumber').value.trim();
          if (twilioNumber.startsWith('0')) {
            twilioNumber = '+44' + twilioNumber.slice(1);
          }

          let ownerMobile = document.getElementById('ownerMobile').value.trim();
if (ownerMobile.startsWith('0')) {
  ownerMobile = '+44' + ownerMobile.slice(1);
}

const autoReplyMessage = document.getElementById('autoReplyMessage').value.trim();
const url = id ? '/update-business/' + id : '/add-business';


          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, twilioNumber, autoReplyMessage, ownerMobile })
            });

            const text = await res.text();
            status.innerText = text;
            status.className = res.ok ? 'status-success' : 'status-error';

            if (res.ok) {
              setTimeout(() => location.reload(), 800);
            }
          } catch (error) {
            status.innerText = 'Something went wrong.';
            status.className = 'status-error';
          }

          btn.innerText = 'Save Business';
          btn.disabled = false;
        }

        function editBusiness(id) {
          const b = businesses.find(x => String(x.id) === String(id));
          if (!b) return;

          document.getElementById('businessId').value = b.id;
          document.getElementById('businessName').value = b.name;
          document.getElementById('twilioNumber').value = b.twilioNumber;
          document.getElementById('ownerMobile').value = b.ownerMobile || '';
          document.getElementById('autoReplyMessage').value = b.autoReplyMessage;
          document.getElementById('status').innerText = '';
          document.getElementById('status').className = '';
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        async function deleteBusiness(id) {
          if (!confirm('Delete this business?')) return;

          const res = await fetch('/delete-business/' + id, { method: 'POST' });
          if (res.ok) {
            location.reload();
          } else {
            const text = await res.text();
            alert(text);
          }
        }

      function updateAutoMessage() {
  let ownerMobile = document.getElementById('ownerMobile').value.trim();
  let businessName = document.getElementById('businessName').value.trim();

  if (ownerMobile.startsWith('0')) {
    ownerMobile = '+44' + ownerMobile.slice(1);
  }

  const textarea = document.getElementById('autoReplyMessage');

  const isDefault =
    !textarea.value ||
    textarea.value.includes('07XXXXXXXXX') ||
    textarea.value.includes('[Business Name]');

  if (isDefault) {
  textarea.value =
  'Hi, sorry we missed your call. This is ' +
  (businessName || '[Business Name]') +
  '. Please text us on ' +
  (ownerMobile || '07XXXXXXXXXX') +
  ' with your job details and we will get back to you shortly. You can also reply here if easier.';
  }
}

        function clearForm() {
          document.getElementById('businessId').value = '';
          document.getElementById('businessName').value = '';
          document.getElementById('twilioNumber').value = '';
          document.getElementById('ownerMobile').value = '';
          document.getElementById('autoReplyMessage').value = '';
          document.getElementById('status').innerText = '';
          document.getElementById('status').className = '';
        }
      </script>
    </body>
  </html>
  `);
});

app.post('/add-business', async (req, res) => {
  const { name, twilioNumber, autoReplyMessage, ownerMobile } = req.body;

  if (!name || !twilioNumber || !autoReplyMessage || !ownerMobile) {
    return res.status(400).send('Please fill in all fields.');
  }

  const cleanedNumber = cleanNumber(twilioNumber);
  const cleanedOwnerMobile = cleanNumber(ownerMobile);

  const duplicate = await hasDuplicateNumber(cleanedNumber);
  if (duplicate) {
    return res.status(400).send('That Twilio number is already in use.');
  }

  const { error } = await supabase.from('businesses').insert([
    {
      name,
      twilio_number: cleanedNumber,
      auto_reply_message: autoReplyMessage,
      owner_mobile: cleanedOwnerMobile
    }
  ]);

  if (error) {
    console.error('add-business error FULL:', error);
    return res.status(500).send('Failed to add business: ' + error.message);
  }

  res.send('Business added successfully');
});

app.post('/update-business/:id', async (req, res) => {
  const { id } = req.params;
  const { name, twilioNumber, autoReplyMessage, ownerMobile } = req.body;

  if (!name || !twilioNumber || !autoReplyMessage || !ownerMobile) {
    return res.status(400).send('Please fill in all fields.');
  }

  const cleanedNumber = cleanNumber(twilioNumber);
  const cleanedOwnerMobile = cleanNumber(ownerMobile);

  const duplicate = await hasDuplicateNumber(cleanedNumber, id);
  if (duplicate) {
    return res.status(400).send('That Twilio number is already in use.');
  }

  const { error } = await supabase
    .from('businesses')
    .update({
      name,
      twilio_number: cleanedNumber,
      auto_reply_message: autoReplyMessage,
      owner_mobile: cleanedOwnerMobile
    })
    .eq('id', id);

  if (error) {
    console.error('update-business error:', error.message);
    return res.status(500).send('Failed to update business.');
  }

  res.send('Business updated successfully');
});

app.post('/delete-business/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('businesses')
    .delete()
    .eq('id', id);

  if (error) {
    console.error('delete-business error:', error.message);
    return res.status(500).send('Failed to delete business.');
  }

  res.send('Business deleted successfully');
});

app.post('/sms', validateTwilioRequest, async (req, res) => {
  const from = req.body.From; // customer number
  const to = req.body.To; // your Twilio number

  console.log('SMS from:', from);
  console.log('SMS to:', to);

  const business = await getBusinessByTwilioNumber(to);

  if (business && business.ownerMobile) {
  await client.messages.create({
    body: `${from}: ${req.body.Body}`,
    from: to,
    to: business.ownerMobile
  });

  console.log('Forwarded SMS to owner:', business.ownerMobile);
} else {
  console.log('No owner mobile found for business:', business);
}

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message('Thanks for messaging RingReply!');

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice', validateTwilioRequest, (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());

  const from = req.body.From;
  const to = req.body.To;
  console.log('VOICE from:', from);
  console.log('VOICE to:', to);

  setImmediate(async () => {
    try {
      const business = await getBusinessByTwilioNumber(to);

      if (business) {
        await client.messages.create({
          body: business.autoReplyMessage,
          from: to,
          to: from
        });

        console.log('SMS sent to:', from);
      } else {
        console.log('No business found for number:', to);
      }
    } catch (error) {
      console.error('VOICE BACKGROUND ERROR:', error);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
