import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

import { firebaseConfig } from '../config/firebase-config.js';

// Initialize Firebase with the config (API key will be handled separately)
const configWithApiKey = {
  ...firebaseConfig,
  apiKey: "placeholder" // This will be updated programmatically
};

const app = initializeApp(configWithApiKey);
export const db = getFirestore(app);
export const auth = getAuth(app);

console.log("Firebase initialized!"); 