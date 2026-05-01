require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();

const resend = new Resend(process.env.RESEND_API_KEY);

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

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

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

async function getBusinesses(userId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('getBusinesses error:', error.message);
    return [];
  }

  return (data || []).map(normaliseBusiness);
}

async function getMessages(businessIds = []) {
  if (!businessIds.length) return [];

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .in('business_id', businessIds)
    .order('created_at', { ascending: false })
    .limit(25);

  if (error) {
    console.error('getMessages error:', error.message);
    return [];
  }

  return data || [];
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
  if (!req.session.userId) {
  return res.redirect('/login-page');
}

  const businesses = await getBusinesses(req.session.userId);
  const businessIds = businesses.map(b => b.id);
  const messages = await getMessages(businessIds);
  
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

  const conversations = {};

messages.forEach((msg) => {
  const key = msg.customer_number + '_' + msg.business_id;

  if (!conversations[key]) {
    conversations[key] = {
      ...msg,
      unreadCount: 0
    };
  }

  // keep latest message
  if (new Date(msg.created_at) > new Date(conversations[key].created_at)) {
    conversations[key] = {
      ...msg,
      unreadCount: conversations[key].unreadCount
    };
  }

  if (msg.direction === 'inbound' && msg.read === false) {
    conversations[key].unreadCount++;
  }
});

const messageCards = Object.values(conversations)
  .map((message) => {
    const business = businesses.find(
      (b) => String(b.id) === String(message.business_id)
    );

    return `
      <div class="business-card" onclick="openConversation('${message.customer_number}', '${message.business_id}')">
        <div class="card-header">
          <div>
            <h3>${message.customer_number}</h3>
            <span class="badge">
  ${business ? business.name : ''}
  ${message.unreadCount > 0 ? ` • ${message.unreadCount} new` : ''}
</span>
          </div>
        </div>

        <div class="message-section">
          <div class="label">Last message</div>
          <div class="message">${message.message_body}</div>
        </div>

        <div class="value">${new Date(message.created_at).toLocaleString()}</div>
      </div>

      <div style="margin-top:10px;">
  <button onclick="openConversation('${message.customer_number}', '${message.business_id}')">
    Open Conversation
  </button>
</div>
    `;
  })
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

        .topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 40px;
  margin-bottom: 30px;
}

.logo {
  width: 220px;
}

.tagline {
  margin-top: 8px;
  color: #666;
  font-size: 15px;
}

.top-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.secondary-btn {
  text-decoration: none;
  padding: 10px 16px;
  border-radius: 10px;
  background: white;
  border: 1px solid #ddd;
  color: #333;
  font-weight: 600;
}

.logout-btn {
  border: none;
  padding: 10px 16px;
  border-radius: 10px;
  background: #ffe5e5;
  color: #c62828;
  font-weight: 600;
  cursor: pointer;
}

.stats-row {
  display: flex;
  gap: 20px;
  padding: 0 40px;
  margin-bottom: 30px;
}

.stat-card {
  flex: 1;
  background: white;
  padding: 25px;
  border-radius: 16px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.06);
}

.stat-card h3 {
  font-size: 32px;
  margin: 0;
}

.stat-card p {
  margin-top: 8px;
  color: #666;
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
        <div class="topbar">
  <div>
    <img src="/logo.png" class="logo">
    <p class="tagline">Auto-reply to missed calls instantly</p>
  </div>

  <div class="top-actions">
    <a href="/reset-password" class="secondary-btn">Reset Password</a>
    <button onclick="logout()" class="logout-btn">Logout</button>
  </div>
</div>

<div class="stats-row">
  <div class="stat-card">
    <h3>12</h3>
    <p>Missed Calls</p>
  </div>

  <div class="stat-card">
    <h3>10</h3>
    <p>Replies Sent</p>
  </div>

  <div class="stat-card">
    <h3>1</h3>
    <p>Businesses</p>
  </div>
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

      <div class="card">
  <h2>Inbox</h2>
  <p class="subtext">Latest customer replies</p>
  ${
    messageCards ||
    `<div class="empty">
      No messages yet<br>
      <span>Customer replies will appear here</span>
    </div>`
  }
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

function openConversation(customerNumber, businessId) {
  window.location.href =
    '/conversation?customer=' +
    encodeURIComponent(customerNumber) +
    '&business=' +
    encodeURIComponent(businessId);
}

function logout() {
  window.location.href = '/logout';
}

async function sendReply(messageId, customerNumber, twilioNumber, businessId) {
  const replyText = document.getElementById('reply-' + messageId).value.trim();

  if (!replyText) {
    alert('Type a reply first');
    return;
  }

  const res = await fetch('/send-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerNumber, twilioNumber, replyText, businessId })
  });

  const text = await res.text();
  alert(text);

  if (res.ok) {
    location.reload();
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

app.get('/login-page', (req, res) => {
  res.send(`
    <h2>Login</h2>
    <input id="email" placeholder="Email" autocapitalize="none"><br><br>
    <input id="password" type="password" placeholder="Password"><br><br>
    <button type="button" onclick="login()">Login</button>

    <br><br>
<a href="/forgot-password">Forgot password?</a>

    <script>
      async function login() {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        const res = await fetch('/login', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ email, password })
        });

        if (res.ok) {
          location.href = '/';
        } else {
          alert(await res.text());
        }
      }
    </script>
  `);
});

app.get('/signup-page', (req, res) => {
  res.send(`
    <h2>Signup</h2>
    <input id="email" placeholder="Email" autocapitalize="none"><br><br>
    <input id="password" type="password" placeholder="Password"><br><br>
    <<button type="button" onclick="signup()">Signup</button>

    <script>
      async function signup() {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;

        const res = await fetch('/signup', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ email, password })
        });

        const text = await res.text();
        alert(text);

        if (res.ok) {
          location.href = '/login-page';
        }
      }
    </script>
  `);
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login-page');
  });
});

app.get('/forgot-password', (req, res) => {
  res.send(`
    <h2>Forgot Password</h2>

    <input id="email" placeholder="Your email"><br><br>

    <button onclick="sendReset()">Send Reset Link</button>

    <script>
      async function sendReset() {
        const email = document.getElementById('email').value;

        const res = await fetch('/forgot-password', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ email })
        });

        alert(await res.text());
      }
    </script>
  `);
});

app.get('/reset-password/:token', async (req, res) => {
  const token = req.params.token;

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('reset_token', token)
    .single();

  if (!user) {
    return res.send('Invalid reset link');
  }

  res.send(`
    <h2>Choose New Password</h2>

    <input id="password" type="password" placeholder="New password"><br><br>

    <button onclick="resetPassword()">Update Password</button>

    <script>
      async function resetPassword() {
        const password = document.getElementById('password').value;

        const res = await fetch('/reset-password/${token}', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ password })
        });

        alert(await res.text());

        if (res.ok) {
          location.href = '/login-page';
        }
      }
    </script>
  `);
});

app.get('/reset-password', async (req, res) => {
  const token = req.query.token;

  if (!token) {
    return res.send('Invalid reset link.');
  }

  const { data, error } = await supabase
    .from('password_resets')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (error || !data) {
    return res.send('Invalid or expired reset link.');
  }

  if (new Date(data.expires_at) < new Date()) {
    return res.send('Reset link expired.');
  }

  res.send(`
    <h2>Set New Password</h2>

    <input id="password" type="password" placeholder="New password"><br><br>

    <button type="button" onclick="resetPassword()">
      Update Password
    </button>

    <script>
      async function resetPassword() {
        const password = document.getElementById('password').value;

        const res = await fetch('/reset-password', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            token: '${token}',
            password
          })
        });

        const text = await res.text();

        alert(text);

        if (res.ok) {
          window.location.href = '/login-page';
        }
      }
    </script>
  `);
});

app.post('/add-business', async (req, res) => {

  if (!req.session.userId) {
  return res.status(401).send('Please log in first.');
}

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
      owner_mobile: cleanedOwnerMobile,
      user_id: req.session.userId
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
  const from = req.body.From;
  const to = req.body.To;

  console.log('SMS from:', from);
  console.log('SMS to:', to);

  const business = await getBusinessByTwilioNumber(to);

  if (business) {
    const { error: messageError } = await supabase.from('messages').insert([
      {
        business_id: business.id,
        customer_number: from,
        twilio_number: to,
        message_body: req.body.Body,
        direction: 'inbound',
        read: false
      }
    ]);

    if (messageError) {
      console.error('Failed to save incoming message:', messageError.message);
    } else {
      console.log('Incoming message saved');
    }
  }

  if (business && business.ownerMobile) {
    await client.messages.create({
      body: `${business.name} | ${from}: ${req.body.Body}`,
      from: to,
      to: business.ownerMobile
    });

    console.log('Forwarded SMS to owner:', business.ownerMobile);
  } else {
    console.log('No owner mobile found for business:', business);
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message("Thanks, your message has been passed on. They'll get back to you shortly.");

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/send-reply', async (req, res) => {
  const { customerNumber, twilioNumber, replyText, businessId } = req.body;

  if (!customerNumber || !twilioNumber || !replyText || !businessId) {
    return res.status(400).send('Missing reply details.');
  }

  try {
    const sent = await client.messages.create({
      body: replyText,
      from: twilioNumber,
      to: customerNumber
    });

    const { error } = await supabase.from('messages').insert([
      {
        business_id: businessId,
        customer_number: customerNumber,
        twilio_number: twilioNumber,
        message_body: replyText,
        direction: 'outbound',
        read: true
      }
    ]);

    if (error) {
      console.error('Failed to save outbound reply:', error.message);
      return res.status(500).send('Reply sent, but failed to save message.');
    }

    console.log('Reply sent:', sent.sid);
    res.send('Reply sent');
  } catch (error) {
    console.error('Reply send failed:', error.message);
    res.status(500).send('Reply failed: ' + error.message);
  }
});

app.get('/conversation', async (req, res) => {
  const { customer, business } = req.query;

  if (!req.session.userId) {
  return res.redirect('/login-page');
}

const { data: ownedBusiness, error: ownedBusinessError } = await supabase
  .from('businesses')
  .select('id')
  .eq('id', business)
  .eq('user_id', req.session.userId)
  .single();

if (ownedBusinessError || !ownedBusiness) {
  return res.status(403).send('Not allowed.');
}

  if (!customer || !business) {
    return res.send('Missing conversation details.');
  }

  await supabase
  .from('messages')
  .update({ read: true })
  .eq('customer_number', customer)
  .eq('business_id', business)
  .eq('direction', 'inbound');

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('customer_number', customer)
    .eq('business_id', business)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Conversation load error:', error.message);
    return res.send('Error loading conversation.');
  }

  const messagesHtml = (data || []).map((msg) => {
  const isOutbound = msg.direction === 'outbound';

  return `
    <div style="
      display:flex;
      justify-content:${isOutbound ? 'flex-end' : 'flex-start'};
      margin-bottom:12px;
    ">
      <div style="
        max-width:70%;
        padding:12px 14px;
        border-radius:16px;
        background:${isOutbound ? '#dcfce7' : '#e0f2fe'};
        border-bottom-${isOutbound ? 'right' : 'left'}-radius:4px;
      ">
        <div style="font-weight:700; margin-bottom:4px;">
          ${isOutbound ? 'You' : 'Customer'}
        </div>
        <div>${msg.message_body || ''}</div>
        <small style="display:block; margin-top:6px; color:#64748b;">
          ${new Date(msg.created_at).toLocaleString()}
        </small>
      </div>
    </div>
  `;
}).join('');

  const twilioNumber = data && data[0] ? data[0].twilio_number : '';

  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 20px; background:#f8fafc;">
        <a href="/">← Back to inbox</a>
        <h2>Conversation with ${customer}</h2>

        <div id="chat" style="max-width:700px; max-height:70vh; overflow-y:auto;">
          ${messagesHtml || '<p>No messages yet.</p>'}
          </div>

          <div style="margin-top:20px; display:flex; gap:10px;">
  <textarea id="reply" placeholder="Type reply..." style="flex:1; min-height:60px;"></textarea>
  <button onclick="sendReply()" style="padding:12px 20px;">Send</button>
        </div>

        <script>

        const chat = document.getElementById('chat');
if (chat) {
  chat.scrollTop = chat.scrollHeight;
}

  setTimeout(() => {
  const active = document.activeElement;

  if (!active || active.id !== 'reply') {
    window.location.reload(); // current
    // later we can replace this with AJAX live updates
  }
}, 30000);

          async function sendReply() {
            const replyText = document.getElementById('reply').value.trim();

            if (!replyText) {
              alert('Type a reply first');
              return;
            }

            const res = await fetch('/send-reply', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                customerNumber: '${customer}',
                twilioNumber: '${twilioNumber}',
                replyText,
                businessId: '${business}'
              })
            });

            const text = await res.text();
            alert(text);

            if (res.ok) {
              location.reload();
            }
          }
        </script>
      </body>
    </html>
  `);
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

app.post('/signup', async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
const password = req.body.password;


  if (!email || !password) {
    return res.status(400).send('Missing email or password');
  }

  const hashed = await bcrypt.hash(password, 10);

  const { error } = await supabase.from('users').insert([
    {
      email,
      password: hashed
    }
  ]);

  if (error) {
    console.error('Signup error:', error.message);
    return res.status(500).send('Signup failed');
  }

  res.send('User created');
});

app.post('/login', async (req, res) => {
  const email = req.body.email.trim().toLowerCase();
const password = req.body.password;


  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !data) {
    return res.status(400).send('Invalid login');
  }

  const valid = await bcrypt.compare(password, data.password);

  if (!valid) {
    return res.status(400).send('Invalid login');
  }

  req.session.userId = data.id;

  res.send('Logged in');
});

app.post('/forgot-password', async (req, res) => {
  const email = req.body.email.trim().toLowerCase();

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (!user) {
    return res.send('If that email exists, a reset link has been sent.');
  }

  const token = crypto.randomBytes(32).toString('hex');

  const expires = new Date(Date.now() + 1000 * 60 * 60);

  await supabase
    .from('users')
    .update({
      reset_token: token,
      reset_token_expires: expires
    })
    .eq('id', user.id);

  const resetLink =
    process.env.PUBLIC_URL + '/reset-password/' + token;

  await resend.emails.send({
    from: 'RingReply <hello@updates.ringreply.co.uk>',
    to: email,
    subject: 'Reset your password',
    html: `
      <h2>Reset Password</h2>
      <p>Click below to reset your password:</p>
      <a href="${resetLink}">${resetLink}</a>
    `
  });

  res.send('Reset link sent');
});

app.post('/reset-password/:token', async (req, res) => {
  const token = req.params.token;

  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('reset_token', token)
    .single();

  if (!user) {
    return res.status(400).send('Invalid token');
  }

  if (new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).send('Token expired');
  }

  const hashed = await bcrypt.hash(req.body.password, 10);

  await supabase
    .from('users')
    .update({
      password: hashed,
      reset_token: null,
      reset_token_expires: null
    })
    .eq('id', user.id);

  res.send('Password updated');
});

app.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password || password.length < 6) {
    return res.status(400).send('Password must be at least 6 characters.');
  }

  const { data: reset, error } = await supabase
    .from('password_resets')
    .select('*')
    .eq('token', token)
    .eq('used', false)
    .single();

  if (error || !reset) {
    return res.status(400).send('Invalid reset link.');
  }

  if (new Date(reset.expires_at) < new Date()) {
    return res.status(400).send('Reset link expired.');
  }

  const hashed = await bcrypt.hash(password, 10);

  const { error: updateError } = await supabase
    .from('users')
    .update({ password: hashed })
    .eq('id', reset.user_id);

  if (updateError) {
    console.error('Password update error:', updateError.message);
    return res.status(500).send('Failed to update password.');
  }

  await supabase
    .from('password_resets')
    .update({ used: true })
    .eq('id', reset.id);

  res.send('Password updated. Please log in.');
});

app.get('/businesses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('businesses')
      .select('*');

    if (error) {
      console.error('getBusinesses error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error('Route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});