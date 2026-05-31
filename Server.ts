import express, { type Application } from "express";
import "./Database/Database.js";
import Db from "./Database/Database.js";
import { MainApp } from "./MainApp.js";
import { config } from "./config/Config.js";
import type { Server } from "http";

const app: Application = express();
MainApp(app);

let server: Server;

const startServer = async () => {
  try {
    await Db;
    server = app.listen(config.port, () => {
      console.log(`auth service listening on port: ${config.port}`);
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
