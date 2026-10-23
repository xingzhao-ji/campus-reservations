import { database, type Database } from "../src/db.js";
import { embeddedDatabase } from "../src/embedded.js";
import { resolve } from "node:path";
export const embedded = !process.env.TEST_DATABASE_URL;
export function openTestDatabase(): Database {
  return embedded
    ? embeddedDatabase(resolve(".test-db"))
    : database(process.env.TEST_DATABASE_URL);
}
