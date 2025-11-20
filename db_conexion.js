// src/index.js (o donde tengas este backend)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────
// PostgreSQL
// ─────────────────────────────
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

// ID especial para guardar el token de agencia en auth_db
const AGENCY_ROW_ID = "__AGENCY__";

// ─────────────────────────────
// Helpers BD
// ─────────────────────────────
async function saveTokens(locationId, tokenData) {
  console.log("👉 Guardando en BD. locationId:", locationId);
  const sql = `
    INSERT INTO auth_db (locationid, raw_token)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (locationid) DO UPDATE
    SET raw_token = EXCLUDED.raw_token
  `;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
  return locationId;
}

async function getTokens(locationId) {
  const result = await pool.query(
    "SELECT raw_token FROM auth_db WHERE locationid = $1",
    [locationId]
  );
  return result.rows[0]?.raw_token || null;
}

// ─────────────────────────────
// OAuth CALLBACK (Agencia)
// ─────────────────────────────
// Aquí intercambiamos code -> ACCESS TOKEN de AGENCY (Company)
// y lo guardamos en la fila especial "__AGENCY__"
app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Falta el parámetro 'code' en la URL de callback.");
  }

  try {
    const body = new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      user_type: "Company", // token de AGENCIA
      redirect_uri: process.env.OAUTH_REDIRECT_URI,
    });

    const tokenRes = await axios.post(
      "https://services.leadconnectorhq.com/oauth/token",
      body.toString(),
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      }
    );

    const tokens = tokenRes.data;
    console.log("🔐 Tokens Agency recibidos (resumido):", {
      userType: tokens.userType,
      companyId: tokens.companyId,
      scopes: tokens.scope,
    });

    if (tokens.userType !== "Company") {
      console.warn("⚠️ El token devuelto no es de tipo Company. userType:", tokens.userType);
    }

    // Guardamos SIEMPRE el token de agencia en una fila fija
    await saveTokens(AGENCY_ROW_ID, tokens);

    return res.send(
      "¡App instalada correctamente a nivel agencia! Ya podemos manejar instalaciones de subcuentas vía webhook."
    );
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("Error en /oauth/callback:", status, data);
    return res.status(status).json({ ok: false, error: data });
  }
});

// ─────────────────────────────
// Webhook de APP (INSTALL / UNINSTALL / etc.)
// Configura esta URL en el Marketplace de tu App
// ─────────────────────────────
app.post("/ghl/app-webhook", async (req, res) => {
  try {
    const event = req.body;
    console.log("🔔 App Webhook recibido:", JSON.stringify(event, null, 2));
    
    const { type, installType, locationId, companyId } = event;
    
    // Solo nos interesa INSTALL de tipo Location
    console.log("Se ejecuto este endpoint!!!", event)
    if (type !== "INSTALL" || installType !== "Location") {
      console.log("ℹ️ Evento no manejado (tipo distinto de INSTALL/Location).");
      return res.status(200).json({ ignored: true });
    }

    if (!locationId || !companyId) {
      console.warn("⚠️ Webhook INSTALL sin locationId o companyId, se ignora.");
      return res.status(200).json({ ignored: true });
    }

    // 1) Recuperar el token de Agencia desde la BD
    const agencyTokens = await getTokens(AGENCY_ROW_ID);
    if (!agencyTokens || !agencyTokens.access_token) {
      console.error("❌ No hay tokens de agencia guardados en BD (fila __AGENCY__).");
      return res.status(200).json({ ok: false, reason: "no_agency_token" });
    }

    // 2) Pedir token de Location usando /oauth/locationToken
    try {
      const locBody = new URLSearchParams({
        companyId,
        locationId,
      });

      const locTokenRes = await axios.post(
        "https://services.leadconnectorhq.com/oauth/locationToken",
        locBody.toString(),
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Bearer ${agencyTokens.access_token}`,
            Version: "2021-07-28",
          },
          timeout: 15000,
        }
      );

      const locationTokens = locTokenRes.data; // userType: "Location"
      console.log("🔑 Tokens Location obtenidos para:", locationId);

      // 3) Guardar combinando agencyTokens + locationAccess
      await saveTokens(locationId, {
        ...agencyTokens,
        locationAccess: locationTokens,
      });

      // 4) Crear Custom Menu SOLO para esta Location
      try {
        const bodyMenu = {
          title: "WhatsApp - Clic&App",
          url: process.env.CUSTOM_MENU_URL_WA || "https://wa.clicandapp.com/",
          icon: { name: "yin-yang", fontFamily: "fab" },

          showOnCompany: false,
          showOnLocation: true,

          showToAllLocations: false,
          locations: [locationId],

          openMode: "iframe",
          userRole: "all",
          allowCamera: false,
          allowMicrophone: false,
        };

        const createMenuRes = await axios.post(
          "https://services.leadconnectorhq.com/custom-menus/",
          bodyMenu,
          {
            headers: {
              Authorization: `Bearer ${agencyTokens.access_token}`,
              Version: "2021-07-28",
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            timeout: 15000,
          }
        );

        console.log("✅ Custom Menu creado para location:", locationId, createMenuRes.data);
      } catch (e) {
        console.error(
          "❌ Error creando Custom Menu en webhook INSTALL:",
          e.response?.status,
          e.response?.data || e.message
        );
      }

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error(
        "❌ Error obteniendo token de Location en webhook INSTALL:",
        e.response?.status,
        e.response?.data || e.message
      );
      return res.status(200).json({ ok: false, error: "location_token_failed" });
    }
  } catch (e) {
    console.error("❌ Error general en /ghl/app-webhook:", e);
    return res.status(500).json({ error: "Error interno en app webhook" });
  }
});

// ─────────────────────────────
// Rutas de debug / health
// ─────────────────────────────
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ ok: true, dbTime: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/auth_db", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM auth_db");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/insert_auth", async (req, res) => {
  const { locationid, tokenres } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO auth_db (locationid, raw_token) VALUES ($1, $2::jsonb) RETURNING *",
      [locationid, JSON.stringify(tokenres)]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────
// Arranque servidor
// ─────────────────────────────
const port = Number(process.env.PORT || process.env.PORT_DB || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`API escuchando en el puerto ${port}`);
});
