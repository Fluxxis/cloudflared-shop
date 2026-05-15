const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const PORT = config.site.port || 3000;

// Ensure directories
['data', 'public/uploads'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Data files
const USERS_FILE = path.join(__dirname, 'data/users.json');
const PRODUCTS_FILE = path.join(__dirname, 'data/products.json');
const ORDERS_FILE = path.join(__dirname, 'data/orders.json');

function readJSON(file) {
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ============ SESSIONS ============
const sessions = new Map();
function getSession(req) {
  const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const sid = cookies['sid'];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  return null;
}
function createSession(res) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, {});
  res.setHeader('Set-Cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return sessions.get(sid);
}
function ensureSession(req, res) {
  let s = getSession(req);
  if (!s) s = createSession(res);
  return s;
}

// ============ CAPTCHA ============
const captchaStore = new Map();

function generateCaptcha() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let text = '';
  for (let i = 0; i < 5; i++) text += chars[Math.floor(Math.random() * chars.length)];

  const width = 280, height = 90;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  svg += `<rect width="${width}" height="${height}" fill="#fff"/>`;

  for (let i = 0; i < width; i += 4) {
    svg += `<line x1="${i}" y1="0" x2="${i}" y2="${height}" stroke="rgba(0,0,0,${(Math.random()*0.15).toFixed(3)})" stroke-width="1"/>`;
  }
  for (let i = 0; i < 3; i++) {
    svg += `<path d="M0,${(Math.random()*height).toFixed(0)} C${(width*0.3).toFixed(0)},${(Math.random()*height).toFixed(0)} ${(width*0.7).toFixed(0)},${(Math.random()*height).toFixed(0)} ${width},${(Math.random()*height).toFixed(0)}" fill="none" stroke="rgba(150,150,150,0.3)" stroke-width="1"/>`;
  }
  for (let i = 0; i < text.length; i++) {
    const x = 25 + i * 50, y = 55 + (Math.random()-0.5)*20;
    const rot = ((Math.random()-0.5)*25).toFixed(1);
    svg += `<text x="${x}" y="${y}" font-size="42" font-weight="bold" font-family="sans-serif" fill="rgba(80,80,80,${(0.5+Math.random()*0.4).toFixed(2)})" transform="rotate(${rot},${x},${y})">${text[i]}</text>`;
  }
  svg += '</svg>';

  const id = crypto.randomBytes(8).toString('hex');
  captchaStore.set(id, { text, created: Date.now() });
  for (const [key, val] of captchaStore) {
    if (Date.now() - val.created > 300000) captchaStore.delete(key);
  }
  return { id, image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') };
}

// ============ TELEGRAM ============
async function notifyAdmin(message) {
  if (!config.telegram.botToken || config.telegram.botToken === 'YOUR_BOT_TOKEN_HERE') return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.adminChatId, text: message, parse_mode: 'HTML' })
    });
  } catch (e) { console.error('TG error:', e.message); }
}

// ============ TON RATE ============
let tonRate = 0, tonRateUpdated = 0;
async function getTonRate() {
  if (Date.now() - tonRateUpdated < 60000 && tonRate > 0) return tonRate;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const data = await res.json();
    tonRate = data['the-open-network'].usd;
    tonRateUpdated = Date.now();
  } catch (e) { if (tonRate === 0) tonRate = 2.5; }
  return tonRate;
}

// ============ MULTIPART PARSER ============
function parseMultipart(req, boundary) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      const parts = [];
      const boundaryBuf = Buffer.from('--' + boundary);
      let start = 0;
      while (true) {
        const idx = buf.indexOf(boundaryBuf, start);
        if (idx === -1) break;
        if (start > 0) {
          const partBuf = buf.slice(start, idx - 2);
          const headerEnd = partBuf.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            const headers = partBuf.slice(0, headerEnd).toString();
            const body = partBuf.slice(headerEnd + 4);
            const nameMatch = headers.match(/name="([^"]+)"/);
            const filenameMatch = headers.match(/filename="([^"]+)"/);
            if (nameMatch) {
              parts.push({ name: nameMatch[1], filename: filenameMatch ? filenameMatch[1] : null, data: body, headers });
            }
          }
        }
        start = idx + boundaryBuf.length + 2;
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

// ============ HELPERS ============
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJSON(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function getIP(req) {
  return req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '';
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp'
};

// ============ SERVER ============
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  try {
    // === API ROUTES ===
    if (pathname === '/api/captcha' && method === 'GET') {
      return sendJSON(res, generateCaptcha());
    }

    if (pathname === '/api/config' && method === 'GET') {
      return sendJSON(res, { adminTelegram: config.admin.telegramUsername || '@admin', minFiatTopupUSD: config.rates.minFiatTopupUSD || 10 });
    }

    if (pathname === '/api/register' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      const { username, displayName, password, captchaId, captchaText } = body;
      const cap = captchaStore.get(captchaId);
      if (!cap || cap.text.toLowerCase() !== (captchaText||'').toLowerCase()) return sendJSON(res, { success: false, error: 'Неверная капча' });
      captchaStore.delete(captchaId);
      const users = readJSON(USERS_FILE);
      if (users.find(u => u.username === username)) return sendJSON(res, { success: false, error: 'Пользователь уже существует' });
      const ip = getIP(req);
      const user = { id: crypto.randomBytes(8).toString('hex'), username, displayName: displayName || username, password: crypto.createHash('sha256').update(password).digest('hex'), balance: 0, createdAt: new Date().toISOString(), wallet: null, ip, blocked: false };
      users.push(user);
      writeJSON(USERS_FILE, users);
      const sess = ensureSession(req, res);
      sess.userId = user.id;
      notifyAdmin(`🆕 <b>Новая регистрация</b>\n👤 Логин: ${username}\n📛 Имя: ${displayName||username}\n🕐 ${new Date().toLocaleString()}\n🌐 IP: ${ip}\n📱 UA: ${req.headers['user-agent']}`);
      return sendJSON(res, { success: true, user: { id: user.id, username: user.username, displayName: user.displayName, balance: user.balance } });
    }

    if (pathname === '/api/login' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      const { username, password, captchaId, captchaText } = body;
      const cap = captchaStore.get(captchaId);
      if (!cap || cap.text.toLowerCase() !== (captchaText||'').toLowerCase()) return sendJSON(res, { success: false, error: 'Неверная капча' });
      captchaStore.delete(captchaId);
      const users = readJSON(USERS_FILE);
      const hash = crypto.createHash('sha256').update(password).digest('hex');
      const user = users.find(u => u.username === username && u.password === hash);
      if (!user) return sendJSON(res, { success: false, error: 'Неверный логин или пароль' });
      if (user.blocked) return sendJSON(res, { success: false, error: 'Аккаунт заблокирован' });
      // Update IP
      user.ip = getIP(req);
      writeJSON(USERS_FILE, users);
      const sess = ensureSession(req, res);
      sess.userId = user.id;
      notifyAdmin(`🔑 <b>Вход в аккаунт</b>\n👤 Логин: ${username}\n🕐 ${new Date().toLocaleString()}\n🌐 IP: ${getIP(req)}\n📱 UA: ${req.headers['user-agent']}`);
      return sendJSON(res, { success: true, user: { id: user.id, username: user.username, displayName: user.displayName, balance: user.balance } });
    }

    if (pathname === '/api/me' && method === 'GET') {
      const sess = getSession(req);
      if (!sess || !sess.userId) return sendJSON(res, { success: false });
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.id === sess.userId);
      if (!user) return sendJSON(res, { success: false });
      if (user.blocked) return sendJSON(res, { success: false, error: 'blocked' });
      return sendJSON(res, { success: true, user: { id: user.id, username: user.username, displayName: user.displayName, balance: user.balance, wallet: user.wallet } });
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const cookies = (req.headers.cookie||'').split(';').reduce((a,c)=>{const[k,v]=c.trim().split('=');if(k&&v)a[k]=v;return a;},{});
      if (cookies.sid) sessions.delete(cookies.sid);
      return sendJSON(res, { success: true });
    }

    if (pathname === '/api/visit' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      notifyAdmin(`👁 <b>Посещение</b>\n🔗 ${body.url}\n🌐 IP: ${getIP(req)}\n📱 UA: ${req.headers['user-agent']}\n🗣 ${body.language}\n💻 ${body.platform}\n📐 ${body.screen}\n↩️ ${body.referrer||'прямой'}`);
      return sendJSON(res, { ok: true });
    }

    if (pathname === '/api/wallet-connected' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      const sess = getSession(req);
      if (sess && sess.userId) {
        const users = readJSON(USERS_FILE);
        const user = users.find(u => u.id === sess.userId);
        if (user) { user.wallet = body.address; writeJSON(USERS_FILE, users); }
      }
      notifyAdmin(`💎 <b>Wallet подключён</b>\n👛 <code>${body.address}</code>\n💰 ${body.balance} TON\n🌐 ${body.network}\n📱 ${body.appName}\n💻 ${body.platform}\n🕐 ${new Date().toLocaleString()}\n🌐 IP: ${getIP(req)}\n📱 UA: ${req.headers['user-agent']}`);
      return sendJSON(res, { ok: true });
    }

    if (pathname === '/api/ton-rate' && method === 'GET') {
      const rate = await getTonRate();
      return sendJSON(res, { rate });
    }

    if (pathname === '/api/create-payment' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      if (!body.amountTon || body.amountTon < config.ton.minTopupTon) return sendJSON(res, { success: false, error: `Минимум ${config.ton.minTopupTon} TON` });
      const comment = crypto.randomBytes(6).toString('hex').toUpperCase();
      const payment = { id: crypto.randomBytes(8).toString('hex'), address: config.ton.address, amount: body.amountTon, comment, expiresAt: Date.now() + config.ton.paymentTimeoutMinutes * 60 * 1000 };
      return sendJSON(res, { success: true, payment });
    }

    if (pathname === '/api/products' && method === 'GET') {
      return sendJSON(res, readJSON(PRODUCTS_FILE));
    }

    // === BUY PRODUCT ===
    if (pathname === '/api/buy' && method === 'POST') {
      const sess = getSession(req);
      if (!sess || !sess.userId) return sendJSON(res, { success: false, error: 'Не авторизован' });
      const body = JSON.parse(await parseBody(req));
      const { productId, city, zip, email } = body;
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.id === sess.userId);
      if (!user) return sendJSON(res, { success: false, error: 'Пользователь не найден' });
      if (user.blocked) return sendJSON(res, { success: false, error: 'Аккаунт заблокирован' });
      const products = readJSON(PRODUCTS_FILE);
      const product = products.find(p => p.id === productId);
      if (!product) return sendJSON(res, { success: false, error: 'Товар не найден' });
      if (user.balance < product.price) return sendJSON(res, { success: false, error: 'Недостаточно средств' });

      // Deduct balance
      user.balance = Math.round((user.balance - product.price) * 100) / 100;
      writeJSON(USERS_FILE, users);

      // Save order
      const orders = readJSON(ORDERS_FILE);
      const order = { id: crypto.randomBytes(8).toString('hex'), userId: user.id, productId, productName: product.name, price: product.price, city, zip, email, createdAt: new Date().toISOString() };
      orders.push(order);
      writeJSON(ORDERS_FILE, orders);

      notifyAdmin(`🛒 <b>Покупка!</b>\n👤 ${user.username}\n📦 ${product.name}\n💰 $${product.price}\n🏙 ${city}, ${zip}\n📧 ${email}\n💳 Остаток: $${user.balance}`);

      return sendJSON(res, { success: true, newBalance: user.balance });
    }

    // === ADMIN ===
    if (pathname === '/api/admin/login' && method === 'POST') {
      const body = JSON.parse(await parseBody(req));
      if (body.username === config.admin.username && body.password === config.admin.password) {
        const sess = ensureSession(req, res);
        sess.isAdmin = true;
        return sendJSON(res, { success: true });
      }
      return sendJSON(res, { success: false, error: 'Неверные данные' });
    }

    if (pathname === '/api/admin/product' && method === 'POST') {
      const sess = getSession(req);
      if (!sess || !sess.isAdmin) return sendJSON(res, { error: 'Unauthorized' }, 401);

      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) return sendJSON(res, { error: 'No boundary' }, 400);

      const parts = await parseMultipart(req, boundaryMatch[1]);
      const fields = {};
      let imageFile = null;
      for (const part of parts) {
        if (part.filename) { imageFile = part; }
        else { fields[part.name] = part.data.toString(); }
      }

      let imagePath = '';
      if (imageFile) {
        const fname = Date.now() + '-' + imageFile.filename.replace(/[^a-zA-Z0-9._-]/g, '');
        fs.writeFileSync(path.join(__dirname, 'public/uploads', fname), imageFile.data);
        imagePath = '/uploads/' + fname;
      }

      const products = readJSON(PRODUCTS_FILE);
      const product = { id: crypto.randomBytes(8).toString('hex'), name: fields.name||'', description: fields.description||'', price: parseFloat(fields.price)||0, image: imagePath, createdAt: new Date().toISOString() };
      products.push(product);
      writeJSON(PRODUCTS_FILE, products);
      return sendJSON(res, { success: true, product });
    }

    if (pathname.startsWith('/api/admin/product/') && method === 'DELETE') {
      const sess = getSession(req);
      if (!sess || !sess.isAdmin) return sendJSON(res, { error: 'Unauthorized' }, 401);
      const id = pathname.split('/').pop();
      let products = readJSON(PRODUCTS_FILE);
      products = products.filter(p => p.id !== id);
      writeJSON(PRODUCTS_FILE, products);
      return sendJSON(res, { success: true });
    }

    if (pathname === '/api/admin/users' && method === 'GET') {
      const sess = getSession(req);
      if (!sess || !sess.isAdmin) return sendJSON(res, { error: 'Unauthorized' }, 401);
      const users = readJSON(USERS_FILE);
      return sendJSON(res, users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, balance: u.balance, wallet: u.wallet, createdAt: u.createdAt, ip: u.ip || 'N/A', blocked: !!u.blocked })));
    }

    if (pathname === '/api/admin/topup' && method === 'POST') {
      const sess = getSession(req);
      if (!sess || !sess.isAdmin) return sendJSON(res, { error: 'Unauthorized' }, 401);
      const body = JSON.parse(await parseBody(req));
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.id === body.userId);
      if (!user) return sendJSON(res, { success: false, error: 'User not found' });
      let usdAmount = parseFloat(body.amount);
      if (body.currency === 'RUB') usdAmount = body.amount * config.rates.RUB_to_USD;
      else if (body.currency === 'UAH') usdAmount = body.amount * config.rates.UAH_to_USD;
      user.balance = (user.balance || 0) + Math.round(usdAmount * 100) / 100;
      writeJSON(USERS_FILE, users);
      return sendJSON(res, { success: true, newBalance: user.balance });
    }

    // Block/unblock user
    if (pathname === '/api/admin/block' && method === 'POST') {
      const sess = getSession(req);
      if (!sess || !sess.isAdmin) return sendJSON(res, { error: 'Unauthorized' }, 401);
      const body = JSON.parse(await parseBody(req));
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.id === body.userId);
      if (!user) return sendJSON(res, { success: false, error: 'User not found' });
      user.blocked = !user.blocked;
      writeJSON(USERS_FILE, users);
      return sendJSON(res, { success: true, blocked: user.blocked });
    }

    // === STATIC FILES ===
    let filePath;
    if (pathname === '/') filePath = path.join(__dirname, 'public/index.html');
    else if (pathname === '/admin') filePath = path.join(__dirname, 'public/admin.html');
    else if (pathname === '/logo.svg') filePath = path.join(__dirname, 'logo.svg');
    else if (pathname === '/tonconnect-manifest.json') filePath = path.join(__dirname, 'public/tonconnect-manifest.json');
    else filePath = path.join(__dirname, 'public', pathname);

    if (!filePath.startsWith(path.join(__dirname))) {
      res.writeHead(403); return res.end('Forbidden');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }

  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

server.listen(PORT, () => {
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Admin panel: http://localhost:${PORT}/admin`);
});
