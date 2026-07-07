const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`
    export const firebaseConfig = {
      apiKey: "${process.env.FIREBASE_API_KEY || ''}",
      authDomain: "${process.env.FIREBASE_AUTH_DOMAIN || ''}",
      projectId: "${process.env.FIREBASE_PROJECT_ID || ''}",
      storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET || ''}",
      messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID || ''}",
      appId: "${process.env.FIREBASE_APP_ID || ''}",
      measurementId: "${process.env.FIREBASE_MEASUREMENT_ID || ''}"
    };
    export const CLOUDINARY_URL = "${process.env.CLOUDINARY_URL || ''}";
    export const CLOUDINARY_PRESET = "${process.env.CLOUDINARY_PRESET || ''}";
  `);
});

app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
