require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const session = require('express-session');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const Stripe = require('stripe');

const app = express();

const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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

  const { data: currentUser } = await supabase
  .from('users')
  .select('*')
  .eq('id', req.session.userId)
  .single();

  const businessIds = businesses.map(b => b.id);
  const messages = await getMessages(businessIds);

  let trialDaysRemaining = null;

if (
  currentUser &&
  currentUser.trial_ends_at &&
  !currentUser.is_admin
) {
  const now = new Date();
  const trialEnd = new Date(currentUser.trial_ends_at);

  trialDaysRemaining = Math.max(
    0,
    Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24))
  );
}

if (
  currentUser &&
  !currentUser.is_admin &&
  trialDaysRemaining !== null &&
  trialDaysRemaining <= 0
) {
  return res.send(`
    <html>
      <head>
        <title>Trial Expired</title>
      </head>
      <body style="
        font-family:sans-serif;
        background:#f8fafc;
        display:flex;
        justify-content:center;
        align-items:center;
        height:100vh;
      ">
        <div style="
          background:white;
          padding:40px;
          border-radius:16px;
          box-shadow:0 10px 30px rgba(0,0,0,0.1);
          max-width:500px;
          text-align:center;
        ">
          <h1>Your trial has ended</h1>
          <p>Please upgrade to continue using RingReply.</p>

          <button style="
            margin-top:20px;
            padding:14px 22px;
            border:none;
            border-radius:10px;
            background:#2563eb;
            color:white;
            font-weight:600;
            cursor:pointer;
          ">
            Upgrade
          </button>
        </div>
      </body>
    </html>
  `);
}
  
  const businessCards = businesses
    .map(
      (business) => {
      const unreadCount = messages.filter(
  m =>
    String(m.business_id) === String(business.id) &&
    m.direction === 'inbound' &&
    m.read === false
).length;

return `

      <div class="business-card">
        <div class="card-header">
          <div>
            <h3>${business.name}</h3>
            <span
  class="badge ${unreadCount > 0 ? 'unread' : 'active'}"
  data-business-id="${business.id}"
>
  ${unreadCount > 0 ? unreadCount + ' unread' : 'Active'}
</span>
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

        <div class="info-box">
  <div class="label">Auto Reply Message</div>
  <div class="value">${business.autoReplyMessage}</div>
</div>
      </div>
    `;
}).join('');

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
      <div class="message-card">
        <div class="message-top">
          <div>
            <h3 style="margin:0;">
  ${business ? business.name + ' • ' : ''}
  ${message.customer_number}
</h3>
            <p class="message-time">
              ${new Date(message.created_at).toLocaleString()}
            </p>
          </div>

          ${
            message.unreadCount > 0
              ? `<span class="unread-badge">${message.unreadCount} new</span>`
              : ''
          }
        </div>

        <div class="message-body">
          ${message.message_body || ''}
        </div>

        <div class="message-actions">
          <button onclick="openConversation('${message.customer_number}', '${message.business_id}')">
            Open Conversation
          </button>
        </div>
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

.container {
  max-width: 1200px;
  margin: 30px auto 60px;
  padding: 20px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
}

.logo {
  width: 220px;
}

.tagline {
  margin-top: 8px;
  color: #475569;
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
  margin-bottom: 30px;
}

.stat-card,
.card,
.business-card,
.message-card {
  background: white;
  border-radius: 18px;
  padding: 25px;
  box-shadow: 0 8px 24px rgba(15,23,42,0.08);
}

.stat-card {
  flex: 1;
}

.stat-card h3 {
  font-size: 32px;
  margin: 0;
}

.stat-card p {
  margin-top: 8px;
  color: #64748b;
}

.card {
  margin-bottom: 28px;
}

h2 {
  margin-top: 0;
  font-size: 32px;
}

.subtext {
  color: #64748b;
  margin-bottom: 28px;
  font-size: 17px;
}

label {
  display: block;
  margin-top: 16px;
  margin-bottom: 8px;
  font-weight: 700;
  color: #1e293b;
}

input,
textarea {
  width: 100%;
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid #dbe2ea;
  margin-bottom: 16px;
  box-sizing: border-box;
  font-size: 16px;
}

textarea {
  min-height: 130px;
  resize: vertical;
}

button {
  padding: 14px 20px;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  font-weight: 700;
}

.primary {
  background: linear-gradient(135deg, #4f46e5, #2563eb);
  color: white;
  box-shadow: 0 10px 24px rgba(79,70,229,0.28);
}

.secondary {
  background: transparent;
  color: #1e293b;
}

.button-row {
  display: flex;
  gap: 16px;
  align-items: center;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 14px;
}

.info-box,
.message-body {
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
  word-break: break-word;
}

.card-header,
.message-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
}

.badge {
  display: inline-block;
  margin-top: 8px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.badge.active {
  background: #dcfce7;
  color: #166534;
}

.badge.unread {
  background: #dbeafe;
  color: #1d4ed8;
}

.message-card {
  border-left: 6px solid #2563eb;
  margin-bottom: 18px;
}

.message-time {
  color: #64748b;
  font-size: 13px;
}

.message-actions {
  margin-top: 18px;
}

.business-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 20px;
  margin-top: 20px;
}

.empty {
  text-align: center;
  padding: 34px;
  color: #64748b;
}

.status-success {
  color: #166534;
  background: #dcfce7;
}

.status-error {
  color: #991b1b;
  background: #fee2e2;
}

.latest-message .message-bubble {
  animation: highlightMessage 10s ease;
}

@keyframes highlightMessage {
  0% {
    transform: scale(1);
    box-shadow: 0 0 0 rgba(37,99,235,0);
  }

  30% {
    transform: scale(1.02);
    box-shadow: 0 0 34px rgba(37,99,235,0.9);
  }

  100% {
    transform: scale(1);
    box-shadow: 0 2px 10px rgba(0,0,0,0.05);
  }
}

@media (max-width: 768px) {
  .container {
    padding: 14px;
    margin: 0;
  }

  .topbar {
    flex-direction: column;
    gap: 18px;
    text-align: center;
  }

  .top-actions {
    justify-content: center;
  }

  .stats-row {
    flex-direction: column;
  }

  .info-grid {
    grid-template-columns: 1fr;
  }

  .card,
  .business-card,
  .message-card {
    padding: 22px;
  }

  .logo {
    width: 180px;
  }

  h2 {
    font-size: 28px;
  }
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 20px;
  margin-bottom: 32px;
  flex-wrap: wrap;
}

.logo-text {
  margin: 0;
  font-size: 32px;
  font-weight: 800;
  color: #2563eb;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.user-email {
  color: #475569;
  font-size: 14px;
}

.logout-btn {
  background: #0f172a;
  color: white;
  text-decoration: none;
  padding: 12px 18px;
  border-radius: 12px;
  font-weight: 600;
}

.logout-btn:hover {
  opacity: 0.9;
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
    <a href="/logout" class="logout-btn">
      Logout
    </a>
  </div>
</div>

${
  trialDaysRemaining !== null
    ? `
      <div style="
        background:#eff6ff;
        border:1px solid #bfdbfe;
        color:#1d4ed8;
        padding:16px;
        border-radius:14px;
        margin-bottom:20px;
        font-weight:600;
      ">
        Your free trial ends in ${trialDaysRemaining} day${trialDaysRemaining === 1 ? '' : 's'}.
      </div>
    `
    : ''
}

<div class="stats-row">
  <div class="stat-card">
    <h3>${businesses.length}</h3>
    <p>Businesses</p>
  </div>

  <div class="stat-card">
    <h3>${messages.length}</h3>
    <p>Messages</p>
  </div>

  <div class="stat-card">
    <h3 id="unreadStat">${messages.filter(m => m.direction === 'inbound' && m.read === false).length}</h3>
<p>Unread</p>
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

<button
  type="button"
  onclick="window.open('/call-forwarding-help', '_blank')"
  style="
    width:100%;
    margin-top:12px;
    padding:14px;
    border:none;
    border-radius:12px;
    background:#eff6ff;
    color:#2563eb;
    font-weight:700;
    cursor:pointer;
    font-size:15px;
  "
>
  📞 How to forward missed calls
</button>

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

      <div class="card" id="inbox" style="margin-top:30px;">
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

        async function refreshDashboardStatus() {
  try {
    const res = await fetch('/dashboard-status');
    if (!res.ok) return;

    const statuses = await res.json();

    const totalUnread = statuses.reduce(
  (sum, status) => sum + status.unreadCount,
  0
);

const unreadStat = document.getElementById('unreadStat');
if (unreadStat) {
  unreadStat.innerText = totalUnread;
}

    statuses.forEach((status) => {
      const badge = document.querySelector(
        '[data-business-id="' + status.id + '"]'
      );

      if (!badge) return;

      if (status.unreadCount > 0) {
        badge.innerText = status.unreadCount + ' unread';
        badge.className = 'badge unread';
      } else {
        badge.innerText = 'Active';
        badge.className = 'badge active';
      }
    });
  } catch (err) {
    console.log('Dashboard status refresh failed', err);
  }
}

setInterval(refreshDashboardStatus, 15000);

</script>

<footer style="
  text-align:center;
  padding:30px 20px;
  color:#64748b;
  font-size:14px;
">
  Need help?
  <a
    href="mailto:hello@ringreply.co.uk"
    style="color:#2563eb; text-decoration:none;"
  >
    Contact support
  </a>
</footer>
  
    </body>
  </html>
  `);
});

app.get('/login-page', (req, res) => {
  res.send(`
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
   <style>
  body {
    margin: 0;
    font-family: 'Segoe UI', sans-serif;
    background: linear-gradient(135deg, #dbeafe, #f8fafc);
    padding: 20px;
    color: #0f172a;
  }

  .auth-card {
  width: 100%;
  max-width: 420px;
  margin: 40px auto;
  background: white;
  padding: 32px;
  border-radius: 20px;
  box-shadow: 0 8px 24px rgba(15,23,42,0.08);
  box-sizing: border-box;
}

  h2 {
    margin-top: 0;
    margin-bottom: 24px;
  }

  input {
    width: 100%;
    padding: 16px;
    border-radius: 12px;
    border: 1px solid #dbe2ea;
    font-size: 16px;
    box-sizing: border-box;
    margin-bottom: 16px;
  }

  button {
    width: 100%;
    padding: 16px;
    border: none;
    border-radius: 12px;
    background: #2563eb;
    color: white;
    font-weight: 700;
    font-size: 16px;
    cursor: pointer;
  }

  a {
    display: block;
    text-align: center;
    margin-top: 18px;
    color: #2563eb;
    font-weight: 600;
    text-decoration: none;
  }
</style>

<div class="auth-card">
  <h2>Login</h2>

  <input
  id="email"
  placeholder="Email"
  autocapitalize="none"
  autocomplete="email"
>

<input
  id="password"
  type="password"
  placeholder="Password"
  autocomplete="current-password"
>

  <button type="button" onclick="login()">
    Login
  </button>

  <a href="/forgot-password">
    Forgot password?
  </a>
</div>

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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        margin: 0;
        font-family: 'Segoe UI', sans-serif;
        background: linear-gradient(135deg, #dbeafe, #f8fafc);
        padding: 20px;
        color: #0f172a;
      }

      .auth-card {
  width: 100%;
  max-width: 420px;
  margin: 40px auto;
  background: white;
  padding: 32px;
  border-radius: 20px;
  box-shadow: 0 8px 24px rgba(15,23,42,0.08);
  box-sizing: border-box;
}

      h2 {
        margin-top: 0;
        margin-bottom: 24px;
      }

      input {
        width: 100%;
        padding: 16px;
        border-radius: 12px;
        border: 1px solid #dbe2ea;
        font-size: 16px;
        box-sizing: border-box;
        margin-bottom: 16px;
      }

      button {
        width: 100%;
        padding: 16px;
        border: none;
        border-radius: 12px;
        background: #2563eb;
        color: white;
        font-weight: 700;
        font-size: 16px;
        cursor: pointer;
      }

      a {
        display: block;
        text-align: center;
        margin-top: 18px;
        color: #2563eb;
        font-weight: 600;
        text-decoration: none;
      }
    </style>

    <div class="auth-card">
      <h2>Signup</h2>

      <input
  id="email"
  placeholder="Email"
  autocapitalize="none"
  autocomplete="email"
>

<input
  id="password"
  type="password"
  placeholder="Password"
  autocomplete="new-password"
>

      <button type="button" onclick="signup()">
        Signup
      </button>

      <a href="/login-page">
        Already have an account? Login
      </a>
    </div>

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
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body {
        margin: 0;
        font-family: 'Segoe UI', sans-serif;
        background: linear-gradient(135deg, #dbeafe, #f8fafc);
        padding: 20px;
        color: #0f172a;
      }

      .auth-card {
  width: 100%;
  max-width: 420px;
  margin: 40px auto;
  background: white;
  padding: 32px;
  border-radius: 20px;
  box-shadow: 0 8px 24px rgba(15,23,42,0.08);
  box-sizing: border-box;
}

      h2 {
        margin-top: 0;
        margin-bottom: 12px;
      }

      p {
        color: #64748b;
        margin-bottom: 24px;
      }

      input {
        width: 100%;
        padding: 16px;
        border-radius: 12px;
        border: 1px solid #dbe2ea;
        font-size: 16px;
        box-sizing: border-box;
        margin-bottom: 16px;
      }

      button {
        width: 100%;
        padding: 16px;
        border: none;
        border-radius: 12px;
        background: #2563eb;
        color: white;
        font-weight: 700;
        font-size: 16px;
        cursor: pointer;
      }

      a {
        display: block;
        text-align: center;
        margin-top: 18px;
        color: #2563eb;
        font-weight: 600;
        text-decoration: none;
      }
    </style>

    <div class="auth-card">
      <h2>Reset Password</h2>
      <p>Enter your email and we’ll send you a reset link.</p>

      <input
  id="email"
  placeholder="Email"
  autocapitalize="none"
  autocomplete="email"
>

      <button type="button" onclick="sendReset()">
        Send Reset Link
      </button>

      <a href="/login-page">Back to login</a>
    </div>

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
  <div class="message-row ${isOutbound ? 'outbound' : 'inbound'} ${msg === data[data.length - 1] ? 'latest-message' : ''}">
    <div class="message-bubble">
      <div class="message-sender">
        ${isOutbound ? 'You' : 'Customer'}
      </div>

      <div class="message-text">
        ${msg.message_body || ''}
      </div>

      <div class="message-time">
        ${new Date(msg.created_at).toLocaleString()}
      </div>
    </div>
  </div>
`;
}).join('');

  const twilioNumber = data && data[0] ? data[0].twilio_number : '';

  res.send(`
    <html>

    <head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">

<style>
  body {
    margin: 0;
    font-family: 'Segoe UI', sans-serif;
    background: #f8fafc;
    color: #0f172a;
  }

  .chat-page {
    max-width: 760px;
    margin: 0 auto;
    padding: 20px;
  }

  .back-link {
    display: inline-block;
    margin-bottom: 18px;
    color: #2563eb;
    text-decoration: none;
    font-weight: 600;
  }

  .chat-box {
    max-height: 70vh;
    overflow-y: auto;
    padding: 10px 0;
  }

  .reply-row {
    display: flex;
    gap: 10px;
    margin-top: 18px;
    position: sticky;
    bottom: 0;
    background: #f8fafc;
    padding: 12px 0;
  }

  #reply {
    flex: 1;
    min-height: 56px;
    padding: 14px;
    border-radius: 14px;
    border: 1px solid #dbe2ea;
    font-size: 16px;
    resize: vertical;
  }

  .send-btn {
    padding: 0 20px;
    border: none;
    border-radius: 14px;
    background: #2563eb;
    color: white;
    font-weight: 700;
    font-size: 16px;
  }

  .send-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

  .message-row {
  display: flex;
  margin-bottom: 14px;
}

.message-row.outbound {
  justify-content: flex-end;
}

.message-row.inbound {
  justify-content: flex-start;
}

.message-bubble {
  max-width: 78%;
  padding: 14px;
  border-radius: 18px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.05);
}

.outbound .message-bubble {
  background: #2563eb;
  color: white;
  border-bottom-right-radius: 6px;
}

.inbound .message-bubble {
  background: white;
  color: #0f172a;
  border-bottom-left-radius: 6px;
}

.message-sender {
  font-weight: 700;
  margin-bottom: 6px;
  font-size: 14px;
}

.message-text {
  line-height: 1.5;
  word-wrap: break-word;
}

.message-time {
  margin-top: 8px;
  font-size: 12px;
  opacity: 0.7;
}

  @media (max-width: 768px) {
    .chat-page {
      padding: 14px;
    }

    h2 {
      font-size: 22px;
    }

    .chat-box {
      max-height: 68vh;
    }
  }
</style>
</head>

<body>

        <div class="chat-page">
  <a class="back-link" href="/">← Back to inbox</a>
  <h2>Conversation with ${customer}</h2>

<div
  id="newMessageBanner"
  style="
    display:none;
    background:#2563eb;
    color:white;
    padding:12px 16px;
    border-radius:12px;
    margin-bottom:14px;
    font-weight:700;
    text-align:center;
  "
>
  New message received
</div>

  <div id="chat" class="chat-box">

          ${messagesHtml || '<p>No messages yet.</p>'}
          </div>

          <div class="reply-row">
  <textarea
    id="reply"
    placeholder="Type reply..."
    autocomplete="on"
  ></textarea>

  <button class="send-btn" onclick="sendReply()">
    Send
  </button>
</div>

        <script>

        const chat = document.getElementById('chat');
if (chat) {
  chat.scrollTop = chat.scrollHeight;
}

let lastMessageCount = document.querySelectorAll('.message-row').length;

async function refreshConversation() {
  try {
    const res = await fetch(
      '/conversation-messages?customer=${encodeURIComponent(customer)}&business=${encodeURIComponent(business)}'
    );

    if (!res.ok) return;

    const messages = await res.json();

    if (messages.length !== lastMessageCount) {
  const banner = document.getElementById('newMessageBanner');

  if (banner) {
    banner.style.display = 'block';
  }

  setTimeout(() => {
    location.reload();
  }, 1500);
}
  } catch (err) {
    console.log('Conversation refresh failed', err);
  }
}

setInterval(refreshConversation, 10000);

  setTimeout(() => {
  const active = document.activeElement;

  if (!active || active.id !== 'reply') {
    window.location.reload(); // current
    // later we can replace this with AJAX live updates
  }
}, 30000);

          async function sendReply() {
  const replyBox = document.getElementById('reply');
  const sendBtn = document.querySelector('.send-btn');

  const replyText = replyBox.value.trim();

  if (!replyText) {
    alert('Type a reply first');
    return;
  }

  sendBtn.innerText = 'Sending...';
  sendBtn.disabled = true;

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
    return;
  }

  sendBtn.innerText = 'Send';
  sendBtn.disabled = false;
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
  password: hashed,
  trial_started_at: new Date(),
  trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  subscription_status: 'trial'
}
  ]);

  if (error) {
    console.error('Signup error:', error.message);
    return res.status(500).send('Signup failed');
  }

  try {
  const emailResult = await resend.emails.send({
    from: 'RingReply <hello@updates.ringreply.co.uk>',
    to: email,
    subject: 'Welcome to RingReply',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;">
        <h2>Welcome to RingReply</h2>
        <p>Your 14-day free trial has started.</p>
        <p>Need help? Email hello@ringreply.co.uk anytime.</p>
        <p>— RingReply</p>
      </div>
    `
  });

  console.log('Welcome email sent:', emailResult);
} catch (err) {
  console.error('Welcome email failed:', err);
}

try {
  await resend.emails.send({
    from: 'RingReply <hello@updates.ringreply.co.uk>',
    to: 'hello@ringreply.co.uk',
    subject: 'New RingReply signup',
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;">
        <h2>New signup</h2>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Trial:</strong> 14 days started</p>
      </div>
    `
  });

  console.log('Signup alert sent');
} catch (err) {
  console.error('Signup alert failed:', err);
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

app.post('/create-checkout-session', async (req, res) => {
  try {

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',

      line_items: [
        {
          price: 'price_1TaGHkK69fYrfgldKZ70Gtmj',
          quantity: 1,
        },
      ],

      success_url: `${process.env.PUBLIC_URL}/billing-success`,
      cancel_url: `${process.env.PUBLIC_URL}/billing-cancel`,
    });

    res.json({
      url: session.url
    });

  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).send('Stripe checkout failed');
  }
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

app.get('/dashboard-status', async (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const businesses = await getBusinesses(req.session.userId);
  const businessIds = businesses.map(b => b.id);
  const messages = await getMessages(businessIds);

  const statuses = businesses.map((business) => {
    const unreadCount = messages.filter(
      m =>
        String(m.business_id) === String(business.id) &&
        m.direction === 'inbound' &&
        m.read === false
    ).length;

    return {
      id: business.id,
      unreadCount
    };
  });

  res.json(statuses);
});

app.get('/conversation-messages', async (req, res) => {
  const { customer, business } = req.query;

  if (!req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!customer || !business) {
    return res.status(400).json({ error: 'Missing details' });
  }

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('customer_number', customer)
    .eq('business_id', business)
    .order('created_at', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data || []);
});

app.get('/call-forwarding-help', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Call Forwarding Setup</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; max-width: 700px; margin: 40px auto; padding: 20px; line-height: 1.6;">
        <h1>How to forward missed calls to RingReply</h1>
        <p>RingReply works by forwarding unanswered calls to your RingReply number.</p>

        <h2>iPhone</h2>
        <ol>
          <li>Open Settings</li>
          <li>Tap Phone</li>
          <li>Tap Call Forwarding</li>
          <li>Enable Call Forwarding</li>
          <li>Enter your RingReply number (starting with +44)</li>
        </ol>

        <h2>Android</h2>
        <ol>
          <li>Open Phone app</li>
          <li>Tap Settings</li>
          <li>Tap Calling Accounts</li>
          <li>Tap Call Forwarding</li>
          <li>Forward unanswered calls to your RingReply number (starting with +44)</li>
        </ol>

        <p><strong>Important:</strong> Forward unanswered/missed calls only, not all calls.</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});