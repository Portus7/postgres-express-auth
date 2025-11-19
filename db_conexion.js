const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

// Pool de conexión a Postgres
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
});

app.post('/ghl/webhook', (req, res) => {
  // aquí procesas el JSON que envía GoHighLevel
  // ejemplo: extraer from, to, message, etc.
  console.log('Mensaje entrante desde GHL:', req.body);

  // devolver 200 para que GHL sepa que todo OK
  res.status(200).json({ received: true });
});

// -------- helper para guardar en tu tabla actual --------
async function saveAgency(locationIdFromReq, tokenData) {
  // si no te llega locationId en la query, pruebo con el que venga en el token (a veces viene cuando el userType es Location)
  const locationId = locationIdFromReq || tokenData.locationId || null;

  // IMPORTANTE: la columna tokenres debe ser JSONB en Postgres
  const sql = `
    INSERT INTO auth_db (locationid, raw_token)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (locationid) DO UPDATE
    SET raw_token = EXCLUDED.raw_token
  `;

  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
  return locationId;
}

// -------- ruta de callback OAuth --------
app.get("/oauth/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send("Falta el parámetro 'code' en la URL de callback.");
  }

  try {
    // Intercambio del code por tokens (form-urlencoded recomendado)
    const body = new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      // Según docs, cuando instala Agencia suele usarse user_type=Company (token de agencia)
      // Si la instalación es directamente en Sub-cuenta, el response vendrá con userType=Location
      user_type: "Company",
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

    const tokens = tokenRes.data; // { access_token, refresh_token, expires_in, scope, userType, companyId, ... }
    console.log(tokens)
    // Guardado base (tu esquema actual)
    const locationId = await saveAgency(req.query.locationId, tokens);

    // (OPCIONAL) Si te dieron token de Agencia y ya conoces locationId,
    // intercámbialo por token de Sub-cuenta para operar a nivel Location.
    if (tokens.userType === "Company" && locationId) {
      const locParams = new URLSearchParams({
        companyId: tokens.companyId,
        locationId,
      });

      const locTokenRes = await axios.post(
        "https://services.leadconnectorhq.com/oauth/locationToken",
        locParams.toString(),
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Bearer ${tokens.access_token}`, // token de agencia
            Version: "2021-07-28", // requerido por este endpoint
          },
          timeout: 15000,
        }
      );

      const locationTokens = locTokenRes.data; // userType: "Location"
      // guarda ambos en la misma fila por simplicidad
      await saveAgency(locationId, { ...tokens, locationAccess: locationTokens });
    }

    // No devuelvas tokens al navegador por seguridad

    return res.send("¡App instalada correctamente! Las credenciales se guardaron en la base de datos.");
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("Error en /oauth/callback:", status, data);
    return res.status(status).json({
      ok: false,
      error: data,
    });
  }
});


// Ruta de prueba de conexión
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      ok: true,
      dbTime: result.rows[0].now,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/auth_db', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM auth_db');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/insert_auth', async (req, res) => {
  const { locationid, tokenres } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO auth_db (locationid, token_raw) VALUES ($1, $2) RETURNING *',
      [locationid, tokenres]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const locationId = req.query.locationId;

  const tokenRes = await axios.post(
    "https://services.leadconnectorhq.com/oauth/token",
    {
      client_id: YOUR_CLIENT_ID,
      client_secret: YOUR_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://express.clicandapp.com/oauth/callback"
    }
  );
  // guardar tokens en DB
  saveAgency(locationId, tokenRes.data);

  // Generar el boton personalizado
  try {
  const agencyToken = tokens.access_token; // <- token de AGENCIA
  const bodyMenu = {
    title: "Custom Menu",
    url: "https://custom-menus.com/",
    icon: { name: "yin-yang", fontFamily: "fab" },

    showOnCompany: true,
    showOnLocation: true,

    // Opción A: visible para TODAS las subcuentas (no envíes 'locations')
    showToAllLocations: true,
    openMode: "iframe",
    userRole: "all",
    allowCamera: false,
    allowMicrophone: false,
  };

  // // Opción B: solo para ubicaciones específicas
  // bodyMenu.showToAllLocations = false;
  // bodyMenu.locations = [locationId]; // usa el que guardaste/recibiste

  const createMenuRes = await axios.post(
    "https://services.leadconnectorhq.com/custom-menus/",
    bodyMenu,
    {
      headers: {
        Authorization: `Bearer ${agencyToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-07-28",
      },
      timeout: 15000,
    }
  );

  console.log("✅ Custom Menu creado:", createMenuRes.data);
} catch (e) {
  console.error("❌ Error creando Custom Menu:", e.response?.status, e.response?.data || e.message);
  // No detengas la instalación por esto; solo loguea
}

  res.send(`App instalada correctamente! a la subagencia con locationid=${locationId}, tokengenerado=${tokenRes.data}`);
});


const port = process.env.PORT_DB || 3000;
app.listen(port, () => {
  console.log(`API escuchando en el puerto ${port}`);
});
