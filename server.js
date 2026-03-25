const express = require('express');
const app = express();
const twilio = require('twilio');
const fs = require('fs-extra');
const path = require('path');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const client = twilio(accountSid, authToken);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static('public'));

const DATA_FILE = path.join(__dirname, 'businesses.json');

function loadBusinesses() {
  if (fs.existsSync(DATA_FILE)) {
    return fs.readJsonSync(DATA_FILE);
  }
  return [];
}

function saveBusinesses(businesses) {
  fs.writeJsonSync(DATA_FILE, businesses, { spaces: 2 });
}

let businesses = loadBusinesses();

app.get('/', (req, res) => {
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

        .primary:hover {
          box-shadow: 0 14px 28px rgba(79, 70, 229, 0.35);
        }

        .secondary {
          background: transparent;
          color: #1e293b;
        }

        #status {
          margin-top: 16px;
          color: #16a34a;
          font-weight: 700;
          background: #ecfdf5;
          padding: 10px 14px;
          border-radius: 12px;
          display: inline-block;
        }

        .business-card {
          border: 1px solid #e2e8f0;
          border-radius: 20px;
          padding: 20px;
          margin-top: 16px;
          background: white;
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.05);
          transition: all 0.2s ease;
        }

        .business-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 16px 28px rgba(15, 23, 42, 0.08);
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

        .empty span {
          font-size: 13px;
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
          <input id="businessName" placeholder="Business name">

          <label>Twilio Number</label>
          <input id="twilioNumber" placeholder="+447...">

          <label>Auto Reply Message</label>
          <textarea id="autoReplyMessage" placeholder="Your auto-reply message"></textarea>

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
          btn.innerText = 'Saving...';
          btn.disabled = true;

          const id = document.getElementById('businessId').value;
          const name = document.getElementById('businessName').value.trim();

          let twilioNumber = document.getElementById('twilioNumber').value.trim();
          if (twilioNumber.startsWith('0')) {
            twilioNumber = '+44' + twilioNumber.slice(1);
          }

          const autoReplyMessage = document.getElementById('autoReplyMessage').value.trim();

          const url = id ? '/update-business/' + id : '/add-business';

          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, twilioNumber, autoReplyMessage })
          });

          document.getElementById('status').innerText = 'Saved successfully ✅';

          btn.innerText = 'Save Business';
          btn.disabled = false;

          setTimeout(() => location.reload(), 800);
        }

        function editBusiness(id) {
          const b = businesses.find(x => String(x.id) === String(id));
          document.getElementById('businessId').value = b.id;
          document.getElementById('businessName').value = b.name;
          document.getElementById('twilioNumber').value = b.twilioNumber;
          document.getElementById('autoReplyMessage').value = b.autoReplyMessage;
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        async function deleteBusiness(id) {
          if (!confirm('Delete this business?')) return;
          await fetch('/delete-business/' + id, { method: 'POST' });
          location.reload();
        }

        function clearForm() {
          document.getElementById('businessId').value = '';
          document.getElementById('businessName').value = '';
          document.getElementById('twilioNumber').value = '';
          document.getElementById('autoReplyMessage').value = '';
          document.getElementById('status').innerText = '';
        }
      </script>
    </body>
  </html>
  `);
});


app.post('/add-business', (req, res) => {
  const { name, twilioNumber, autoReplyMessage } = req.body;

  if (!name || !twilioNumber || !autoReplyMessage) {
    return res.status(400).send('Please fill in all fields.');
  }

  const cleanedNumber = twilioNumber.replace(/\\s+/g, '');

  const existing = businesses.find(
    (b) => b.twilioNumber.replace(/\\s+/g, '') === cleanedNumber
  );

  if (existing) {
    return res.status(400).send('That Twilio number is already in use.');
  }

  const newBusiness = {
    id: Date.now(),
    name,
    twilioNumber: cleanedNumber,
    autoReplyMessage
  };

  businesses.push(newBusiness);
  saveBusinesses(businesses);

  res.send('Business added successfully');
});

app.post('/update-business/:id', (req, res) => {
  const { id } = req.params;
  const { name, twilioNumber, autoReplyMessage } = req.body;

  const cleanedNumber = twilioNumber.replace(/\\s+/g, '');

  const business = businesses.find((b) => String(b.id) === String(id));
  if (!business) {
    return res.status(404).send('Business not found.');
  }

  const conflict = businesses.find(
    (b) =>
      String(b.id) !== String(id) &&
      b.twilioNumber.replace(/\\s+/g, '') === cleanedNumber
  );

  if (conflict) {
    return res.status(400).send('That Twilio number is already in use.');
  }

  business.name = name;
  business.twilioNumber = cleanedNumber;
  business.autoReplyMessage = autoReplyMessage;

  saveBusinesses(businesses);
  res.send('Business updated successfully');
});

app.post('/delete-business/:id', (req, res) => {
  const { id } = req.params;
  businesses = businesses.filter((b) => String(b.id) !== String(id));
  saveBusinesses(businesses);
  res.send('Business deleted successfully');
});

app.post('/sms', (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message('Thanks for messaging RingReply!');

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice', async (req, res) => {
  const from = req.body.From;
  const to = req.body.To;

  console.log('Incoming call from:', from, 'to:', to);

  const business = businesses.find(
    (b) => b.twilioNumber.replace(/\\s+/g, '') === to.replace(/\\s+/g, '')
  );

  if (!business) {
    console.log('No matching business found for number:', to);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, this number is not set up.');
    twiml.hangup();

    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    await client.messages.create({
      body: business.autoReplyMessage,
      from: to,
      to: from
    });

    console.log('SMS sent to:', from, 'for business:', business.name);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('SMS send error:', error.message);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Sorry, an error occurred.');
    twiml.hangup();

    res.type('text/xml');
    res.send(twiml.toString());
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
