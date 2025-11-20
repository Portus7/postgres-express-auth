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
async function saveAgency(locationId, tokenData) {
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

// 🔎 helper para traer locations donde la app está instalada
async function getInstalledLocations(tokens) {
  try {
    const res = await axios.get(
      "https://services.leadconnectorhq.com/oauth/installedLocations",
      {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
        params: {
          companyId: tokens.companyId,
          isInstalled: true,
          // appId: process.env.GHL_APP_ID, // opcional si quieres filtrar por ID de app
          limit: 50,
        },
        timeout: 15000,
      }
    );

    console.log("📍 installedLocations:", res.data);
    return res.data?.locations || [];
  } catch (e) {
    console.error(
      "❌ Error llamando /oauth/installedLocations:",
      e.response?.status,
      e.response?.data || e.message
    );
    return [];
  }
}


// -------- ruta de callback OAuth (única) --------
// -------- ruta de callback OAuth (única) --------
app.get("/oauth/callback", async (req, res) => {
  const { code, locationId: locationIdFromQuery } = req.query;

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
    console.log("tokens el total", tokenRes)
    const tokens = tokenRes.data;
    console.log("🔐 Tokens recibidos (resumido):", {
      userType: tokens.userType,
      companyId: tokens.companyId,
      scopes: tokens.scope,
    });

    // 2) Resolver locationId (query -> tokens -> installedLocations)
    let locationId =
      locationIdFromQuery || tokens.locationId || null;

    if (!locationId && tokens.userType === "Company") {
      console.log("ℹ️ No llegó locationId en query ni en token. Consultando /oauth/installedLocations...");
      const locations = await getInstalledLocations(tokens);

      if (locations.length > 0) {
        // 👇 aquí decides cuál usar (primera, o filtrar por nombre, etc.)
        locationId = locations[0].id;
        console.log("📍 Usando locationId desde installedLocations:", locationId);
      } else {
        console.warn("⚠️ No se encontraron locations instaladas para esta app.");
      }
    }

    if (!locationId) {
      console.warn(
        "⚠️ Aun sin locationId después de todo. No se podrá crear custom menu limitado."
      );
    }

    // 3) Guarda tokens con ese locationId (aunque sea null o 'agency')
    if (locationId) {
      await saveAgency(locationId, tokens);
    }

    // 4) Crear Custom Menu SOLO para la Location que resolvimos
    try {
      let agencyAuth = null;
      if (tokens.userType === "Company") {
        agencyAuth = tokens.access_token;
      } else if (process.env.GHL_PIT) {
        agencyAuth = process.env.GHL_PIT;
      }

      if (!agencyAuth) {
        console.warn("No hay token de agencia ni PIT; omito crear Custom Menu.");
      } else if (!locationId) {
        console.warn("No hay locationId; creo Custom Menu general o ninguno.");
        // Podrías crear un menú global showToAllLocations: true si quieres
      } else {
        const bodyMenu = {
          title: "WhatsApp Bridge",
          url: process.env.CUSTOM_MENU_URL || "https://tu-front-o-panel.com/",
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

    // 5) (Opcional) Token de Location
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
        console.error(
          "❌ Error obteniendo token de Location:",
          e.response?.status,
          e.response?.data || e.message
        );
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
