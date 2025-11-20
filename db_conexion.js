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

// Tabla esperada:
// CREATE TABLE IF NOT EXISTS auth_db (
//   locationid TEXT PRIMARY KEY,
//   raw_token  JSONB NOT NULL
// );

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
// Intercambia code -> ACCESS TOKEN de AGENCY (Company)
// y lo guarda en la fila especial "__AGENCY__"
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
