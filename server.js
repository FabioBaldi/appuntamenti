const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const Stripe = require("stripe");

loadEnvFile(path.join(__dirname, ".env"));

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml; charset=utf-8"
};

const SESSION_COOKIE_NAME = "appointment_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const REMINDER_LOOP_INTERVAL_MS = 30 * 1000;
const REMINDER_RETRY_MINUTES = Math.max(1, Number(process.env.REMINDER_RETRY_MINUTES || 15));
const REMINDER_RETRY_MS = REMINDER_RETRY_MINUTES * 60 * 1000;
const MAX_LOGO_DATA_URL_LENGTH = 800000;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v23.0";
const DEFAULT_WALLET_CURRENCY = "EUR";
const DEFAULT_SMS_UNIT_PRICE = 0.08;
const DEFAULT_WHATSAPP_UNIT_PRICE = 0.12;
const DEFAULT_WALLET_TOP_UP_OPTIONS = [25, 50, 100];

const CONFIG = {
  port: Number(process.env.PORT || 3000),
  timeZone: process.env.TIME_ZONE || "Europe/Rome",
  sessionSecret: process.env.SESSION_SECRET || "development-session-secret",
  initialAdmin: {
    username: process.env.INITIAL_ADMIN_USERNAME || "admin",
    password: process.env.INITIAL_ADMIN_PASSWORD || "Admin123!",
    fullName: process.env.INITIAL_ADMIN_NAME || "Amministratore"
  },
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
  supabaseKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  supabaseSchema: process.env.SUPABASE_SCHEMA || "public",
  usersTable: "app_users",
  appointmentsTable: "appointments",
  adminChannelConfigsTable: "admin_channel_configs",
  walletTransactionsTable: "wallet_transactions",
  allowMockDelivery: parseBoolean(process.env.ALLOW_MOCK_DELIVERY, true),
  credentialsSecret:
    process.env.APP_CREDENTIALS_SECRET || process.env.SESSION_SECRET || "development-session-secret",
  email: {
    apiKey: process.env.RESEND_API_KEY || "",
    from: process.env.RESEND_FROM_EMAIL || ""
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    smsFrom: process.env.TWILIO_SMS_FROM || "",
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || ""
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    currency: (process.env.STRIPE_WALLET_CURRENCY || DEFAULT_WALLET_CURRENCY).toLowerCase(),
    minimumTopUp: Number(process.env.STRIPE_WALLET_MIN_TOPUP || 10),
    maximumTopUp: Number(process.env.STRIPE_WALLET_MAX_TOPUP || 1000),
    topUpOptions: parseMoneyOptions(process.env.STRIPE_WALLET_TOPUP_OPTIONS, DEFAULT_WALLET_TOP_UP_OPTIONS)
  },
  meta: {
    graphVersion: META_GRAPH_VERSION
  }
};

const SUPABASE_REST_URL = `${CONFIG.supabaseUrl}/rest/v1`;

const IS_VERCEL = Boolean(process.env.VERCEL);

let reminderLoopBusy = false;
let reminderLoopStarted = false;
let appReadyPromise = null;
let stripeClient = null;

async function main() {
  await ensureAppReady();
  startReminderLoop();

  const server = http.createServer(requestListener);

  server.listen(CONFIG.port, () => {
    console.log(`Piattaforma appuntamenti attiva su http://localhost:${CONFIG.port}`);
    console.log(
      `Admin iniziale Supabase: username="${CONFIG.initialAdmin.username}" password="${CONFIG.initialAdmin.password}"`
    );
  });
}

async function ensureAppReady() {
  if (!appReadyPromise) {
    appReadyPromise = (async () => {
      ensureSupabaseConfig();
      await seedInitialAdmin();
    })().catch((error) => {
      appReadyPromise = null;
      throw error;
    });
  }

  return appReadyPromise;
}

function startReminderLoop() {
  if (reminderLoopStarted || IS_VERCEL) {
    return;
  }

  reminderLoopStarted = true;
  setInterval(() => {
    processDueReminders().catch((error) => {
      console.error("Errore reminder:", error.message || error);
    });
  }, REMINDER_LOOP_INTERVAL_MS);
}

async function requestListener(req, res) {
  try {
    await ensureAppReady();
    await handleRequest(req, res);
  } catch (error) {
    console.error("Errore richiesta:", error);
    sendJson(res, 500, {
      error: "Errore interno del server"
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Avvio fallito:", error.message || error);
    process.exitCode = 1;
  });
}

module.exports = requestListener;
module.exports.processDueReminders = processDueReminders;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseMoneyOptions(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return [...fallback];
  }

  const options = String(value)
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => roundCurrency(entry));

  return options.length ? Array.from(new Set(options)).sort((left, right) => left - right) : [...fallback];
}

function ensureSupabaseConfig() {
  if (!CONFIG.supabaseUrl) {
    throw new Error("Manca SUPABASE_URL nel file .env");
  }

  if (!CONFIG.supabaseKey) {
    throw new Error("Manca SUPABASE_SECRET_KEY o SUPABASE_SERVICE_ROLE_KEY nel file .env");
  }
}

function isStripeConfigured() {
  return Boolean(CONFIG.stripe.secretKey && CONFIG.stripe.webhookSecret);
}

function getStripeClient() {
  if (!CONFIG.stripe.secretKey) {
    throw new Error("Manca STRIPE_SECRET_KEY nel file .env");
  }

  if (!stripeClient) {
    stripeClient = new Stripe(CONFIG.stripe.secretKey);
  }

  return stripeClient;
}

async function seedInitialAdmin() {
  try {
    const users = await listUsers({ limit: 1, includeSecrets: false });
    if (users.length > 0) {
      return;
    }

    const now = new Date().toISOString();
    const { salt, hash } = hashPassword(CONFIG.initialAdmin.password);
    const adminId = crypto.randomUUID();

    await createUserRecord({
      id: adminId,
      username: normalizeUsername(CONFIG.initialAdmin.username),
      fullName: CONFIG.initialAdmin.fullName,
      role: "admin",
      createdByUserId: adminId,
      ownerAdminId: adminId,
      isPlatformOwner: true,
      logoDataUrl: null,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: now,
      updatedAt: now
    });
  } catch (error) {
    throw new Error(
      `Impossibile inizializzare Supabase. Esegui prima lo script supabase/schema.sql. Dettagli: ${
        error.message || error
      }`
    );
  }
}

function hashPassword(password, existingSalt) {
  const salt = existingSalt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, user) {
  const calculated = hashPassword(password, user.passwordSalt).hash;
  const left = Buffer.from(calculated, "hex");
  const right = Buffer.from(user.passwordHash, "hex");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function normalizeUsername(username) {
  return String(username || "").trim().toLowerCase();
}

function normalizeRole(role) {
  return role === "admin" ? "admin" : "user";
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const cookies = {};

  for (const pair of header.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) {
      continue;
    }
    cookies[key] = decodeURIComponent(rest.join("=") || "");
  }

  return cookies;
}

function signValue(value) {
  return crypto.createHmac("sha256", CONFIG.sessionSecret).update(value).digest("hex");
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function createAuthToken(user) {
  const payload = {
    userId: user.id,
    exp: Date.now() + SESSION_TTL_MS
  };

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = signValue(encoded);
  return `${encoded}.${signature}`;
}

function verifyAuthToken(token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) {
    return null;
  }

  if (!timingSafeEqualString(signValue(encoded), signature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.userId || !payload.exp || payload.exp <= Date.now()) {
      return null;
    }
    return payload;
  } catch (error) {
    return null;
  }
}

function serializeSessionCookie(user) {
  const token = createAuthToken(user);
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ].join("; ");
}

function serializeExpiredSessionCookie() {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}

async function getAuthenticatedUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const payload = verifyAuthToken(token);
  if (!payload) {
    return null;
  }

  return findPublicUserById(payload.userId);
}

async function requireAuth(req, res) {
  const user = await getAuthenticatedUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Sessione non valida" });
    return null;
  }

  return user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
  if (!user) {
    return null;
  }

  if (user.role !== "admin") {
    sendJson(res, 403, { error: "Operazione consentita solo agli admin" });
    return null;
  }

  return user;
}

function sanitizeUser(user, userMap) {
  const effectiveAdminId = getEffectiveAdminId(user);
  const ownerAdmin = effectiveAdminId && userMap ? userMap[effectiveAdminId] : null;
  const creatorUser = user.createdByUserId && userMap ? userMap[user.createdByUserId] : null;

  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    isPlatformOwner: Boolean(user.isPlatformOwner),
    isBrandOwner: user.role === "admin" && user.ownerAdminId === user.id,
    createdByUserId: user.createdByUserId || null,
    createdByName: creatorUser ? creatorUser.fullName : null,
    ownerAdminId: user.ownerAdminId || null,
    effectiveAdminId,
    ownerAdminName: ownerAdmin ? ownerAdmin.fullName : null,
    logoDataUrl: user.role === "admin" ? user.logoDataUrl || null : null,
    effectiveLogoDataUrl:
      user.logoDataUrl || ownerAdmin?.logoDataUrl || null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function getEffectiveAdminId(user) {
  if (user.role === "admin") {
    return user.isBrandOwner ? user.id : user.ownerAdminId || user.id;
  }

  return user.ownerAdminId || null;
}

function canManageBranchDeliveryConfig(user) {
  return Boolean(user && user.role === "admin" && getEffectiveAdminId(user));
}

function normalizeWhatsappProviderMode(value) {
  return String(value || "").trim().toLowerCase() === "meta_cloud" ? "meta_cloud" : "system";
}

function normalizeBillingModel(value) {
  return String(value || "").trim().toLowerCase() === "wallet" ? "wallet" : "platform";
}

function buildRawUserMap(users) {
  return Object.fromEntries(users.map((entry) => [entry.id, entry]));
}

async function listPublicUsers() {
  const users = await listUsers({ includeSecrets: false });
  const userMap = buildRawUserMap(users);
  return users.map((entry) => sanitizeUser(entry, userMap));
}

async function findPublicUserById(userId) {
  const users = await listUsers({ includeSecrets: false });
  const userMap = buildRawUserMap(users);
  const user = users.find((entry) => entry.id === userId);
  return user ? sanitizeUser(user, userMap) : null;
}

function buildVisibleUserScope(actor, users) {
  if (!actor) {
    return {
      visibleUsers: [],
      visibleUserIds: new Set()
    };
  }

  if (actor.role !== "admin") {
    const visibleUsers = users.filter((user) => user.id === actor.id);
    return {
      visibleUsers,
      visibleUserIds: new Set(visibleUsers.map((user) => user.id))
    };
  }

  if (actor.isPlatformOwner) {
    return {
      visibleUsers: users,
      visibleUserIds: new Set(users.map((user) => user.id))
    };
  }

  const visibleUsers = users.filter((user) => user.id === actor.id || user.createdByUserId === actor.id);
  return {
    visibleUsers,
    visibleUserIds: new Set(visibleUsers.map((user) => user.id))
  };
}

function canAdminManageUser(actor, target) {
  if (!actor || actor.role !== "admin" || !target) {
    return false;
  }

  if (actor.isPlatformOwner) {
    return true;
  }

  if (target.isPlatformOwner) {
    return false;
  }

  if (actor.id === target.id) {
    return true;
  }

  return target.createdByUserId === actor.id;
}

async function readJsonBody(req) {
  const rawBuffer = await readRawBody(req);
  if (!rawBuffer.length) {
    return {};
  }

  const raw = rawBuffer.toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

async function readRawBody(req) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > 1024 * 1024) {
      throw new Error("Payload troppo grande");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return Buffer.alloc(0);
  }

  return Buffer.concat(chunks);
}

function getRequestOrigin(req) {
  const host = req.headers.host || `localhost:${CONFIG.port}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (IS_VERCEL ? "https" : "http");
  return `${protocol}://${host}`;
}

async function handleRequest(req, res) {
  const host = req.headers.host || `localhost:${CONFIG.port}`;
  const url = new URL(req.url, `http://${host}`);

  if (url.pathname.startsWith("/api/")) {
    return handleApiRequest(req, res, url);
  }

  return serveStatic(req, res, url);
}

async function handleApiRequest(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      status: "ok",
      now: new Date().toISOString(),
      storage: "supabase",
      delivery: await getDeliveryStatusForUser(null)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    try {
      if (!CONFIG.stripe.webhookSecret) {
        return sendJson(res, 400, { error: "Webhook Stripe non configurato" });
      }

      const signature = req.headers["stripe-signature"];
      if (!signature) {
        return sendJson(res, 400, { error: "Firma Stripe mancante" });
      }

      const rawBody = await readRawBody(req);
      const event = getStripeClient().webhooks.constructEvent(
        rawBody,
        signature,
        CONFIG.stripe.webhookSecret
      );

      await handleStripeWebhookEvent(event);
      return sendJson(res, 200, { received: true });
    } catch (error) {
      return sendJson(res, 400, { error: error.message || "Webhook Stripe non valido" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");

    if (!username || !password) {
      return sendJson(res, 400, { error: "Username e password sono obbligatori" });
    }

    const user = await findUserByUsername(username);
    if (!user || !verifyPassword(password, user)) {
      return sendJson(res, 401, { error: "Credenziali non valide" });
    }

    const publicUser = await findPublicUserById(user.id);

    res.setHeader("Set-Cookie", serializeSessionCookie(user));
    return sendJson(res, 200, {
      user: publicUser,
      delivery: await getDeliveryStatusForUser(publicUser)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    res.setHeader("Set-Cookie", serializeExpiredSessionCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }

    return sendJson(res, 200, {
      user,
      delivery: await getDeliveryStatusForUser(user)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/settings/delivery") {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }

    return sendJson(res, 200, {
      delivery: await getDeliveryStatusForUser(user)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/settings/branch-config") {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    try {
      const targetBranchOwner = await resolveBranchOwnerForSettingsRequest(user, url.searchParams.get("targetAdminId"));
      const users = await listUsers({ includeSecrets: false });
      const userMap = buildRawUserMap(users);
      const config = await findAdminChannelConfigByBrandOwnerId(targetBranchOwner.id);
      return sendJson(res, 200, {
        config: {
          ...sanitizeAdminChannelConfig(config, userMap, targetBranchOwner),
          canManageMessaging: canManageBranchDeliveryConfig(user),
          canManagePremium: Boolean(user && user.isPlatformOwner),
          branchOwnerId: targetBranchOwner.id,
          branchOwnerName: targetBranchOwner.fullName
        },
        billing: await buildBranchBillingPayload(user, targetBranchOwner, config),
        targetAdmin: sanitizeUser(targetBranchOwner, userMap)
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (
    req.method === "PUT" &&
    ["/api/settings/branch-messaging", "/api/settings/whatsapp-branch"].includes(url.pathname)
  ) {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    if (!canManageBranchDeliveryConfig(user)) {
      return sendJson(res, 403, {
        error: "Solo gli admin possono configurare il profilo messaggi del proprio ramo"
      });
    }

    const body = await readJsonBody(req);

    try {
      const targetBranchOwner = await resolveBranchOwnerForSettingsRequest(
        user,
        String(body.targetAdminId || "").trim() || null
      );
      const existingConfig = await findAdminChannelConfigByBrandOwnerId(targetBranchOwner.id);
      const nextConfig = buildBranchMessagingConfigPayload(
        body,
        user,
        existingConfig,
        targetBranchOwner
      );
      if (nextConfig.whatsappMode === "meta_cloud") {
        await validateMetaWhatsappConfig(nextConfig);
      }

      const savedConfig = await upsertAdminChannelConfig(nextConfig);
      const users = await listUsers({ includeSecrets: false });
      const userMap = buildRawUserMap(users);
      return sendJson(res, 200, {
        config: {
          ...sanitizeAdminChannelConfig(savedConfig, userMap, targetBranchOwner),
          canManageMessaging: canManageBranchDeliveryConfig(user),
          canManagePremium: Boolean(user && user.isPlatformOwner),
          branchOwnerId: targetBranchOwner.id,
          branchOwnerName: targetBranchOwner.fullName
        },
        billing: await buildBranchBillingPayload(user, targetBranchOwner, savedConfig),
        delivery: await getDeliveryStatusForUser(user)
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/branch-billing") {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    if (!user.isPlatformOwner) {
      return sendJson(res, 403, {
        error: "Solo l'admin principale puo aggiornare saldo e listino dei rami"
      });
    }

    const body = await readJsonBody(req);

    try {
      const targetBranchOwner = await resolveBranchOwnerForSettingsRequest(
        user,
        String(body.targetAdminId || "").trim()
      );
      const existingConfig = await findAdminChannelConfigByBrandOwnerId(targetBranchOwner.id);
      const nextConfig = buildBranchBillingConfigPayload(body, targetBranchOwner, existingConfig);
      const savedConfig = await upsertAdminChannelConfig(nextConfig);
      const users = await listUsers({ includeSecrets: false });
      const userMap = buildRawUserMap(users);
      return sendJson(res, 200, {
        config: sanitizeAdminChannelConfig(savedConfig, userMap, targetBranchOwner),
        billing: await buildBranchBillingPayload(user, targetBranchOwner, savedConfig),
        delivery: await getDeliveryStatusForUser(user)
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/billing/checkout-session") {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    if (!isStripeConfigured()) {
      return sendJson(res, 400, {
        error: "Stripe non configurato. Inserisci STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET."
      });
    }

    const body = await readJsonBody(req);

    try {
      const targetBranchOwner = await resolveBranchOwnerForSettingsRequest(
        user,
        String(body.targetAdminId || "").trim() || null
      );
      const amount = normalizeTopUpAmount(body.amount);
      const session = await createStripeTopUpSession(req, user, targetBranchOwner, amount);
      return sendJson(res, 200, {
        url: session.url,
        sessionId: session.id
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/users") {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    const allUsers = await listUsers({ includeSecrets: false });
    const rawUserMap = buildRawUserMap(allUsers);
    const scope = buildVisibleUserScope(user, allUsers);
    const users = scope.visibleUsers.map((entry) => sanitizeUser(entry, rawUserMap));
    return sendJson(res, 200, { users });
  }

  if (req.method === "POST" && url.pathname === "/api/users") {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    const body = await readJsonBody(req);
    const username = normalizeUsername(body.username);
    const password = String(body.password || "");
    const fullName = String(body.fullName || "").trim();
    const role = normalizeRole(body.role);

    if (!username || !password || !fullName) {
      return sendJson(res, 400, {
        error: "Nome, username e password sono obbligatori"
      });
    }

    if (password.length < 6) {
      return sendJson(res, 400, {
        error: "La password deve avere almeno 6 caratteri"
      });
    }

    const existingUser = await findUserByUsername(username);
    if (existingUser) {
      return sendJson(res, 409, { error: "Username gia presente" });
    }

    try {
      const { salt, hash } = hashPassword(password);
      const now = new Date().toISOString();
      const newUserId = crypto.randomUUID();
      const isAdmin = role === "admin";
      const requestedLogoDataUrl = user.isPlatformOwner ? normalizeLogoDataUrl(body.logoDataUrl) : null;
      const inheritedOwnerAdminId = user.ownerAdminId || user.id;

      const createdUser = await createUserRecord({
        id: newUserId,
        username,
        fullName,
        role,
        createdByUserId: user.id,
        ownerAdminId: isAdmin && user.isPlatformOwner ? newUserId : inheritedOwnerAdminId,
        isPlatformOwner: false,
        logoDataUrl: isAdmin && user.isPlatformOwner ? requestedLogoDataUrl : null,
        passwordSalt: salt,
        passwordHash: hash,
        createdAt: now,
        updatedAt: now
      });

      return sendJson(res, 201, {
        user: await findPublicUserById(createdUser.id)
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch) {
    const targetUserId = userMatch[1];

    if (req.method === "PUT") {
      const actor = await requireAdmin(req, res);
      if (!actor) {
        return;
      }

      const targetPublicUser = await findPublicUserById(targetUserId);
      const targetRawUser = await findUserById(targetUserId);
      if (!targetPublicUser || !targetRawUser) {
        return sendJson(res, 404, { error: "Utente non trovato" });
      }

      if (!canAdminManageUser(actor, targetPublicUser)) {
        return sendJson(res, 403, { error: "Non puoi modificare questo account" });
      }

      const body = await readJsonBody(req);
      const username = normalizeUsername(body.username);
      const fullName = String(body.fullName || "").trim();
      const password = String(body.password || "");
      const requestedRole = body.role ? normalizeRole(body.role) : targetRawUser.role;

      if (!username || !fullName) {
        return sendJson(res, 400, { error: "Nome e username sono obbligatori" });
      }

      if (requestedRole !== targetRawUser.role) {
        return sendJson(res, 400, { error: "Il ruolo non puo essere modificato da questa schermata" });
      }

      if (password && password.length < 6) {
        return sendJson(res, 400, { error: "La password deve avere almeno 6 caratteri" });
      }

      const existingUser = await findUserByUsername(username);
      if (existingUser && existingUser.id !== targetRawUser.id) {
        return sendJson(res, 409, { error: "Username gia presente" });
      }

      const updatedUser = {
        ...targetRawUser,
        username,
        fullName,
        updatedAt: new Date().toISOString()
      };

      if (password) {
        const { salt, hash } = hashPassword(password);
        updatedUser.passwordSalt = salt;
        updatedUser.passwordHash = hash;
      }

      const savedUser = await updateUserRecord(targetRawUser.id, updatedUser);
      return sendJson(res, 200, {
        user: await findPublicUserById(savedUser.id)
      });
    }

    if (req.method === "DELETE") {
      const actor = await requireAdmin(req, res);
      if (!actor) {
        return;
      }

      const targetPublicUser = await findPublicUserById(targetUserId);
      if (!targetPublicUser) {
        return sendJson(res, 404, { error: "Utente non trovato" });
      }

      if (!canAdminManageUser(actor, targetPublicUser)) {
        return sendJson(res, 403, { error: "Non puoi eliminare questo account" });
      }

      if (targetPublicUser.isPlatformOwner) {
        return sendJson(res, 403, { error: "L'admin principale non puo essere cancellato" });
      }

      if (await userHasDependents(targetUserId)) {
        return sendJson(res, 409, {
          error: "Non puoi eliminare questo account perche ha altri utenti collegati al suo ramo"
        });
      }

      if (await userHasAppointments(targetUserId)) {
        return sendJson(res, 409, {
          error: "Non puoi eliminare questo account perche ha appuntamenti collegati"
        });
      }

      await deleteUserRecord(targetUserId);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (req.method === "PUT" && url.pathname === "/api/branding") {
    const user = await requireAdmin(req, res);
    if (!user) {
      return;
    }

    if (!user.isPlatformOwner) {
      return sendJson(res, 403, { error: "Solo l'admin principale puo gestire i loghi degli admin" });
    }

    const body = await readJsonBody(req);
    const targetAdminId = String(body.targetAdminId || "").trim();
    if (!targetAdminId) {
      return sendJson(res, 400, { error: "Seleziona un admin da aggiornare" });
    }

    const rawUser = await findUserById(targetAdminId);
    if (!rawUser || rawUser.role !== "admin" || rawUser.isPlatformOwner || rawUser.ownerAdminId !== rawUser.id) {
      return sendJson(res, 404, { error: "Admin brand non trovato o non gestibile" });
    }

    try {
      const updatedUser = await updateUserRecord(rawUser.id, {
        ...rawUser,
        ownerAdminId: rawUser.id,
        isPlatformOwner: false,
        logoDataUrl: normalizeLogoDataUrl(body.logoDataUrl)
      });

      return sendJson(res, 200, {
        user: await findPublicUserById(updatedUser.id)
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/appointments") {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }

    const [users, appointments] = await Promise.all([
      listUsers({ includeSecrets: false }),
      listAppointments()
    ]);

    const rawUserMap = buildRawUserMap(users);
    const userMap = Object.fromEntries(
      users.map((entry) => [entry.id, sanitizeUser(entry, rawUserMap)])
    );
    const scope = buildVisibleUserScope(user, users);
    const visibleAppointments = getVisibleAppointmentsForUser(user, appointments, scope.visibleUserIds)
      .map((entry) => enrichAppointment(entry, userMap))
      .sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());

    return sendJson(res, 200, { appointments: visibleAppointments });
  }

  if (req.method === "POST" && url.pathname === "/api/appointments") {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }

    const body = await readJsonBody(req);
    const users = await listUsers({ includeSecrets: false });
    const scope = buildVisibleUserScope(user, users);

    try {
      const appointment = normalizeAppointmentPayload(body, user, null, scope.visibleUsers);
      const created = await createAppointmentRecord(appointment);
      const rawUserMap = buildRawUserMap(users);
      const userMap = Object.fromEntries(
        users.map((entry) => [entry.id, sanitizeUser(entry, rawUserMap)])
      );
      return sendJson(res, 201, {
        appointment: enrichAppointment(created, userMap)
      });
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  }

  const appointmentMatch = url.pathname.match(/^\/api\/appointments\/([^/]+)$/);
  if (appointmentMatch) {
    const appointmentId = appointmentMatch[1];
    if (req.method === "PUT") {
      const user = await requireAuth(req, res);
      if (!user) {
        return;
      }

      const body = await readJsonBody(req);
      const existing = await findAppointmentById(appointmentId);
      if (!existing) {
        return sendJson(res, 404, { error: "Appuntamento non trovato" });
      }

      const users = await listUsers({ includeSecrets: false });
      const scope = buildVisibleUserScope(user, users);

      if (!canManageAppointment(user, existing, scope.visibleUserIds)) {
        return sendJson(res, 403, { error: "Non puoi modificare questo appuntamento" });
      }

      try {
        const updatedAppointment = normalizeAppointmentPayload(body, user, existing, scope.visibleUsers);
        const saved = await updateAppointmentRecord(appointmentId, updatedAppointment);
        const rawUserMap = buildRawUserMap(users);
        const userMap = Object.fromEntries(
          users.map((entry) => [entry.id, sanitizeUser(entry, rawUserMap)])
        );
        return sendJson(res, 200, {
          appointment: enrichAppointment(saved, userMap)
        });
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (req.method === "DELETE") {
      const user = await requireAuth(req, res);
      if (!user) {
        return;
      }

      const appointment = await findAppointmentById(appointmentId);
      if (!appointment) {
        return sendJson(res, 404, { error: "Appuntamento non trovato" });
      }

      const users = await listUsers({ includeSecrets: false });
      const scope = buildVisibleUserScope(user, users);

      if (!canManageAppointment(user, appointment, scope.visibleUserIds)) {
        return sendJson(res, 403, { error: "Non puoi eliminare questo appuntamento" });
      }

      await deleteAppointmentRecord(appointmentId);
      return sendJson(res, 200, { ok: true });
    }
  }

  const manualReminderMatch = url.pathname.match(/^\/api\/appointments\/([^/]+)\/send-reminder$/);
  if (manualReminderMatch && req.method === "POST") {
    const user = await requireAuth(req, res);
    if (!user) {
      return;
    }

    const appointmentId = manualReminderMatch[1];
    const appointment = await findAppointmentById(appointmentId);
    if (!appointment) {
      return sendJson(res, 404, { error: "Appuntamento non trovato" });
    }

    const users = await listUsers({ includeSecrets: false });
    const scope = buildVisibleUserScope(user, users);

    if (!canManageAppointment(user, appointment, scope.visibleUserIds)) {
      return sendJson(res, 403, { error: "Non puoi inviare reminder per questo appuntamento" });
    }

    if (!appointment.reminderEnabled || !appointment.reminderChannels.length) {
      return sendJson(res, 400, { error: "Reminder non configurato per questo appuntamento" });
    }

    const results = await dispatchReminderForAppointment(appointment, { forceAllChannels: true });
    const merged = mergeReminderResults(appointment, results);
    const saved = await updateAppointmentRecord(appointmentId, merged);
    const rawUserMap = buildRawUserMap(users);
    const userMap = Object.fromEntries(
      users.map((entry) => [entry.id, sanitizeUser(entry, rawUserMap)])
    );

    return sendJson(res, 200, {
      appointment: enrichAppointment(saved, userMap),
      results
    });
  }

  return sendJson(res, 404, { error: "Endpoint non trovato" });
}

function getVisibleAppointmentsForUser(user, appointments, visibleUserIds) {
  if (user.role === "admin") {
    if (user.isPlatformOwner) {
      return appointments;
    }

    return appointments.filter((appointment) => {
      return visibleUserIds.has(appointment.assignedUserId) || visibleUserIds.has(appointment.createdByUserId);
    });
  }

  return appointments.filter((appointment) => {
    return appointment.assignedUserId === user.id || appointment.createdByUserId === user.id;
  });
}

function canManageAppointment(user, appointment, visibleUserIds) {
  if (user.role === "admin") {
    if (user.isPlatformOwner) {
      return true;
    }

    return visibleUserIds.has(appointment.assignedUserId) || visibleUserIds.has(appointment.createdByUserId);
  }

  return appointment.assignedUserId === user.id || appointment.createdByUserId === user.id;
}

function normalizeAppointmentPayload(payload, actor, existing, users) {
  const now = new Date().toISOString();
  const title = String(payload.title || "").trim();
  const service = String(payload.service || "").trim();
  const description = String(payload.description || "").trim();
  const clientName = String(payload.clientName || "").trim();
  const clientEmail = String(payload.clientEmail || "").trim();
  const clientPhone = String(payload.clientPhone || "").trim();
  const location = String(payload.location || "").trim();
  const notes = String(payload.notes || "").trim();
  const status = normalizeAppointmentStatus(payload.status || "scheduled");
  const startAt = normalizeDate(payload.startAt);
  const endAt = payload.endAt ? normalizeDate(payload.endAt) : "";
  const reminderEnabled = Boolean(payload.reminderEnabled);
  const reminderMinutesBefore = Math.max(0, Number(payload.reminderMinutesBefore || 0));
  const reminderMessage = String(payload.reminderMessage || "").trim();
  const requestedChannels = Array.isArray(payload.reminderChannels) ? payload.reminderChannels : [];
  const reminderChannels = Array.from(
    new Set(
      requestedChannels
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter((entry) => ["email", "sms", "whatsapp"].includes(entry))
    )
  );

  if (!title || !service || !clientName || !startAt) {
    throw new Error("Titolo, servizio, cliente e data sono obbligatori");
  }

  if (endAt && new Date(endAt).getTime() < new Date(startAt).getTime()) {
    throw new Error("La data di fine deve essere successiva a quella di inizio");
  }

  if (clientEmail && !isValidEmail(clientEmail)) {
    throw new Error("Email cliente non valida");
  }

  if (clientPhone && !isValidPhone(clientPhone)) {
    throw new Error("Telefono cliente non valido");
  }

  if (reminderEnabled) {
    if (!reminderChannels.length) {
      throw new Error("Se attivi il reminder devi selezionare almeno un canale");
    }

    if (reminderChannels.includes("email") && !clientEmail) {
      throw new Error("Per inviare email serve un indirizzo email del cliente");
    }

    if (
      (reminderChannels.includes("sms") || reminderChannels.includes("whatsapp")) &&
      !clientPhone
    ) {
      throw new Error("Per SMS o WhatsApp serve un numero di telefono del cliente");
    }
  }

  let assignedUserId = actor.id;
  if (actor.role === "admin") {
    assignedUserId = String(payload.assignedUserId || "").trim() || actor.id;
  } else if (existing) {
    assignedUserId = existing.assignedUserId;
  }

  const assignedUser = users.find((entry) => entry.id === assignedUserId);
  if (!assignedUser) {
    throw new Error("Utente assegnato non valido");
  }

  const normalized = {
    title,
    service,
    description,
    clientName,
    clientEmail,
    clientPhone,
    location,
    notes,
    startAt,
    endAt,
    status,
    assignedUserId,
    reminderEnabled,
    reminderMinutesBefore,
    reminderChannels,
    reminderMessage
  };

  const reminderFingerprint = buildReminderFingerprint(normalized);
  const versionChanged =
    !existing || existing.reminderFingerprint !== reminderFingerprint || existing.status !== status;
  const reminderVersion = versionChanged
    ? crypto.randomUUID()
    : existing.reminderVersion || crypto.randomUUID();
  const reminderState = versionChanged
    ? createReminderState(reminderVersion)
    : normalizeReminderState(existing.reminderState, reminderVersion);

  if (existing) {
    return {
      ...existing,
      ...normalized,
      reminderFingerprint,
      reminderVersion,
      reminderState,
      updatedAt: now
    };
  }

  return {
    id: crypto.randomUUID(),
    ...normalized,
    createdByUserId: actor.id,
    reminderFingerprint,
    reminderVersion,
    reminderState,
    reminderLogs: [],
    createdAt: now,
    updatedAt: now
  };
}

function normalizeAppointmentStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["scheduled", "completed", "cancelled"].includes(normalized)) {
    return normalized;
  }
  return "scheduled";
}

function normalizeDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Data non valida");
  }
  return date.toISOString();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isValidPhone(value) {
  return /^[+\d][\d\s().-]{5,}$/.test(value);
}

function normalizeLogoDataUrl(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  if (!normalized.startsWith("data:image/")) {
    throw new Error("Il logo deve essere un'immagine valida.");
  }

  if (normalized.length > MAX_LOGO_DATA_URL_LENGTH) {
    throw new Error("Il logo e troppo grande. Usa un file immagine piu leggero.");
  }

  return normalized;
}

function normalizeMoney(value, fallback = 0) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallback;
  }
  return roundCurrency(normalized);
}

function normalizeUnitPrice(value, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallback;
  }
  return Math.round(normalized * 10000) / 10000;
}

function roundCurrency(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return 0;
  }
  return Math.round(normalized * 100) / 100;
}

function moneyToCents(value) {
  return Math.round(roundCurrency(value) * 100);
}

function centsToMoney(value) {
  return roundCurrency(Number(value || 0) / 100);
}

function formatMoney(value, currency = DEFAULT_WALLET_CURRENCY) {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: String(currency || DEFAULT_WALLET_CURRENCY).toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(roundCurrency(value));
}

function deriveSmsSenderId(value) {
  const ascii = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compact = ascii.replace(/\s+/g, "");
  if (!compact || !/[A-Za-z]/.test(compact)) {
    return "";
  }
  return compact.slice(0, 11);
}

function supportsAlphanumericSmsSender(phoneNumber) {
  return String(phoneNumber || "").trim().startsWith("+39");
}

function buildReminderFingerprint(appointment) {
  return JSON.stringify({
    status: appointment.status,
    title: appointment.title,
    service: appointment.service,
    clientName: appointment.clientName,
    clientEmail: appointment.clientEmail,
    clientPhone: appointment.clientPhone,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    location: appointment.location,
    reminderEnabled: appointment.reminderEnabled,
    reminderMinutesBefore: appointment.reminderMinutesBefore,
    reminderChannels: [...appointment.reminderChannels].sort(),
    reminderMessage: appointment.reminderMessage
  });
}

function createReminderState(version) {
  return {
    version,
    sentChannels: [],
    failedChannels: [],
    lastAttemptAt: null,
    lastErrorByChannel: {}
  };
}

function normalizeReminderState(state, version) {
  if (!state || state.version !== version) {
    return createReminderState(version);
  }

  return {
    version,
    sentChannels: Array.isArray(state.sentChannels) ? state.sentChannels : [],
    failedChannels: Array.isArray(state.failedChannels) ? state.failedChannels : [],
    lastAttemptAt: state.lastAttemptAt || null,
    lastErrorByChannel:
      state.lastErrorByChannel && typeof state.lastErrorByChannel === "object"
        ? state.lastErrorByChannel
        : {}
  };
}

function getPendingReminderChannels(appointment) {
  const state = normalizeReminderState(appointment.reminderState, appointment.reminderVersion);
  return (appointment.reminderChannels || []).filter((channel) => !state.sentChannels.includes(channel));
}

function isReminderDue(appointment, nowMs) {
  if (!appointment.reminderEnabled) {
    return false;
  }

  if (appointment.status !== "scheduled") {
    return false;
  }

  const pendingChannels = getPendingReminderChannels(appointment);
  if (!pendingChannels.length) {
    return false;
  }

  const dueAtMs =
    new Date(appointment.startAt).getTime() - Number(appointment.reminderMinutesBefore || 0) * 60 * 1000;
  if (nowMs < dueAtMs) {
    return false;
  }

  const state = normalizeReminderState(appointment.reminderState, appointment.reminderVersion);
  if (state.lastAttemptAt && nowMs - new Date(state.lastAttemptAt).getTime() < REMINDER_RETRY_MS) {
    return false;
  }

  return true;
}

function enrichAppointment(appointment, userMap) {
  const state = normalizeReminderState(appointment.reminderState, appointment.reminderVersion);
  const pendingReminderChannels = getPendingReminderChannels(appointment);
  const reminderDueAt = new Date(
    new Date(appointment.startAt).getTime() -
      Number(appointment.reminderMinutesBefore || 0) * 60 * 1000
  ).toISOString();

  return {
    ...appointment,
    reminderState: state,
    pendingReminderChannels,
    reminderDueAt,
    assignedUserName:
      userMap[appointment.assignedUserId]?.fullName ||
      userMap[appointment.assignedUserId]?.username ||
      "Utente non trovato",
    createdByName:
      userMap[appointment.createdByUserId]?.fullName ||
      userMap[appointment.createdByUserId]?.username ||
      "Utente non trovato"
  };
}

async function getDeliveryStatusForUser(user) {
  const emailConfigured = Boolean(CONFIG.email.apiKey && CONFIG.email.from);
  const users = await listUsers({ includeSecrets: false });
  const userMap = buildRawUserMap(users);
  const effectiveAdminId = user ? getEffectiveAdminId(user) : null;
  const branchOwner = effectiveAdminId ? userMap[effectiveAdminId] || null : null;
  const rawConfig = effectiveAdminId
    ? await findAdminChannelConfigByBrandOwnerId(effectiveAdminId)
    : getDefaultAdminChannelConfig(null, null);
  const branchConfig = sanitizeAdminChannelConfig(rawConfig, userMap, branchOwner);
  const smsConfigured = Boolean(
    CONFIG.twilio.accountSid &&
      CONFIG.twilio.authToken &&
      (CONFIG.twilio.smsFrom || branchConfig.smsSenderId)
  );
  const whatsappStatus = resolveWhatsappChannelStatus(rawConfig);
  const branchBilling = await buildBranchBillingPayload(user, branchOwner, rawConfig);
  const smsProvider = smsConfigured
    ? branchConfig.smsSenderId
      ? `Mittente ramo: ${branchConfig.smsSenderId}`
      : "Numero piattaforma"
    : CONFIG.allowMockDelivery
      ? "Mock"
      : "Non configurato";

  return {
    mockMode: CONFIG.allowMockDelivery,
    retryMinutes: REMINDER_RETRY_MINUTES,
    channels: {
      email: {
        configured: emailConfigured,
        provider: emailConfigured ? "Resend" : CONFIG.allowMockDelivery ? "Mock" : "Non configurato",
        mode: emailConfigured ? "live" : CONFIG.allowMockDelivery ? "mock" : "disabled"
      },
      sms: {
        configured: smsConfigured,
        provider: smsProvider,
        mode: smsConfigured ? "live" : CONFIG.allowMockDelivery ? "mock" : "disabled"
      },
      whatsapp: {
        configured: whatsappStatus.configured,
        provider: whatsappStatus.provider,
        mode: whatsappStatus.mode
      }
    },
    branchMessagingConfig: {
      ...branchConfig,
      canManageMessaging: canManageBranchDeliveryConfig(user),
      canManagePremium: Boolean(user && user.isPlatformOwner),
      canManageBilling: Boolean(user && user.isPlatformOwner),
      branchOwnerId: effectiveAdminId,
      branchOwnerName: branchOwner ? branchOwner.fullName : null,
      usesClientBilling: rawConfig.whatsappMode === "meta_cloud"
    },
    branchBilling,
    whatsappBranchConfig: {
      ...branchConfig,
      canManage: canManageBranchDeliveryConfig(user),
      branchOwnerId: effectiveAdminId,
      branchOwnerName: branchOwner ? branchOwner.fullName : null,
      usesClientBilling: rawConfig.whatsappMode === "meta_cloud"
    }
  };
}

function getDefaultAdminChannelConfig(brandOwnerUserId, branchOwnerUser) {
  const fallbackBusinessName = branchOwnerUser ? branchOwnerUser.fullName || "" : "";
  return {
    brandOwnerUserId: brandOwnerUserId || null,
    businessDisplayName: fallbackBusinessName,
    smsSenderId: "",
    whatsappMode: "system",
    metaAccessTokenEncrypted: null,
    metaPhoneNumberId: null,
    metaWabaId: null,
    metaBusinessAccountId: null,
    metaDisplayPhoneNumber: null,
    billingModel: "platform",
    walletBalance: 0,
    walletCurrency: DEFAULT_WALLET_CURRENCY,
    smsUnitPrice: DEFAULT_SMS_UNIT_PRICE,
    whatsappUnitPrice: DEFAULT_WHATSAPP_UNIT_PRICE,
    createdAt: null,
    updatedAt: null
  };
}

function sanitizeAdminChannelConfig(config, userMap, explicitBranchOwner) {
  const branchOwner =
    explicitBranchOwner || (config.brandOwnerUserId && userMap ? userMap[config.brandOwnerUserId] : null);
  const businessDisplayName = String(config.businessDisplayName || branchOwner?.fullName || "").trim();
  const suggestedSmsSenderId = deriveSmsSenderId(businessDisplayName || branchOwner?.fullName || "");
  const smsSenderId = String(config.smsSenderId || "").trim() || suggestedSmsSenderId;
  return {
    brandOwnerUserId: config.brandOwnerUserId || null,
    branchOwnerName: branchOwner ? branchOwner.fullName : null,
    businessDisplayName,
    smsSenderId,
    suggestedSmsSenderId,
    whatsappMode: normalizeWhatsappProviderMode(config.whatsappMode),
    hasStoredMetaAccessToken: Boolean(config.metaAccessTokenEncrypted),
    metaPhoneNumberId: config.metaPhoneNumberId || "",
    metaWabaId: config.metaWabaId || "",
    metaBusinessAccountId: config.metaBusinessAccountId || "",
    metaDisplayPhoneNumber: config.metaDisplayPhoneNumber || "",
    billingModel: normalizeBillingModel(config.billingModel),
    walletBalance: normalizeMoney(config.walletBalance || 0, 0),
    walletCurrency: config.walletCurrency || DEFAULT_WALLET_CURRENCY,
    smsUnitPrice: normalizeUnitPrice(config.smsUnitPrice, DEFAULT_SMS_UNIT_PRICE),
    whatsappUnitPrice: normalizeUnitPrice(config.whatsappUnitPrice, DEFAULT_WHATSAPP_UNIT_PRICE),
    sharedWhatsappSender: CONFIG.twilio.whatsappFrom || "",
    createdAt: config.createdAt || null,
    updatedAt: config.updatedAt || null
  };
}

function resolveWhatsappChannelStatus(config) {
  const normalizedConfig = config || getDefaultAdminChannelConfig(null);
  if (normalizedConfig.whatsappMode === "meta_cloud") {
    const configured = hasMetaWhatsappConfiguration(normalizedConfig);
    return {
      configured,
      provider: configured ? "Numero dedicato del cliente" : "Premium da completare",
      mode: configured ? "live" : "setup"
    };
  }

  const whatsappConfigured = Boolean(
    CONFIG.twilio.accountSid && CONFIG.twilio.authToken && CONFIG.twilio.whatsappFrom
  );

  return {
    configured: whatsappConfigured,
    provider: whatsappConfigured ? "Numero condiviso piattaforma" : CONFIG.allowMockDelivery ? "Mock" : "Non configurato",
    mode: whatsappConfigured ? "live" : CONFIG.allowMockDelivery ? "mock" : "disabled"
  };
}

function hasMetaWhatsappConfiguration(config) {
  return Boolean(config && config.metaAccessTokenEncrypted && config.metaPhoneNumberId);
}

function buildBranchMessagingConfigPayload(body, actor, existingConfig) {
  const targetBranchOwner = arguments.length > 3 && arguments[3] ? arguments[3] : actor;
  const previous =
    existingConfig || getDefaultAdminChannelConfig(targetBranchOwner.id, targetBranchOwner);
  const now = new Date().toISOString();
  const mode = actor.isPlatformOwner
    ? normalizeWhatsappProviderMode(body.mode || previous.whatsappMode)
    : normalizeWhatsappProviderMode(previous.whatsappMode);
  const requestedBusinessName = String(body.businessDisplayName ?? previous.businessDisplayName ?? "")
    .trim()
    .slice(0, 80);
  const businessDisplayName = requestedBusinessName || targetBranchOwner.fullName;
  const requestedSmsSender = String(body.smsSenderId ?? previous.smsSenderId ?? "").trim();
  const smsSenderId = deriveSmsSenderId(requestedSmsSender || businessDisplayName);
  if (!businessDisplayName) {
    throw new Error("Inserisci un nome attivita per personalizzare i remind del ramo.");
  }

  const nextConfig = {
    brandOwnerUserId: targetBranchOwner.id,
    businessDisplayName,
    smsSenderId,
    whatsappMode: mode,
    metaAccessTokenEncrypted: previous.metaAccessTokenEncrypted || null,
    metaPhoneNumberId: actor.isPlatformOwner
      ? String(body.metaPhoneNumberId ?? previous.metaPhoneNumberId ?? "").trim() || null
      : previous.metaPhoneNumberId || null,
    metaWabaId: actor.isPlatformOwner
      ? String(body.metaWabaId ?? previous.metaWabaId ?? "").trim() || null
      : previous.metaWabaId || null,
    metaBusinessAccountId: actor.isPlatformOwner
      ? String(body.metaBusinessAccountId ?? previous.metaBusinessAccountId ?? "").trim() || null
      : previous.metaBusinessAccountId || null,
    metaDisplayPhoneNumber: actor.isPlatformOwner
      ? String(body.metaDisplayPhoneNumber ?? previous.metaDisplayPhoneNumber ?? "").trim() || null
      : previous.metaDisplayPhoneNumber || null,
    billingModel: normalizeBillingModel(previous.billingModel),
    walletBalance: normalizeMoney(previous.walletBalance || 0, 0),
    walletCurrency: previous.walletCurrency || DEFAULT_WALLET_CURRENCY,
    smsUnitPrice: normalizeUnitPrice(previous.smsUnitPrice, DEFAULT_SMS_UNIT_PRICE),
    whatsappUnitPrice: normalizeUnitPrice(previous.whatsappUnitPrice, DEFAULT_WHATSAPP_UNIT_PRICE),
    createdAt: previous.createdAt || now,
    updatedAt: now
  };

  const nextToken = String(body.metaAccessToken || "").trim();
  if (actor.isPlatformOwner && nextToken) {
    nextConfig.metaAccessTokenEncrypted = encryptSensitiveValue(nextToken);
  }

  return nextConfig;
}

function buildBranchBillingConfigPayload(body, targetBranchOwner, existingConfig) {
  const previous = existingConfig || getDefaultAdminChannelConfig(targetBranchOwner.id, targetBranchOwner);
  return {
    ...previous,
    brandOwnerUserId: targetBranchOwner.id,
    businessDisplayName: previous.businessDisplayName || targetBranchOwner.fullName,
    smsSenderId: previous.smsSenderId || deriveSmsSenderId(previous.businessDisplayName || targetBranchOwner.fullName),
    billingModel: normalizeBillingModel(body.billingModel || previous.billingModel),
    walletBalance: normalizeMoney(body.walletBalance, normalizeMoney(previous.walletBalance || 0, 0)),
    walletCurrency: previous.walletCurrency || DEFAULT_WALLET_CURRENCY,
    smsUnitPrice: normalizeUnitPrice(body.smsUnitPrice, normalizeUnitPrice(previous.smsUnitPrice, DEFAULT_SMS_UNIT_PRICE)),
    whatsappUnitPrice: normalizeUnitPrice(
      body.whatsappUnitPrice,
      normalizeUnitPrice(previous.whatsappUnitPrice, DEFAULT_WHATSAPP_UNIT_PRICE)
    ),
    updatedAt: new Date().toISOString()
  };
}

async function resolveBranchOwnerForSettingsRequest(actor, targetAdminId) {
  const resolvedTargetId = String(targetAdminId || "").trim();
  if (!resolvedTargetId) {
    const effectiveAdminId = actor ? getEffectiveAdminId(actor) : null;
    if (!canManageBranchDeliveryConfig(actor) || !effectiveAdminId) {
      throw new Error("Seleziona un account admin proprietario di ramo da gestire.");
    }
    const branchOwner = await findUserById(effectiveAdminId);
    if (!branchOwner || branchOwner.role !== "admin") {
      throw new Error("Admin proprietario del ramo non trovato.");
    }
    return branchOwner;
  }

  const targetUser = await findUserById(resolvedTargetId);
  if (!targetUser || targetUser.role !== "admin" || targetUser.ownerAdminId !== targetUser.id) {
    throw new Error("Seleziona un admin proprietario di ramo valido.");
  }

  if (!actor.isPlatformOwner && getEffectiveAdminId(actor) !== targetUser.id) {
    throw new Error("Non puoi gestire il profilo messaggi di un altro ramo.");
  }

  return targetUser;
}

async function validateMetaWhatsappConfig(config) {
  if (!config.metaAccessTokenEncrypted) {
    throw new Error("Inserisci un access token permanente di Meta per attivare il billing del cliente.");
  }

  if (!config.metaPhoneNumberId) {
    throw new Error("Inserisci il Phone Number ID di Meta per il canale WhatsApp del cliente.");
  }

  const response = await fetch(
    `https://graph.facebook.com/${CONFIG.meta.graphVersion}/${encodeURIComponent(
      config.metaPhoneNumberId
    )}?fields=display_phone_number,verified_name`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${decryptSensitiveValue(config.metaAccessTokenEncrypted)}`
      }
    }
  );

  const payload = await safeParseResponseJson(response);
  if (!response.ok) {
    const providerMessage =
      payload.error?.message ||
      payload.message ||
      `Connessione Meta non valida (${response.status}). Controlla token e Phone Number ID.`;
    throw new Error(
      `Meta ha rifiutato la configurazione WhatsApp del cliente: ${providerMessage}`
    );
  }

  if (!config.metaDisplayPhoneNumber && payload.display_phone_number) {
    config.metaDisplayPhoneNumber = payload.display_phone_number;
  }

  return payload;
}

function encryptSensitiveValue(value) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(CONFIG.credentialsSecret).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

function decryptSensitiveValue(value) {
  if (!value) {
    return "";
  }

  const parts = String(value).split(".");
  if (parts.length !== 3) {
    return String(value);
  }

  const [ivText, authTagText, cipherText] = parts;
  const iv = Buffer.from(ivText, "base64");
  const authTag = Buffer.from(authTagText, "base64");
  const encrypted = Buffer.from(cipherText, "base64");
  const key = crypto.createHash("sha256").update(CONFIG.credentialsSecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function prependBusinessHeader(message, businessDisplayName) {
  const normalizedBusinessName = String(businessDisplayName || "").trim();
  const normalizedMessage = String(message || "").trim();

  if (!normalizedBusinessName) {
    return normalizedMessage;
  }

  if (!normalizedMessage) {
    return normalizedBusinessName;
  }

  if (normalizedMessage.toLowerCase().startsWith(normalizedBusinessName.toLowerCase())) {
    return normalizedMessage;
  }

  return `${normalizedBusinessName}\n\n${normalizedMessage}`;
}

function buildReminderText(appointment, branchConfig) {
  const formattedDate = new Intl.DateTimeFormat("it-IT", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: CONFIG.timeZone
  }).format(new Date(appointment.startAt));

  const baseMessage = [
    "Promemoria appuntamento",
    `${appointment.clientName}, ti ricordiamo l'appuntamento "${appointment.title}"`,
    `Servizio: ${appointment.service}`,
    `Quando: ${formattedDate}`,
    appointment.location ? `Dove: ${appointment.location}` : "",
    appointment.notes ? `Note: ${appointment.notes}` : ""
  ]
    .filter(Boolean)
    .join("\n");

  const messageBody = appointment.reminderMessage || baseMessage;
  return prependBusinessHeader(messageBody, branchConfig && branchConfig.businessDisplayName);
}

function channelUsesWallet(channel) {
  return channel === "sms" || channel === "whatsapp";
}

function getWalletUnitPriceForChannel(branchConfig, channel) {
  if (channel === "sms") {
    return normalizeUnitPrice(branchConfig?.smsUnitPrice, DEFAULT_SMS_UNIT_PRICE);
  }

  if (channel === "whatsapp") {
    return normalizeUnitPrice(branchConfig?.whatsappUnitPrice, DEFAULT_WHATSAPP_UNIT_PRICE);
  }

  return 0;
}

async function reserveWalletChargeForDelivery(appointment, channel, deliveryContext) {
  const branchConfig = deliveryContext?.branchConfig;
  const branchOwner = deliveryContext?.branchOwner;
  if (!branchConfig || !branchOwner) {
    return null;
  }

  if (normalizeBillingModel(branchConfig.billingModel) !== "wallet" || !channelUsesWallet(channel)) {
    return null;
  }

  const amount = roundCurrency(getWalletUnitPriceForChannel(branchConfig, channel));
  if (amount <= 0) {
    return null;
  }

  const result = await applyWalletTransaction({
    brandOwnerUserId: branchOwner.id,
    amountDelta: -amount,
    currency: branchConfig.walletCurrency || DEFAULT_WALLET_CURRENCY,
    type: "reminder_debit",
    channel,
    description: `Addebito remind ${channel.toUpperCase()} per ${appointment.clientName}`,
    createdByUserId: appointment.createdByUserId || branchOwner.id,
    appointmentId: appointment.id,
    metadata: {
      appointment_title: appointment.title,
      reservation: true
    }
  });

  return {
    amount,
    currency: branchConfig.walletCurrency || DEFAULT_WALLET_CURRENCY,
    transactionId: result.transactionId
  };
}

async function refundWalletChargeReservation(appointment, channel, deliveryContext, reservation, reason) {
  if (!reservation || !deliveryContext?.branchOwner) {
    return null;
  }

  return applyWalletTransaction({
    brandOwnerUserId: deliveryContext.branchOwner.id,
    amountDelta: reservation.amount,
    currency: reservation.currency || DEFAULT_WALLET_CURRENCY,
    type: "reminder_refund",
    channel,
    description: `Rimborso remind ${channel.toUpperCase()} non inviato`,
    createdByUserId: appointment.createdByUserId || deliveryContext.branchOwner.id,
    appointmentId: appointment.id,
    metadata: {
      reason: reason || "send_failed",
      reservation_transaction_id: reservation.transactionId || null
    }
  });
}

async function processDueReminders() {
  if (reminderLoopBusy) {
    return;
  }

  reminderLoopBusy = true;

  try {
    const appointments = await listAppointments();
    const dueAppointments = appointments.filter((appointment) => isReminderDue(appointment, Date.now()));

    for (const appointment of dueAppointments) {
      const results = await dispatchReminderForAppointment(appointment, { forceAllChannels: false });
      const merged = mergeReminderResults(appointment, results);
      await updateAppointmentRecord(appointment.id, merged);
    }
  } finally {
    reminderLoopBusy = false;
  }
}

async function dispatchReminderForAppointment(appointment, options) {
  const forceAllChannels = Boolean(options && options.forceAllChannels);
  const channels = forceAllChannels
    ? [...appointment.reminderChannels]
    : getPendingReminderChannels(appointment);

  const results = [];
  const deliveryContext = await resolveBranchMessagingContextForAppointment(appointment);
  const message = buildReminderText(appointment, deliveryContext.branchConfig);
  const subject = `Promemoria appuntamento: ${appointment.title}`;

  for (const channel of channels) {
    try {
      const deliveryResult = await sendNotificationChannel(
        channel,
        appointment,
        subject,
        message,
        deliveryContext
      );
      results.push({
        channel,
        status: "sent",
        provider: deliveryResult.provider,
        mode: deliveryResult.mode,
        messageId: deliveryResult.messageId || null,
        attemptedAt: new Date().toISOString()
      });
    } catch (error) {
      results.push({
        channel,
        status: "failed",
        provider: "n/a",
        mode: "failed",
        messageId: null,
        error: error.message,
        attemptedAt: new Date().toISOString()
      });
    }
  }

  return results;
}

function mergeReminderResults(appointment, results) {
  const state = normalizeReminderState(appointment.reminderState, appointment.reminderVersion);
  const logs = Array.isArray(appointment.reminderLogs) ? [...appointment.reminderLogs] : [];
  const sentChannels = new Set(state.sentChannels);
  const failedChannels = new Set(state.failedChannels);
  const lastErrorByChannel = { ...state.lastErrorByChannel };
  const attemptedAt = new Date().toISOString();

  for (const result of results) {
    logs.unshift(result);
    if (result.status === "sent") {
      sentChannels.add(result.channel);
      failedChannels.delete(result.channel);
      delete lastErrorByChannel[result.channel];
    } else {
      failedChannels.add(result.channel);
      lastErrorByChannel[result.channel] = result.error || "Errore sconosciuto";
    }
  }

  return {
    ...appointment,
    reminderState: {
      version: appointment.reminderVersion,
      sentChannels: [...sentChannels],
      failedChannels: [...failedChannels],
      lastAttemptAt: attemptedAt,
      lastErrorByChannel
    },
    reminderLogs: logs.slice(0, 30),
    updatedAt: attemptedAt
  };
}

async function sendNotificationChannel(channel, appointment, subject, message, deliveryContext) {
  if (channel === "email") {
    if (CONFIG.email.apiKey && CONFIG.email.from) {
      return sendEmailNotification(appointment.clientEmail, subject, message);
    }
    return sendMockNotification("email", appointment.clientEmail, message);
  }

  if (channel === "sms") {
    const smsDelivery = await resolveSmsDeliveryConfigForAppointment(appointment, deliveryContext);
    const walletReservation =
      smsDelivery.kind === "mock"
        ? null
        : await reserveWalletChargeForDelivery(appointment, channel, deliveryContext);
    try {
      if (smsDelivery.kind === "twilio") {
        return await sendTwilioMessage({
          to: appointment.clientPhone,
          from: smsDelivery.from,
          body: message
        });
      }

      if (smsDelivery.kind === "mock") {
        return await sendMockNotification("sms", appointment.clientPhone, message);
      }
    } catch (error) {
      await refundWalletChargeReservation(appointment, channel, deliveryContext, walletReservation, error.message);
      throw error;
    }

    throw new Error(smsDelivery.error || "Canale SMS non configurato");
  }

  if (channel === "whatsapp") {
    const whatsappDelivery = await resolveWhatsappDeliveryConfigForAppointment(
      appointment,
      deliveryContext
    );
    const walletReservation =
      whatsappDelivery.kind === "mock"
        ? null
        : await reserveWalletChargeForDelivery(appointment, channel, deliveryContext);
    try {
      if (whatsappDelivery.kind === "meta_cloud") {
        return await sendMetaWhatsappMessage({
          accessToken: whatsappDelivery.accessToken,
          phoneNumberId: whatsappDelivery.phoneNumberId,
          to: appointment.clientPhone,
          body: message
        });
      }

      if (whatsappDelivery.kind === "system_twilio") {
        return await sendTwilioMessage({
          to: ensureWhatsappPrefix(appointment.clientPhone),
          from: ensureWhatsappPrefix(whatsappDelivery.from),
          body: message
        });
      }

      if (whatsappDelivery.kind === "mock") {
        return await sendMockNotification("whatsapp", appointment.clientPhone, message);
      }
    } catch (error) {
      await refundWalletChargeReservation(appointment, channel, deliveryContext, walletReservation, error.message);
      throw error;
    }

    throw new Error(whatsappDelivery.error || "Canale WhatsApp non configurato");
  }

  throw new Error("Canale reminder non supportato");
}

async function resolveBranchMessagingContextForAppointment(appointment) {
  const assignedUser = await findUserById(appointment.assignedUserId);
  if (!assignedUser) {
    return {
      assignedUser: null,
      branchOwner: null,
      rawConfig: getDefaultAdminChannelConfig(null, null),
      branchConfig: sanitizeAdminChannelConfig(getDefaultAdminChannelConfig(null, null), null, null),
      error: "Utente assegnato non trovato"
    };
  }

  const effectiveAdminId = getEffectiveAdminId(assignedUser);
  const branchOwner = effectiveAdminId ? await findUserById(effectiveAdminId) : null;
  const rawConfig = effectiveAdminId
    ? await findAdminChannelConfigByBrandOwnerId(effectiveAdminId)
    : getDefaultAdminChannelConfig(null, null);
  const branchConfig = sanitizeAdminChannelConfig(rawConfig, null, branchOwner);

  return {
    assignedUser,
    branchOwner,
    rawConfig,
    branchConfig
  };
}

async function resolveSmsDeliveryConfigForAppointment(appointment, deliveryContext) {
  const context = deliveryContext || (await resolveBranchMessagingContextForAppointment(appointment));
  const branchConfig = context.branchConfig || getDefaultAdminChannelConfig(null, null);
  const twilioReady = Boolean(
    CONFIG.twilio.accountSid &&
      CONFIG.twilio.authToken &&
      (CONFIG.twilio.smsFrom || branchConfig.smsSenderId)
  );

  if (twilioReady) {
    const preferredSender =
      supportsAlphanumericSmsSender(appointment.clientPhone) && branchConfig.smsSenderId
        ? branchConfig.smsSenderId
        : CONFIG.twilio.smsFrom;

    if (preferredSender) {
      return {
        kind: "twilio",
        from: preferredSender
      };
    }
  }

  if (CONFIG.allowMockDelivery) {
    return {
      kind: "mock"
    };
  }

  return {
    kind: "error",
    error: "Canale SMS non configurato"
  };
}

async function sendMockNotification(channel, destination, message) {
  if (!CONFIG.allowMockDelivery) {
    throw new Error(`Canale ${channel} non configurato`);
  }

  console.log(`[mock:${channel}] ${destination} -> ${message}`);
  return {
    provider: "Mock",
    mode: "mock",
    messageId: `mock_${crypto.randomUUID()}`
  };
}

async function sendEmailNotification(to, subject, text) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.email.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: CONFIG.email.from,
      to: [to],
      subject,
      text
    })
  });

  const payload = await safeParseResponseJson(response);
  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Email non inviata (${response.status})`);
  }

  return {
    provider: "Resend",
    mode: "live",
    messageId: payload.id || null
  };
}

async function sendTwilioMessage({ to, from, body }) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    CONFIG.twilio.accountSid
  )}/Messages.json`;
  const authHeader = Buffer.from(
    `${CONFIG.twilio.accountSid}:${CONFIG.twilio.authToken}`
  ).toString("base64");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      To: to,
      From: from,
      Body: body
    }).toString()
  });

  const payload = await safeParseResponseJson(response);
  if (!response.ok) {
    throw new Error(payload.message || `Messaggio non inviato (${response.status})`);
  }

  return {
    provider: "Twilio",
    mode: "live",
    messageId: payload.sid || null
  };
}

async function resolveWhatsappDeliveryConfigForAppointment(appointment, deliveryContext) {
  const context = deliveryContext || (await resolveBranchMessagingContextForAppointment(appointment));
  const assignedUser = context.assignedUser;
  if (!assignedUser) {
    return {
      kind: "error",
      error: "Utente assegnato non trovato per il reminder WhatsApp"
    };
  }

  const branchConfig = context.rawConfig || getDefaultAdminChannelConfig(null, null);

  if (branchConfig.whatsappMode === "meta_cloud") {
    if (!hasMetaWhatsappConfiguration(branchConfig)) {
      return {
        kind: "error",
        error:
          "Il ramo admin assegnato usa WhatsApp del cliente, ma la configurazione Meta Cloud non e ancora completa"
      };
    }

    return {
      kind: "meta_cloud",
      accessToken: decryptSensitiveValue(branchConfig.metaAccessTokenEncrypted),
      phoneNumberId: branchConfig.metaPhoneNumberId
    };
  }

  if (CONFIG.twilio.accountSid && CONFIG.twilio.authToken && CONFIG.twilio.whatsappFrom) {
    return {
      kind: "system_twilio",
      from: CONFIG.twilio.whatsappFrom
    };
  }

  if (CONFIG.allowMockDelivery) {
    return {
      kind: "mock"
    };
  }

  return {
    kind: "error",
    error: "Canale WhatsApp non configurato"
  };
}

async function sendMetaWhatsappMessage({ accessToken, phoneNumberId, to, body }) {
  const endpoint = `https://graph.facebook.com/${CONFIG.meta.graphVersion}/${encodeURIComponent(
    phoneNumberId
  )}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: normalizePhoneForMeta(to),
      type: "text",
      text: {
        preview_url: false,
        body
      }
    })
  });

  const payload = await safeParseResponseJson(response);
  if (!response.ok) {
    throw new Error(
      payload.error?.message || payload.message || `Messaggio WhatsApp Meta non inviato (${response.status})`
    );
  }

  return {
    provider: "Meta Cloud API",
    mode: "live",
    messageId: payload.messages && payload.messages[0] ? payload.messages[0].id || null : null
  };
}

async function safeParseResponseJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return {};
  }
}

function ensureWhatsappPrefix(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return trimmed;
  }
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

function normalizePhoneForMeta(value) {
  return String(value || "")
    .trim()
    .replace(/^whatsapp:/i, "")
    .replace(/[^\d]/g, "");
}

async function serveStatic(req, res, url) {
  if (!["GET", "HEAD"].includes(req.method)) {
    return sendJson(res, 405, { error: "Metodo non consentito" });
  }

  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const safePath = path.resolve(PUBLIC_DIR, relativePath);

  if (!safePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "Accesso negato" });
  }

  if (!fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    return sendJson(res, 404, { error: "File non trovato" });
  }

  const extension = path.extname(safePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream"
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(safePath).pipe(res);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(body);
}

function buildQuery(params) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    searchParams.set(key, value);
  }
  return searchParams.toString();
}

async function supabaseRequest({
  method = "GET",
  table,
  query = "",
  body,
  single = false,
  returnRows = false,
  prefer = []
}) {
  const headers = {
    apikey: CONFIG.supabaseKey,
    Authorization: `Bearer ${CONFIG.supabaseKey}`,
    Accept: single ? "application/vnd.pgrst.object+json" : "application/json"
  };

  if (["GET", "HEAD"].includes(method)) {
    headers["Accept-Profile"] = CONFIG.supabaseSchema;
  } else {
    headers["Content-Profile"] = CONFIG.supabaseSchema;
    headers["Content-Type"] = "application/json";
  }

  const preferValues = Array.isArray(prefer) ? [...prefer] : prefer ? [String(prefer)] : [];
  if (returnRows) {
    preferValues.push("return=representation");
  }

  if (preferValues.length) {
    headers.Prefer = preferValues.join(",");
  }

  const response = await fetch(`${SUPABASE_REST_URL}/${table}${query ? `?${query}` : ""}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new Error(extractSupabaseError(payload, response.status));
  }

  return payload;
}

async function supabaseRpc(functionName, args) {
  const response = await fetch(`${SUPABASE_REST_URL}/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: CONFIG.supabaseKey,
      Authorization: `Bearer ${CONFIG.supabaseKey}`,
      "Content-Profile": CONFIG.supabaseSchema,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify(args || {})
  });

  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new Error(extractSupabaseError(payload, response.status));
  }

  return payload;
}

function extractSupabaseError(payload, status) {
  if (payload && typeof payload === "object") {
    return payload.message || payload.error || `Errore Supabase (${status})`;
  }
  return `Errore Supabase (${status})`;
}

async function listUsers(options = {}) {
  const select = options.includeSecrets
    ? "id,username,full_name,role,is_platform_owner,created_by_user_id,owner_admin_id,logo_data_url,password_hash,password_salt,created_at,updated_at"
    : "id,username,full_name,role,is_platform_owner,created_by_user_id,owner_admin_id,logo_data_url,created_at,updated_at";

  const rows = await supabaseRequest({
    table: CONFIG.usersTable,
    query: buildQuery({
      select,
      order: "created_at.asc",
      limit: options.limit
    })
  });

  return Array.isArray(rows) ? rows.map(userFromRow) : [];
}

async function findUserByUsername(username) {
  const rows = await supabaseRequest({
    table: CONFIG.usersTable,
    query: buildQuery({
      select:
        "id,username,full_name,role,is_platform_owner,created_by_user_id,owner_admin_id,logo_data_url,password_hash,password_salt,created_at,updated_at",
      username: `eq.${username}`,
      limit: 1
    })
  });

  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  return userFromRow(rows[0]);
}

async function findUserById(userId) {
  const rows = await supabaseRequest({
    table: CONFIG.usersTable,
    query: buildQuery({
      select:
        "id,username,full_name,role,is_platform_owner,created_by_user_id,owner_admin_id,logo_data_url,password_hash,password_salt,created_at,updated_at",
      id: `eq.${userId}`,
      limit: 1
    })
  });

  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  return userFromRow(rows[0]);
}

async function createUserRecord(user) {
  const rows = await supabaseRequest({
    method: "POST",
    table: CONFIG.usersTable,
    body: userToRow(user),
    returnRows: true
  });

  return userFromRow(Array.isArray(rows) ? rows[0] : rows);
}

async function updateUserRecord(userId, user) {
  const rows = await supabaseRequest({
    method: "PATCH",
    table: CONFIG.usersTable,
    query: buildQuery({
      id: `eq.${userId}`
    }),
    body: userToRow(user),
    returnRows: true
  });

  return userFromRow(Array.isArray(rows) ? rows[0] : rows);
}

async function deleteUserRecord(userId) {
  await supabaseRequest({
    method: "DELETE",
    table: CONFIG.usersTable,
    query: buildQuery({
      id: `eq.${userId}`
    })
  });
}

async function findAdminChannelConfigByBrandOwnerId(brandOwnerUserId) {
  if (!brandOwnerUserId) {
    return getDefaultAdminChannelConfig(null);
  }

  const rows = await supabaseRequest({
    table: CONFIG.adminChannelConfigsTable,
    query: buildQuery({
      select: "*",
      brand_owner_user_id: `eq.${brandOwnerUserId}`,
      limit: 1
    })
  });

  if (!Array.isArray(rows) || !rows.length) {
    return getDefaultAdminChannelConfig(brandOwnerUserId);
  }

  return adminChannelConfigFromRow(rows[0]);
}

async function upsertAdminChannelConfig(config) {
  const rows = await supabaseRequest({
    method: "POST",
    table: CONFIG.adminChannelConfigsTable,
    query: buildQuery({
      on_conflict: "brand_owner_user_id"
    }),
    body: adminChannelConfigToRow(config),
    returnRows: true,
    prefer: ["resolution=merge-duplicates"]
  });

  return adminChannelConfigFromRow(Array.isArray(rows) ? rows[0] : rows);
}

async function listWalletTransactionsByBrandOwnerId(brandOwnerUserId, limit = 12) {
  if (!brandOwnerUserId) {
    return [];
  }

  const rows = await supabaseRequest({
    table: CONFIG.walletTransactionsTable,
    query: buildQuery({
      select: "*",
      brand_owner_user_id: `eq.${brandOwnerUserId}`,
      order: "created_at.desc",
      limit
    })
  });

  return Array.isArray(rows) ? rows.map(walletTransactionFromRow) : [];
}

async function findWalletTransactionByStripeSessionId(sessionId) {
  if (!sessionId) {
    return null;
  }

  const rows = await supabaseRequest({
    table: CONFIG.walletTransactionsTable,
    query: buildQuery({
      select: "*",
      stripe_checkout_session_id: `eq.${sessionId}`,
      limit: 1
    })
  });

  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  return walletTransactionFromRow(rows[0]);
}

async function applyWalletTransaction(payload) {
  const response = await supabaseRpc("apply_wallet_transaction", {
    p_brand_owner_user_id: payload.brandOwnerUserId,
    p_amount_delta: roundCurrency(payload.amountDelta),
    p_currency: payload.currency || DEFAULT_WALLET_CURRENCY,
    p_type: payload.type,
    p_channel: payload.channel || null,
    p_description: payload.description || null,
    p_created_by_user_id: payload.createdByUserId || null,
    p_appointment_id: payload.appointmentId || null,
    p_metadata: payload.metadata || {},
    p_stripe_checkout_session_id: payload.stripeCheckoutSessionId || null,
    p_stripe_payment_intent_id: payload.stripePaymentIntentId || null,
    p_allow_negative: Boolean(payload.allowNegative)
  });

  const result = Array.isArray(response) ? response[0] : response;
  if (!result) {
    throw new Error("Risposta wallet non valida");
  }

  return {
    applied: Boolean(result.applied),
    walletBalance: roundCurrency(result.wallet_balance || 0),
    transactionId: result.transaction_id || null
  };
}

async function buildBranchBillingPayload(actor, targetBranchOwner, config) {
  const branchConfig = sanitizeAdminChannelConfig(config, null, targetBranchOwner);
  const transactions = await listWalletTransactionsByBrandOwnerId(targetBranchOwner?.id, 12);

  return {
    brandOwnerUserId: targetBranchOwner ? targetBranchOwner.id : null,
    branchOwnerName: targetBranchOwner ? targetBranchOwner.fullName : null,
    billingModel: branchConfig.billingModel,
    walletBalance: branchConfig.walletBalance,
    walletCurrency: branchConfig.walletCurrency,
    smsUnitPrice: branchConfig.smsUnitPrice,
    whatsappUnitPrice: branchConfig.whatsappUnitPrice,
    stripeReady: isStripeConfigured(),
    topUpOptions: CONFIG.stripe.topUpOptions,
    minimumTopUp: roundCurrency(CONFIG.stripe.minimumTopUp),
    maximumTopUp: roundCurrency(CONFIG.stripe.maximumTopUp),
    canManageBilling: Boolean(actor && actor.isPlatformOwner),
    canTopUp: Boolean(actor && actor.role === "admin"),
    transactions
  };
}

function normalizeTopUpAmount(value) {
  const amount = normalizeMoney(value, NaN);
  if (!Number.isFinite(amount)) {
    throw new Error("Inserisci un importo valido per la ricarica.");
  }

  if (amount < CONFIG.stripe.minimumTopUp) {
    throw new Error(`La ricarica minima e ${formatMoney(CONFIG.stripe.minimumTopUp)}.`);
  }

  if (amount > CONFIG.stripe.maximumTopUp) {
    throw new Error(`La ricarica massima e ${formatMoney(CONFIG.stripe.maximumTopUp)}.`);
  }

  return amount;
}

async function createStripeTopUpSession(req, actor, targetBranchOwner, amount) {
  if (!CONFIG.stripe.secretKey) {
    throw new Error("Stripe non configurato. Inserisci STRIPE_SECRET_KEY.");
  }

  const amountCents = moneyToCents(amount);
  const origin = getRequestOrigin(req);
  const currency = CONFIG.stripe.currency;
  const branchName = targetBranchOwner?.fullName || "Ramo admin";
  const successUrl = `${origin}/?wallet=success`;
  const cancelUrl = `${origin}/?wallet=cancel`;
  const stripe = getStripeClient();

  return stripe.checkout.sessions.create({
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: targetBranchOwner.id,
    metadata: {
      kind: "wallet_top_up",
      brand_owner_user_id: targetBranchOwner.id,
      created_by_user_id: actor.id,
      amount_cents: String(amountCents),
      currency: currency.toUpperCase()
    },
    payment_intent_data: {
      metadata: {
        kind: "wallet_top_up",
        brand_owner_user_id: targetBranchOwner.id,
        created_by_user_id: actor.id
      }
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: `Ricarica wallet remind - ${branchName}`
          }
        }
      }
    ]
  });
}

async function handleStripeWebhookEvent(event) {
  if (!event || event.type !== "checkout.session.completed") {
    return;
  }

  const session = event.data && event.data.object ? event.data.object : null;
  if (!session || session.mode !== "payment" || session.payment_status !== "paid") {
    return;
  }

  if (session.metadata?.kind !== "wallet_top_up") {
    return;
  }

  const brandOwnerUserId = String(session.metadata.brand_owner_user_id || "").trim();
  if (!brandOwnerUserId) {
    throw new Error("Sessione Stripe senza brand_owner_user_id.");
  }

  const amount = centsToMoney(session.amount_total || session.metadata.amount_cents || 0);
  if (amount <= 0) {
    throw new Error("Importo Stripe non valido per la ricarica wallet.");
  }

  await applyWalletTransaction({
    brandOwnerUserId,
    amountDelta: amount,
    currency: String(session.currency || session.metadata.currency || DEFAULT_WALLET_CURRENCY).toUpperCase(),
    type: "top_up",
    description: `Ricarica wallet via Stripe (${formatMoney(amount)})`,
    createdByUserId: session.metadata.created_by_user_id || null,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
    metadata: {
      source: "stripe_checkout",
      session_status: session.status || "complete"
    }
  });
}

async function userHasDependents(userId) {
  const rows = await supabaseRequest({
    table: CONFIG.usersTable,
    query: buildQuery({
      select: "id",
      created_by_user_id: `eq.${userId}`,
      id: `neq.${userId}`,
      limit: 1
    })
  });

  return Array.isArray(rows) && rows.length > 0;
}

async function userHasAppointments(userId) {
  const rows = await supabaseRequest({
    table: CONFIG.appointmentsTable,
    query: buildQuery({
      select: "id",
      or: `(assigned_user_id.eq.${userId},created_by_user_id.eq.${userId})`,
      limit: 1
    })
  });

  return Array.isArray(rows) && rows.length > 0;
}

async function listAppointments() {
  const rows = await supabaseRequest({
    table: CONFIG.appointmentsTable,
    query: buildQuery({
      select: "*",
      order: "start_at.asc"
    })
  });

  return Array.isArray(rows) ? rows.map(appointmentFromRow) : [];
}

async function findAppointmentById(appointmentId) {
  const rows = await supabaseRequest({
    table: CONFIG.appointmentsTable,
    query: buildQuery({
      select: "*",
      id: `eq.${appointmentId}`,
      limit: 1
    })
  });

  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }

  return appointmentFromRow(rows[0]);
}

async function createAppointmentRecord(appointment) {
  const rows = await supabaseRequest({
    method: "POST",
    table: CONFIG.appointmentsTable,
    body: appointmentToRow(appointment),
    returnRows: true
  });

  return appointmentFromRow(Array.isArray(rows) ? rows[0] : rows);
}

async function updateAppointmentRecord(appointmentId, appointment) {
  const rows = await supabaseRequest({
    method: "PATCH",
    table: CONFIG.appointmentsTable,
    query: buildQuery({
      id: `eq.${appointmentId}`
    }),
    body: appointmentToRow(appointment),
    returnRows: true
  });

  return appointmentFromRow(Array.isArray(rows) ? rows[0] : rows);
}

async function deleteAppointmentRecord(appointmentId) {
  await supabaseRequest({
    method: "DELETE",
    table: CONFIG.appointmentsTable,
    query: buildQuery({
      id: `eq.${appointmentId}`
    })
  });
}

function userFromRow(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    isPlatformOwner: Boolean(row.is_platform_owner),
    createdByUserId: row.created_by_user_id || null,
    ownerAdminId: row.owner_admin_id || null,
    logoDataUrl: row.logo_data_url || null,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function userToRow(user) {
  return {
    id: user.id,
    username: user.username,
    full_name: user.fullName,
    role: user.role,
    is_platform_owner: Boolean(user.isPlatformOwner),
    created_by_user_id: user.createdByUserId || null,
    owner_admin_id: user.ownerAdminId || null,
    logo_data_url: user.logoDataUrl || null,
    password_hash: user.passwordHash,
    password_salt: user.passwordSalt,
    created_at: user.createdAt,
    updated_at: user.updatedAt
  };
}

function adminChannelConfigFromRow(row) {
  return {
    brandOwnerUserId: row.brand_owner_user_id,
    businessDisplayName: row.business_display_name || "",
    smsSenderId: row.sms_sender_id || "",
    whatsappMode: normalizeWhatsappProviderMode(row.whatsapp_mode),
    metaAccessTokenEncrypted: row.meta_access_token_encrypted || null,
    metaPhoneNumberId: row.meta_phone_number_id || null,
    metaWabaId: row.meta_waba_id || null,
    metaBusinessAccountId: row.meta_business_account_id || null,
    metaDisplayPhoneNumber: row.meta_display_phone_number || null,
    billingModel: normalizeBillingModel(row.billing_model),
    walletBalance: normalizeMoney(row.wallet_balance || 0, 0),
    walletCurrency: row.wallet_currency || DEFAULT_WALLET_CURRENCY,
    smsUnitPrice: normalizeUnitPrice(row.sms_unit_price, DEFAULT_SMS_UNIT_PRICE),
    whatsappUnitPrice: normalizeUnitPrice(row.whatsapp_unit_price, DEFAULT_WHATSAPP_UNIT_PRICE),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function adminChannelConfigToRow(config) {
  return {
    brand_owner_user_id: config.brandOwnerUserId,
    business_display_name: nullableString(config.businessDisplayName),
    sms_sender_id: nullableString(config.smsSenderId),
    whatsapp_mode: normalizeWhatsappProviderMode(config.whatsappMode),
    meta_access_token_encrypted: config.metaAccessTokenEncrypted || null,
    meta_phone_number_id: config.metaPhoneNumberId || null,
    meta_waba_id: config.metaWabaId || null,
    meta_business_account_id: config.metaBusinessAccountId || null,
    meta_display_phone_number: config.metaDisplayPhoneNumber || null,
    billing_model: normalizeBillingModel(config.billingModel),
    wallet_balance: normalizeMoney(config.walletBalance || 0, 0),
    wallet_currency: config.walletCurrency || DEFAULT_WALLET_CURRENCY,
    sms_unit_price: normalizeUnitPrice(config.smsUnitPrice, DEFAULT_SMS_UNIT_PRICE),
    whatsapp_unit_price: normalizeUnitPrice(
      config.whatsappUnitPrice,
      DEFAULT_WHATSAPP_UNIT_PRICE
    ),
    created_at: config.createdAt,
    updated_at: config.updatedAt
  };
}

function walletTransactionFromRow(row) {
  return {
    id: row.id,
    brandOwnerUserId: row.brand_owner_user_id,
    appointmentId: row.appointment_id || null,
    createdByUserId: row.created_by_user_id || null,
    type: row.type,
    channel: row.channel || null,
    amountDelta: roundCurrency(row.amount_delta || 0),
    currency: row.currency || DEFAULT_WALLET_CURRENCY,
    description: row.description || "",
    stripeCheckoutSessionId: row.stripe_checkout_session_id || null,
    stripePaymentIntentId: row.stripe_payment_intent_id || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at
  };
}

function appointmentFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    service: row.service,
    description: row.description || "",
    clientName: row.client_name,
    clientEmail: row.client_email || "",
    clientPhone: row.client_phone || "",
    location: row.location || "",
    notes: row.notes || "",
    startAt: row.start_at,
    endAt: row.end_at || "",
    status: row.status,
    assignedUserId: row.assigned_user_id,
    reminderEnabled: Boolean(row.reminder_enabled),
    reminderMinutesBefore: Number(row.reminder_minutes_before || 0),
    reminderChannels: Array.isArray(row.reminder_channels) ? row.reminder_channels : [],
    reminderMessage: row.reminder_message || "",
    createdByUserId: row.created_by_user_id,
    reminderFingerprint: row.reminder_fingerprint || "",
    reminderVersion: row.reminder_version || crypto.randomUUID(),
    reminderState: normalizeReminderState(row.reminder_state, row.reminder_version),
    reminderLogs: Array.isArray(row.reminder_logs) ? row.reminder_logs : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function appointmentToRow(appointment) {
  return {
    id: appointment.id,
    title: appointment.title,
    service: appointment.service,
    description: nullableString(appointment.description),
    client_name: appointment.clientName,
    client_email: nullableString(appointment.clientEmail),
    client_phone: nullableString(appointment.clientPhone),
    location: nullableString(appointment.location),
    notes: nullableString(appointment.notes),
    start_at: appointment.startAt,
    end_at: nullableString(appointment.endAt),
    status: appointment.status,
    assigned_user_id: appointment.assignedUserId,
    reminder_enabled: appointment.reminderEnabled,
    reminder_minutes_before: appointment.reminderMinutesBefore,
    reminder_channels: appointment.reminderChannels,
    reminder_message: nullableString(appointment.reminderMessage),
    created_by_user_id: appointment.createdByUserId,
    reminder_fingerprint: appointment.reminderFingerprint,
    reminder_version: appointment.reminderVersion,
    reminder_state: appointment.reminderState,
    reminder_logs: appointment.reminderLogs,
    created_at: appointment.createdAt,
    updated_at: appointment.updatedAt
  };
}

function nullableString(value) {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}
