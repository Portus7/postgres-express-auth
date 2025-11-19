const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
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
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
});

// Webhook (placeholder)
//app.post("/ghl/webhook", (req, res) => {
//  console.log("Mensaje entrante desde GHL:", req.body);
//  res.status(200).json({ received: true });
//});

// -------- helper para guardar en tu tabla actual --------
async function saveAgency(locationIdFromReq, tokenData) {
  console.log("location:      ", locationIdFromReq, "token:      ", tokenData )
  const locationId = locationIdFromReq || tokenData.locationId || null;

  const sql = `
    INSERT INTO auth_db (locationid, raw_token)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (locationid) DO UPDATE
    SET raw_token = EXCLUDED.raw_token
  `;
  await pool.query(sql, [locationId, JSON.stringify(tokenData)]);
  return locationId;
}

// -------- ruta de callback OAuth (única) --------
app.get("/oauth/callback", async (req, res) => {
  const { code, locationId: locationIdFromQuery } = req.query;
  console.log("Respuesta: ", req)
  if (!code) {
    return res.status(400).send("Falta el parámetro 'code' en la URL de callback.");
  }

  try {
    // 1) Intercambio code -> tokens (usa token de AGENCIA)
    const body = new URLSearchParams({
      client_id: process.env.GHL_CLIENT_ID,
      client_secret: process.env.GHL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
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

    const tokens = tokenRes.data; // { access_token, userType, companyId, ... }
    // console.log(tokens); // ⚠️ No loguees tokens en prod

    // 2) Guarda tokens
    const locationId = await saveAgency(locationIdFromQuery, tokens);

    // 3) Crear Custom Menu SOLO para la Location que instaló
    try {
      // Usa token de Agencia (del OAuth) o un PIT de respaldo
      let agencyAuth = null;
      if (tokens.userType === "Company") {
        agencyAuth = tokens.access_token; // token de agencia
      } else if (process.env.GHL_PIT) {
        agencyAuth = process.env.GHL_PIT; // fallback si el OAuth devolvió Location
      }

      if (!agencyAuth) {
        console.warn("No hay token de agencia ni PIT; omito crear Custom Menu.");
      } else if (!locationId) {
        console.warn("No llegó locationId; no puedo limitar el menú a una subcuenta.");
      } else {
        const bodyMenu = {
          title: "Custom Menu",
          url: "https://custom-menus.com/", 
          icon: { name: "yin-yang", fontFamily: "fab" },

          showOnCompany: true,
          showOnLocation: true,

          // 🔒 SOLO la Location específica
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
              Authorization: `Bearer ${agencyAuth}`,
              Version: "2021-07-28",
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            timeout: 15000,
          }
        );

        console.log("✅ Custom Menu creado:", createMenuRes.data);
      }
    } catch (e) {
      console.error(
        "❌ Error creando Custom Menu:",
        e.response?.status,
        e.response?.data || e.message
      );
    }

    // 4) (Opcional) Si necesitas token de la Location para operar endpoints de subcuenta:
    if (tokens.userType === "Company" && locationId) {
      try {
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
              Authorization: `Bearer ${tokens.access_token}`,
              Version: "2021-07-28",
            },
            timeout: 15000,
          }
        );

        const locationTokens = locTokenRes.data; // userType: "Location"
        await saveAgency(locationId, { ...tokens, locationAccess: locationTokens });
      } catch (e) {
        console.error("❌ Error obteniendo token de Location:", e.response?.status, e.response?.data || e.message);
      }
    }

    return res.send("¡App instalada correctamente! Las credenciales se guardaron en la base de datos.");
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || err.message;
    console.error("Error en /oauth/callback:", status, data);
    return res.status(status).json({ ok: false, error: data });
  }
});

// Ruta de prueba de conexión
app.get("/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ ok: true, dbTime: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Solo para debug (mantén consistencia de columnas)
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

const port = Number(process.env.PORT || process.env.PORT_DB || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`API escuchando en el puerto ${port}`);
});
