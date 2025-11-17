# Imagen base de Node
FROM node:18-alpine

# Directorio de trabajo dentro del contenedor
WORKDIR /

# Copiamos solo package.json (y package-lock si existe) para aprovechar la cache
COPY package*.json ./

# Instalamos dependencias
RUN npm install --only=production

# Copiamos el resto del código
COPY . .

# Variables de entorno por defecto dentro del contenedor
# (las de Easypanel las sobreescriben)
ENV NODE_ENV=production \
    PORT_DB=3000

# Puerto en el que escucha tu app dentro del contenedor
EXPOSE 3000

# Comando para arrancar tu backend
CMD ["node", "index.js"]
