# Creami Knowledge Engine

Aplicacion full-stack (React + Express + Vite) para indexar videos de YouTube y consultar recetas con Gemini.

Este proyecto esta configurado en modo **single-user local** (sin login Google).

## Ejecutar en Cursor Agent/API (local)

Prerequisitos:
- Node.js 20+
- Una clave de Gemini (`GEMINI_API_KEY`)

Pasos:
1. Instala dependencias:
   `npm install`
2. Crea tu entorno local desde el ejemplo:
   `cp .env.example .env.local`
3. Edita `.env.local` y define al menos:
   - `GEMINI_API_KEY`
   - (Opcional) `PORT` y `HOST`
4. Inicia en modo desarrollo:
   `npm run dev`

La app queda disponible en `http://localhost:3000` por defecto.

## Configurar Firebase (sin Auth)

1. Crea un proyecto en Firebase Console.
2. Habilita **Firestore Database** (modo produccion o test, segun prefieras).
3. Crea una app Web en Firebase y copia su configuracion.
4. Reemplaza los valores de `firebase-applet-config.json` con los de tu proyecto:
   - `projectId`
   - `appId`
   - `apiKey`
   - `authDomain`
   - `storageBucket`
   - `messagingSenderId`
   - `firestoreDatabaseId` (si usas una DB nombrada)
5. Publica las reglas de `firestore.rules` en Firestore Rules.

Notas:
- En este modo no se usa Firebase Authentication.
- El frontend guarda todo bajo el usuario fijo `local-user`.

## Scripts utiles

- `npm run dev`: servidor Express + middleware de Vite para desarrollo.
- `npm run dev:cursor`: variante explicita para agentes/entornos headless en Cursor.
- `npm run lint`: chequeo de tipos TypeScript.
- `npm run build`: build de frontend para produccion.
- `npm start`: arranque del servidor usando `tsx`.

## Proveedor LLM intercambiable

El proyecto usa `src/services/llm.ts` y permite cambiar proveedor por variable de entorno.

- `LLM_PROVIDER="gemini"` (default):
  - Requiere `GEMINI_API_KEY`
  - Opcional `GEMINI_MODEL` (default `gemini-2.5-flash`)
- `LLM_PROVIDER="cursor"`:
  - Requiere `CURSOR_API_KEY`
  - Opcional `CURSOR_API_BASE_URL` (default `https://api.cursor.com/v1`)
  - Opcional `CURSOR_MODEL` (default `gpt-4.1`)
  - Si usas Cursor Cloud Agents API (`api.cursor.com`), tambien requiere:
    - `CURSOR_AGENT_REPO_URL` (URL GitHub del repo accesible por Cursor)
    - `CURSOR_AGENT_STARTING_REF` (branch inicial, por ejemplo `main`)

El switch no requiere cambios en UI ni en llamadas de negocio (`extractRecipeFromTranscript` y `queryRecipes`).
