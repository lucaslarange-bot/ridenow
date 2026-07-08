/**
 * Build step Vercel : génère config.js à partir de la variable d'environnement
 * RIDENOW_BACKEND (définie dans Vercel → Settings → Environment Variables).
 * En local, si la variable est absente, config.js reste vide (le serveur Node
 * sert le front en même origine sur http://localhost:3000).
 */
const fs = require('fs');
const path = require('path');
const url = (process.env.RIDENOW_BACKEND || '').trim();
const out = `// Généré automatiquement au build (ne pas éditer à la main sur Vercel).
// Source : variable d'environnement RIDENOW_BACKEND.
window.RIDENOW_BACKEND = ${JSON.stringify(url)};
`;
fs.writeFileSync(path.join(__dirname, 'config.js'), out);
console.log('[build] config.js -> ' + (url || '(vide : dev local / même origine)'));
