// src/index.js
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

const AGENCY_ROW_ID = "__AGENCY__";
// Asegúrate de que esta URL apunte a tu Frontend (donde está el Dashboard)
const FRONTEND_URL = process.env.FRONTEND_URL || "https://clicandapp-frontend-web-wa.aqdlt2.easypanel.host";

// ─────────────────────────────
// Helpers BD
// ─────────────────────────────
async function saveTokens(locationId, tokenData) {
  console.log("👉 Guardando en BD. ID:", locationId);
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
// OAuth CALLBACK (La Magia ocurre aquí)
// ─────────────────────────────
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
      user_type: "Company", // Mantenemos Company como solicitaste
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

    // Extraemos IDs para saber qué tipo de instalación es
    const locationId = tokens.locationId;
    const companyId = tokens.companyId;

    // CASO 1: Instalación en una Subcuenta (Location)
    // Esto pasa cuando el usuario elige una subcuenta específica en el popup de GHL
    if (locationId) {
      await saveTokens(locationId, tokens);
      console.log(`✅ Subcuenta instalada: ${locationId}`);

      // Redirigimos al Frontend con el ID para la auto-vinculación
      //return res.redirect(`${FRONTEND_URL}/?new_install=${locationId}`);
    }

    // CASO 2: Instalación a nivel Agencia (Company)
    // Esto actualiza el token maestro de la agencia
    if (companyId) {
      await saveTokens(AGENCY_ROW_ID, tokens);
      console.log(`✅ Agencia instalada/actualizada: ${companyId}`);

      return res.redirect(`${FRONTEND_URL}/?msg=agency_installed&new_install=${companyId}`);
    }

    // Si llegamos aquí, algo raro pasó con la respuesta de GHL
    console.warn("⚠️ Token recibido sin locationId ni companyId claro:", tokens);
    return res.redirect(`${FRONTEND_URL}/?error=unknown_install_type`);

  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("❌ Error en /oauth/callback:", status, JSON.stringify(data));
    return res.status(status).json({ ok: false, error: data });
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
  console.log(`API OAuth escuchando en el puerto ${port}`);
});