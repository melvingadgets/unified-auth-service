import express, { type Application } from "express";
import "./Database/Database.js";
import Db from "./Database/Database.js";
import { MainApp } from "./MainApp.js";
import { config } from "./config/Config.js";
import { isMailConfigured } from "./Utils/authHelpers.js";
import type { Server } from "http";

const app: Application = express();
MainApp(app);

let server: Server;

const startServer = async () => {
  try {
    await Db;
    server = app.listen(config.port, () => {
      console.log(`auth service listening on port: ${config.port}`);
      // Say it at boot, not on a customer's first sign-up: with mail unconfigured, registration
      // verifies accounts immediately instead of emailing. No secrets — the word only.
      console.log(`mail transport: ${isMailConfigured() ? "configured" : "NOT configured (accounts verify immediately)"}`);
    });
  } catch (_error) {
    console.log("Auth service failed to start");
  }
};

startServer();

process.on("uncaughtException", () => {
  process.exit(1);
});

process.on("unhandledRejection", () => {
  server?.close(() => {
    process.exit(1);
  });
});
