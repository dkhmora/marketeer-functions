const functions = require("firebase-functions");

const FB_CONFIG =
  functions.config().app && functions.config().app.env === "dev"
    ? {
        apiKey: "AIzaSyDe4l8VbYCVKTj9EvosEbVI8RPbJplHMKw",
        authDomain: "marketeerph-development.firebaseapp.com",
        databaseURL: "https://marketeerph-development.firebaseio.com",
        projectId: "marketeerph-development",
        storageBucket: "marketeerph-development.appspot.com",
        messagingSenderId: "1053004746180",
        appId: "1:1053004746180:web:bf49e8f7d8c911a1996891",
        measurementId: "G-V3M0SZBCT5",
      }
    : functions.config().app && functions.config().app.env === "staging"
    ? {
        apiKey: "AIzaSyBbd9EjhIpmZX8BhhmDaYEZviiIuy2imSw",
        authDomain: "marketeerph-staging.firebaseapp.com",
        databaseURL: "https://marketeerph-staging.firebaseio.com",
        projectId: "marketeerph-staging",
        storageBucket: "marketeerph-staging.appspot.com",
        messagingSenderId: "665160952517",
        appId: "1:665160952517:web:8512aaf775e5c468c1deac",
      }
    : {
        apiKey: "AIzaSyDJGaz3oyU5fk6YCMkjq4J8dJf7wYdjPEU",
        authDomain: "marketeerph-b9653.firebaseapp.com",
        databaseURL: "https://marketeerph-b9653.firebaseio.com",
        projectId: "marketeerph-b9653",
        storageBucket: "marketeerph-b9653.appspot.com",
        messagingSenderId: "1549607298",
        appId: "1:1549607298:web:6c89ac3336788f1c09af9b",
        measurementId: "G-TPT832ZP29",
      };

const HERE_API_KEY = "f7ZVIc7xzH55fKz95GmDEgVEQkZ0a7vlHEkU3vHeFCM";

const DEV_MODE =
  (functions.config().app && functions.config().app.env === "dev") ||
  (functions.config().app && functions.config().app.env === "staging");

const SECRET_PROJECT_ID = DEV_MODE ? "1053004746180" : "1549607298";

const functionsRegionHttps = functions.region("asia-northeast1").https;

module.exports = {
  FB_CONFIG,
  HERE_API_KEY,
  SECRET_PROJECT_ID,
  DEV_MODE,
  functionsRegionHttps,
};
