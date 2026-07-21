const fs = require('fs');
const path = require('path');

const required = [
  'src/server.js',
  'public/index.html',
  'public/admin.html',
  'public/admin.js',
  'public/app.js',
  'config/app.config.json'
];

for (const file of required) {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config/app.config.json'), 'utf8'));
require('../src/server');
console.log('Build validation passed');
