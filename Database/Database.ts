import mongoose from "mongoose";
import { config } from "../config/Config.js";

const Db = mongoose.connect(config.databaseUrl);

Db.then(() => {
  console.log("Auth service database connected");
}).catch((error: unknown) => {
  console.log(error, "Auth service database connection failed");
});

export default Db;
